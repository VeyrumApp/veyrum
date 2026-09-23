import fs from 'node:fs'
import { Session } from 'node:inspector/promises'
import module from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { threadId } from 'node:worker_threads'
import { digest } from '@veyrum/core/hash'
import { isInside } from '@veyrum/core/paths'
import { hashEnvValue } from '@veyrum/core/state'
import {
  type EnvScope,
  getSink,
  type HookSink,
  installHooks,
  type PathKind,
  type PathType,
  type Reader,
  setSink,
  unobserved,
} from './hooks.ts'
import { packageRootOf } from './main.ts'
import type { PayloadModule, WorkerPayload } from './payload.ts'

export type { WorkerPayload } from './payload.ts'

export interface WorkerCaptureOptions {
  /** Absolute repository root. */
  readonly root: string
  /** Directory receiving payloads (payloads/) and module code (blobs/). */
  readonly outDir: string
  /** Absolute path prefixes never recorded (the capture layer's own files). */
  readonly ignoredPrefixes: readonly string[]
  /** Environment variable names never recorded (values differ on every run). */
  readonly volatileEnv: RegExp
  /**
   * How the runner evaluates modules:
   * - 'vitest': a fresh isolate per file; every repository module is wrapped by Vite's evaluator;
   * - 'jest': an isolate is reused across files but modules are re-evaluated per file with
   *   vm.compileFunction (no wrapper), so a file's modules are the scripts executed during it.
   */
  readonly layout?: 'vitest' | 'jest'
}

/** The prefix Vitest wraps every transformed module in; offsets are shifted by its length. */
const WRAPPER_START = "'use strict';async ("
const WRAPPER_OPEN = ')=>{{'
const WRAPPER_CLOSE = '\n}}'

interface IsolateState {
  session: Session | null
  files: number
  /** Jest layout: sources compiled through node:vm during the current file, by filename. */
  compiled: Map<string, string[]> | null
  /** Jest layout: manifests of packages loaded natively by this process (the toolchain). */
  toolchain: Set<string>
  /** Jest layout: files outside node_modules loaded natively (local transformers and plugins). */
  toolchainFiles: Set<string>
  toolchainObserved: boolean
}

/** Stack frames of Jest's module loader (its file cache reads each module before compiling it). */
const JEST_RUNTIME_FRAME = /[\\/]jest-runtime[\\/]build[\\/]/

/** Jest 29 wraps CommonJS modules in this (Jest 30 uses vm.compileFunction without a wrapper). */
const JEST29_WRAPPER_START = '({"Object.<anonymous>":function('
const JEST29_WRAPPER_OPEN = '){'
const JEST29_WRAPPER_CLOSE = '\n}});'

/** The module code inside a script Jest compiled, and its offset in the script. */
function jestModuleCode(source: string): { code: string; offset: number } {
  if (source.startsWith(JEST29_WRAPPER_START) && source.endsWith(JEST29_WRAPPER_CLOSE)) {
    const open = source.indexOf(JEST29_WRAPPER_OPEN, JEST29_WRAPPER_START.length)
    if (open > 0) {
      const offset = open + JEST29_WRAPPER_OPEN.length
      return { code: source.slice(offset, source.length - JEST29_WRAPPER_CLOSE.length), offset }
    }
  }
  return { code: source, offset: 0 }
}

/**
 * Records the source of every script compiled through node:vm, keyed by filename. Jest compiles
 * each module per test file this way, so this replaces asking the Debugger for script sources.
 */
function installCompileHooks(compiled: () => Map<string, string[]> | null): void {
  const note = (filename: unknown, source: unknown): void => {
    const map = compiled()
    if (!map || typeof filename !== 'string' || typeof source !== 'string') return
    const list = map.get(filename)
    if (list) list.push(source)
    else map.set(filename, [source])
  }
  const mutableVm = vm as unknown as Record<string, unknown>
  const originalCompile = vm.compileFunction
  mutableVm.compileFunction = (
    code: string,
    params?: readonly string[],
    options?: vm.CompileFunctionOptions,
  ) => {
    note(options?.filename, code)
    return originalCompile(code, params, options)
  }
  const OriginalScript = vm.Script
  mutableVm.Script = class extends OriginalScript {
    constructor(code: string, options?: vm.ScriptOptions | string) {
      super(code, options as vm.ScriptOptions)
      note(typeof options === 'string' ? options : options?.filename, code)
    }
  }
  const OriginalModule = (
    vm as unknown as { SourceTextModule?: new (code: string, options?: { identifier?: string }) => object }
  ).SourceTextModule
  if (OriginalModule) {
    mutableVm.SourceTextModule = class extends OriginalModule {
      constructor(code: string, options?: { identifier?: string }) {
        super(code, options)
        note(options?.identifier, code)
      }
    }
  }
}

