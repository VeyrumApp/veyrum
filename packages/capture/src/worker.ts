import fs from 'node:fs'
import { Session } from 'node:inspector/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { threadId } from 'node:worker_threads'
import { digest } from '@veyrum/core/hash'
import { isInside } from '@veyrum/core/paths'
import { hashEnvValue } from '@veyrum/core/state'
import { type HookSink, installHooks, type PathKind, type PathType, setSink, unobserved } from './hooks.ts'
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
}

/** The prefix Vitest wraps every transformed module in; offsets are shifted by its length. */
const WRAPPER_START = "'use strict';async ("
const WRAPPER_OPEN = ')=>{{'
const WRAPPER_CLOSE = '\n}}'

interface IsolateState {
  session: Session | null
  files: number
}

const ISOLATE_KEY = Symbol.for('veyrum.capture.isolate')

class FileRecorder implements HookSink {
  readonly paths = new Map<string, { p: string; kind: PathKind; type: PathType }>()
  readonly writes = new Set<string>()
  readonly envReads = new Map<string, string | null>()
  readonly envWritten = new Set<string>()
  envEnumeratedFlag = false
  readonly netEvents = new Map<string, { host: string; port: number | null; local: boolean }>()
  readonly spawns = new Set<string>()
  readonly dlopens = new Set<string>()
  sourceObservedFlag = false
  private readonly volatileEnv: RegExp

  constructor(volatileEnv: RegExp) {
    this.volatileEnv = volatileEnv
  }

  path(absolute: string, kind: PathKind, type: PathType): void {
    // Reads of files this check wrote itself derive from its own code and are not inputs.
    if (this.writes.has(absolute)) return
    const key = `${kind}\u0000${absolute}`
    if (!this.paths.has(key)) this.paths.set(key, { p: absolute, kind, type })
  }
  write(absolute: string): void {
    this.writes.add(absolute)
  }
  env(name: string, value: string | undefined): void {
    if (this.envWritten.has(name) || this.envReads.has(name) || this.volatileEnv.test(name)) return
    this.envReads.set(name, hashEnvValue(value))
  }
  envEnumerated(): void {
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
export async function beginWorkerCapture(options: WorkerCaptureOptions): Promise<WorkerCapture> {
  const errors: string[] = []
  const g = globalThis as unknown as Record<symbol, IsolateState | undefined>
  let isolate = g[ISOLATE_KEY]
  if (!isolate) {
    installHooks({
      root: options.root,
      ignoredPrefixes: [...options.ignoredPrefixes, path.resolve(options.outDir) + path.sep],
      observeSource: true,
    })
    isolate = { session: null, files: 0 }
    g[ISOLATE_KEY] = isolate
  }
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
  const recorder = new FileRecorder(options.volatileEnv)
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
      setSink(null)
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
          if (!isInside(options.root, absolute) || absolute.includes(`${path.sep}node_modules${path.sep}`)) {
            natives.add(absolute)
            continue
          }
          const scriptLength = Math.max(0, ...script.functions.map((f) => f.ranges[0]?.endOffset ?? 0))
          const found = await moduleCode(absolute, script.scriptId, scriptLength)
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
            // The script function and the wrapper arrow extend past the module code: they are the top level.
            if (start < 0 || end > code.length) continue
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
        isolateReused: reused,
        modules,
        natives: [...natives],
        paths: [...recorder.paths.values()],
        writes: [...recorder.writes],
        env: [...recorder.envReads].map(([n, h]) => ({ n, h })),
        envBaseline,
        envEnumerated: recorder.envEnumeratedFlag,
        envWritten: [...recorder.envWritten],
        net: [...recorder.netEvents.values()],
        spawns: [...recorder.spawns],
        dlopen: [...recorder.dlopens],
        evalScripts,
        sourceObserved: recorder.sourceObservedFlag,
        snapshot,
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