const ISOLATE_KEY = Symbol.for('veyrum.capture.isolate')

class FileRecorder implements HookSink {
  readonly paths = new Map<string, { p: string; kind: PathKind; type: PathType }>()
  /** Files the runner read to load as modules; kept only if they were not compiled (JSON, assets). */
  readonly runnerReads = new Map<string, PathType>()
  readonly writes = new Set<string>()
  readonly envReads = new Map<string, string | null>()
  /** Jest layout: reads of the worker's own environment, made by the runner and its toolchain. */
  readonly toolchainEnv = new Map<string, string | null>()
  readonly envWritten = new Set<string>()
  envEnumeratedFlag = false
  readonly netEvents = new Map<string, { host: string; port: number | null; local: boolean }>()
  readonly spawns = new Set<string>()
  readonly dlopens = new Set<string>()
  sourceObservedFlag = false
  private readonly volatileEnv: RegExp
  /** Under the Jest layout, tests read their context's copy of the environment, never the process's. */
  private readonly testScopeOnly: boolean

  constructor(volatileEnv: RegExp, testScopeOnly: boolean) {
    this.volatileEnv = volatileEnv
    this.testScopeOnly = testScopeOnly
  }

  path(absolute: string, kind: PathKind, type: PathType, reader: Reader): void {
    // Reads of files this check wrote itself derive from its own code and are not inputs.
    if (this.writes.has(absolute)) return
    // Under Jest, Node's own loader only loads the toolchain (test code loads through Jest's
    // runtime); what it loads is recorded as shared toolchain inputs.
    if (reader === 'node-loader') return
    if (reader === 'runner') {
      if (!this.runnerReads.has(absolute)) this.runnerReads.set(absolute, type)
      return
    }
    const key = `${kind}\u0000${absolute}`
    if (!this.paths.has(key)) this.paths.set(key, { p: absolute, kind, type })
  }
  write(absolute: string): void {
    this.writes.add(absolute)
  }
  env(name: string, value: string | undefined, _copying: boolean, scope: EnvScope): void {
    if (this.envWritten.has(name) || this.volatileEnv.test(name)) return
    const into = this.testScopeOnly && scope === 'process' ? this.toolchainEnv : this.envReads
    if (!into.has(name)) into.set(name, hashEnvValue(value))
  }
  envEnumerated(scope: EnvScope): void {
    if (this.testScopeOnly && scope === 'process') return
    this.envEnumeratedFlag = true
  }
  envWrite(name: string): void {
    this.envWritten.add(name)
  }
  net(host: string, port: number | undefined, local: boolean): void {
    this.netEvents.set(`${host}:${port ?? ''}`, { host, port: port ?? null, local })
  }
  spawn(command: string): void {
    this.spawns.add(command)
  }
  dlopen(absolute: string): void {
    this.dlopens.add(absolute)
  }
  sourceObserved(): void {
    this.sourceObservedFlag = true
  }
}

/**
 * Returns the code strings a runner evaluated for a file (a file can be evaluated more than once).
 * Reading them from the runner avoids the Debugger domain, which slows execution noticeably.
 */
export type ModuleSources = (absolutePath: string) => readonly string[] | undefined

export interface WorkerCapture {
  /** Collects coverage and writes the payload for the test file that just ran. */
  finish(
    testFile: string,
    snapshot: { added: number; updated: number },
    sources?: ModuleSources,
  ): Promise<void>
}

/**
 * Starts capturing for one test file. Must run before the test file is imported, so that
 * module top levels executed during import are covered.
 */
/**
 * Installs the I/O hooks for this isolate (once). beginWorkerCapture does this itself; runners that
 * construct per-file state before capture begins (Jest copies `process` into each test context)
 * call it first, so that state is created from the hooked objects.
 */
export function prepareWorkerHooks(options: WorkerCaptureOptions): void {
  const g = globalThis as unknown as Record<symbol, IsolateState | undefined>
  if (g[ISOLATE_KEY]) return
  installHooks({
    root: options.root,
    ignoredPrefixes: [...options.ignoredPrefixes, path.resolve(options.outDir) + path.sep],
    observeSource: true,
    ...(options.layout === 'jest' ? { runnerReaders: [JEST_RUNTIME_FRAME] } : {}),
  })
  const isolate: IsolateState = {
    session: null,
    files: 0,
    compiled: null,
    toolchain: new Set(),
    toolchainFiles: new Set(),
    toolchainObserved: true,
  }
  g[ISOLATE_KEY] = isolate
  if (options.layout === 'jest') {
    installCompileHooks(() => isolate.compiled)
    isolate.toolchainObserved = recordToolchain(isolate.toolchain, isolate.toolchainFiles)
  }
}

/** Records what this process loads through Node's own loader: package manifests and local files. */
function recordToolchain(into: Set<string>, files: Set<string>): boolean {
  const register = (module as unknown as { registerHooks?: (hooks: object) => unknown }).registerHooks
  if (!register) return false
  register({
    load: (url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown) => {
      if (url.startsWith('file:')) {
        const file = fileURLToPath(url)
        const root = packageRootOf(file)
        if (root) into.add(path.join(root, 'package.json'))
        else files.add(file)
      }
      return nextLoad(url, context)
    },
  })
  return true
}

export async function beginWorkerCapture(options: WorkerCaptureOptions): Promise<WorkerCapture> {
  const errors: string[] = []
  prepareWorkerHooks(options)
  const isolate = (globalThis as unknown as Record<symbol, IsolateState>)[ISOLATE_KEY]!
  if (!isolate.session) {
    // A second file in the same isolate (isolation off) gets a fresh session, but modules cached
    // by earlier files will not re-execute, so its payload is marked as coming from a reused isolate.
    const fresh = new Session()
    fresh.connect()
    await fresh.post('Profiler.enable')
    await fresh.post('Profiler.startPreciseCoverage', { callCount: false, detailed: false })
    isolate.session = fresh
  }
  isolate.files++
  const reused = isolate.files > 1
  const envBaseline = unobserved(() => {
    const out: Record<string, string | null> = {}
    for (const [n, v] of Object.entries(process.env))
      if (!options.volatileEnv.test(n)) out[n] = hashEnvValue(v)
    return out
  })
  const layout = options.layout ?? 'vitest'
  const recorder = new FileRecorder(options.volatileEnv, layout === 'jest')
  if (layout === 'jest') isolate.compiled = new Map()
  const compiled = isolate.compiled
  // Restored at finish: tests can run inside the runner's main process, whose recorder is active.
  const outerSink = getSink()
  setSink(recorder)
  const session = isolate.session
  const state = isolate

  return {
    async finish(testFile, snapshot, sources) {
      let debuggerEnabled = false
      /** The executed module code and its offset inside the script, or null if not a wrapped module. */
      const moduleCode = async (
        absolute: string,
        scriptId: string,
        scriptLength: number,
      ): Promise<{ code: string; offset: number } | null> => {
        // The script is WRAPPER_START + args + WRAPPER_OPEN + code + WRAPPER_CLOSE.
        for (const code of sources?.(absolute) ?? []) {
          const offset = scriptLength - WRAPPER_CLOSE.length - code.length
          if (offset > WRAPPER_START.length + WRAPPER_OPEN.length) return { code, offset }
        }
        if (!debuggerEnabled) {
          await session.post('Debugger.enable')
          debuggerEnabled = true
        }
        const source = (
          (await session.post('Debugger.getScriptSource', { scriptId })) as { scriptSource: string }
        ).scriptSource
        const open = source.startsWith(WRAPPER_START) ? source.indexOf(WRAPPER_OPEN) : -1
        if (open < 0 || !source.endsWith(WRAPPER_CLOSE)) return null
        const offset = open + WRAPPER_OPEN.length
        return { code: source.slice(offset, source.length - WRAPPER_CLOSE.length), offset }
      }
      /** The module code of a script Jest compiled: recorded at compile time, else from the Debugger. */
      const jestCode = async (
        absolute: string,
        scriptId: string,
        scriptLength: number,
      ): Promise<{ code: string; offset: number }> => {
        for (const source of compiled?.get(absolute) ?? [])
          if (source.length === scriptLength) return jestModuleCode(source)
        if (!debuggerEnabled) {
          await session.post('Debugger.enable')
          debuggerEnabled = true
        }
        const source = (
          (await session.post('Debugger.getScriptSource', { scriptId })) as { scriptSource: string }
        ).scriptSource
        return jestModuleCode(source)
      }
      setSink(outerSink)
      state.compiled = null
      if (!state.toolchainObserved) errors.push('module loads cannot be observed (Node lacks module.registerHooks)')
      const modules: PayloadModule[] = []
      const natives = new Set<string>()
      let evalScripts = 0
      try {
        const coverage = (await session.post('Profiler.takePreciseCoverage')) as {
          result: {
            scriptId: string
            url: string
            functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[]
          }[]
        }
        const blobDir = path.join(options.outDir, 'blobs')
        unobserved(() => fs.mkdirSync(blobDir, { recursive: true }))
        const byKey = new Map<
          string,
          { path: string; code: string; executed: Map<string, [number, number]> }
        >()
        for (const script of coverage.result) {
          const url = script.url
          if (url === '') {
            if (script.functions.some((f) => (f.ranges[0]?.count ?? 0) > 0)) evalScripts++
            continue
          }
          if (!url.startsWith('file://') && !url.startsWith('/')) continue
          const absolute = url.startsWith('file://') ? fileURLToPath(url) : url
          if (options.ignoredPrefixes.some((p) => absolute.startsWith(p))) continue
          const executed = script.functions.some((f) => (f.ranges[0]?.count ?? 0) > 0)
          // Jest keeps earlier files' scripts in the isolate; only those that ran now belong to this
          // file. Scripts Jest did not compile into the test context during this file are the runner
          // and its toolchain (transformers), recorded as shared inputs instead.
          if (layout === 'jest' && (!executed || !compiled?.has(absolute))) continue
          if (!isInside(options.root, absolute) || absolute.includes(`${path.sep}node_modules${path.sep}`)) {
            natives.add(absolute)
            continue
          }
          const scriptLength = Math.max(0, ...script.functions.map((f) => f.ranges[0]?.endOffset ?? 0))
          const found =
            layout === 'jest'
              ? await jestCode(absolute, script.scriptId, scriptLength)
              : await moduleCode(absolute, script.scriptId, scriptLength)
          if (!found) {
            natives.add(absolute)
            continue
          }
          const { code, offset } = found
          const codeDigest = digest(code)
          const blob = path.join(blobDir, `${codeDigest}.js`)
          unobserved(() => {
            if (!fs.existsSync(blob)) fs.writeFileSync(blob, code)
          })
          const key = `${absolute}\u0000${codeDigest}`
          let mod = byKey.get(key)
          if (!mod) {
            mod = { path: absolute, code: codeDigest, executed: new Map() }
            byKey.set(key, mod)
          }
          for (const fn of script.functions) {
            const range = fn.ranges[0]
            if (!range || range.count === 0) continue
            const start = range.startOffset - offset
            const end = range.endOffset - offset
            // The script function and any wrapper extend past or span the module code: they are the
            // top level, which is always recorded.
            if (start < 0 || end > code.length || (start === 0 && end === code.length)) continue
            mod.executed.set(`${start}:${end}`, [start, end])
          }
        }
        for (const mod of byKey.values())
          modules.push({ path: mod.path, code: mod.code, executed: [...mod.executed.values()] })
      } catch (error) {
        errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
      }
      const payload: WorkerPayload = {
        version: 1,
        testFile,
        pid: process.pid,
        threadId,
        // Jest re-evaluates every module per file, so reusing its worker process is not sharing.
        isolateReused: layout === 'vitest' && reused,
        modules,
        natives: [...natives],
        paths: [
          ...recorder.paths.values(),
          // Module files the runner read and compiled are recorded as modules, by what executed.
          ...[...recorder.runnerReads]
            .filter(([p]) => !compiled?.has(p) && !recorder.paths.has(`read\u0000${p}`))
            .map(([p, type]) => ({ p, kind: 'read' as const, type })),
        ],
        writes: [...recorder.writes],
        env: [...recorder.envReads].map(([n, h]) => ({ n, h })),
        toolchainEnv: [...recorder.toolchainEnv].map(([n, h]) => ({ n, h })),
        envBaseline,
        envEnumerated: recorder.envEnumeratedFlag,
        envWritten: [...recorder.envWritten],
        net: [...recorder.netEvents.values()],
        spawns: [...recorder.spawns],
        dlopen: [...recorder.dlopens],
        evalScripts,
        sourceObserved: recorder.sourceObservedFlag,
        snapshot,
        toolchain: [...state.toolchain],
        toolchainFiles: [...state.toolchainFiles],
        captureErrors: errors,
      }
      // Detach so the worker can terminate promptly (an attached inspector keeps threads alive).
      try {
        await session.post('Profiler.stopPreciseCoverage')
        if (debuggerEnabled) await session.post('Debugger.disable')
        await session.post('Profiler.disable')
      } catch {
        // Nothing to clean up if the session already failed.
      }
      session.disconnect()
      state.session = null
      unobserved(() => {
        const dir = path.join(options.outDir, 'payloads')
        fs.mkdirSync(dir, { recursive: true })
        const name = `${digest(testFile)}-${process.pid}-${threadId}-${Date.now()}.json`
        fs.writeFileSync(path.join(dir, name), JSON.stringify(payload))
      })
    },
  }
}
