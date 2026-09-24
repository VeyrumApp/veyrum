import fs from 'node:fs'
import type { Session } from 'node:inspector/promises'
import module from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { threadId } from 'node:worker_threads'
import { digest } from '@veyrum/core/hash'
import { isInside, normalizeAbsolute } from '@veyrum/core/paths'
import { hashEnvValue } from '@veyrum/core/state'
import { coverageHub } from './coverage.ts'
import {
  type EnvScope,
  getSink,
  type HookSink,
  installHooks,
  type PathKind,
  type PathType,
  type Reader,
  replayTrace,
  setSink,
  unobserved,
} from './hooks.ts'
import { packageRootOf } from './main.ts'
import type { PayloadModule, WorkerPayload } from './payload.ts'
import { parseTrace } from './trace.ts'

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
   *   vm.compileFunction (no wrapper), so a file's modules are the scripts executed during it;
   * - 'node': a process runs one file (node:test), and Node's own loader compiles every module
   *   unwrapped, from the source its load hooks return.
   */
  readonly layout?: 'vitest' | 'jest' | 'node'
  /**
   * The project collects its own V8 coverage in this run. Capture then starts in the mode that
   * coverage uses (block counts): V8 stops reporting functions compiled before a switch from binary
   * to count coverage, so the mode must not change once code has run (see coverage.ts).
   */
  readonly projectCoverage?: boolean
  /**
   * Install the hooks and start recording now, but start coverage only when startCoverage is
   * called: code that runs before then (Vitest's own start-up, snapshot serializers) runs without
   * coverage, which is much cheaper, and the modules it evaluated are recorded whole.
   */
  readonly deferCoverage?: boolean
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
  /** Node layout: sources Node's loader returned for repository modules, by filename. */
  loaded: Map<string, string[]> | null
  /** Jest layout: manifests of packages loaded natively by this process (the toolchain). */
  toolchain: Set<string>
  /** Jest layout: files outside node_modules loaded natively (local transformers and plugins). */
  toolchainFiles: Set<string>
  toolchainObserved: boolean
  /** Heap size after the last collection forced before starting coverage. */
  heapAfterCollection: number
}

/**
 * Heap growth after which dead code is collected before coverage starts again. Each restart walks
 * the heap and empties V8's compilation cache, which Jest relies on to recompile every module for
 * each test file cheaply: at 64 MB, restarts on nearly every Apollo Client test file made compiling
 * three times slower. At 256 MB the worker's peak memory stays within about 20% of plain Jest's.
 */
const COLLECT_AFTER_BYTES = 256 * 1024 * 1024

function heapGrown(isolate: IsolateState): boolean {
  return process.memoryUsage().heapUsed - isolate.heapAfterCollection >= COLLECT_AFTER_BYTES
}

/**
 * Precise coverage pins every function it tracks until it stops, and starting it walks the heap and
 * pins what it finds, including dead contexts not yet collected. A process hosting many files in
 * turn (Jest) must therefore collect before starting again, or each start would pin all earlier
 * files' dead contexts. Doing it only after the heap has grown keeps the cost to one collection per
 * several files.
 */
async function collectDeadCode(session: Session, isolate: IsolateState): Promise<void> {
  if (isolate.files === 0 || !heapGrown(isolate)) return
  try {
    await session.post('HeapProfiler.collectGarbage')
  } catch {
    // Without a collection, memory grows but results are unaffected.
  }
  isolate.heapAfterCollection = process.memoryUsage().heapUsed
}

/** Veyrum's own claim on the isolate's coverage (see coverage.ts). */
const CAPTURE_CONSUMER = {}

/**
 * Ends a coverage session kept across files (Jest layout), for a process that goes on to do other
 * work after its tests (Jest running in band in the runner's main process).
 */
export async function endWorkerCapture(): Promise<void> {
  const isolate = (globalThis as unknown as Record<symbol, IsolateState | undefined>)[ISOLATE_KEY]
  if (!isolate?.session) return
  isolate.session = null
  await coverageHub().release(CAPTURE_CONSUMER)
}

/** Stack frames of Jest's module loader (its file cache reads each module before compiling it). */
const JEST_RUNTIME_FRAME = /[\\/]jest-runtime[\\/]build[\\/]/

/**
 * Stack frames of code that reads package manifests only for module format, resolution or its own
 * configuration field: Jest's module resolver and Babel's configuration loader.
 */
const MANIFEST_READERS = [/[\\/]jest-resolve[\\/]build[\\/]/, /[\\/]@babel[\\/]core[\\/]lib[\\/]config[\\/]/]

/** Jest 29 wraps CommonJS modules in this (Jest 30 uses vm.compileFunction without a wrapper). */
const JEST29_WRAPPER_START = '({"Object.<anonymous>":function('
const JEST29_WRAPPER_OPEN = '){'
const JEST29_WRAPPER_CLOSE = '\n}});'

/**
 * Coverage mode. Capture uses binary coverage: count coverage keeps V8 from optimizing any code in
 * the worker, the toolchain included (Apollo Client +47%, apollo-server +97%, where ts-jest
 * type-checks in the workers). Binary coverage reports each compiled function once per session,
 * though, and Jest's files share compiled functions through V8's compilation cache, so a later
 * file's calls would go unreported. Repository modules are therefore compiled afresh for each file
 * (FILE_SUFFIX); dependencies keep the cache, because only their loading is recorded (Apollo Client
 * +6%, apollo-server +22%). When the project collects its own V8 coverage, capture shares its count
 * coverage instead (see coverage.ts) and nothing is suffixed.
 */
/**
 * Appended under binary coverage to every repository module Jest compiles while a file is
 * captured, unique per file: identical source would reuse earlier files' functions, which binary
 * coverage has already reported. A trailing comment shifts no offsets.
 */
const FILE_SUFFIX = /\n\/\/# veyrum-file \d+$/

/** The module code inside a script Jest compiled, and its offset in the script. */
function jestModuleCode(compiled: string): { code: string; offset: number } {
  const source = compiled.replace(FILE_SUFFIX, '')
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
function installCompileHooks(isolate: IsolateState, options: WorkerCaptureOptions): void {
  /**
   * The source to compile: recorded while a file is captured. Under binary coverage a repository
   * module is suffixed, so its functions are compiled afresh and reported; dependencies keep V8's
   * compilation cache, since only their loading is recorded.
   */
  const note = (filename: unknown, source: string): string => {
    const map = isolate.compiled
    if (!map || typeof filename !== 'string' || typeof source !== 'string') return source
    const compiled =
      !options.projectCoverage && scriptLocation(filename, options).repositoryModule
        ? `${source}\n//# veyrum-file ${isolate.files}`
        : source
    // Keyed like script locations (see scriptLocation).
    const key = path.isAbsolute(filename) ? normalizeAbsolute(filename) : filename
    const list = map.get(key)
    if (list) list.push(compiled)
    else map.set(key, [compiled])
    return compiled
  }
  const mutableVm = vm as unknown as Record<string, unknown>
  const originalCompile = vm.compileFunction
  mutableVm.compileFunction = (
    code: string,
    params?: readonly string[],
    options?: vm.CompileFunctionOptions,
  ) => originalCompile(note(options?.filename, code), params, options)
  const OriginalScript = vm.Script
  mutableVm.Script = class extends OriginalScript {
    constructor(code: string, options?: vm.ScriptOptions | string) {
      super(
        note(typeof options === 'string' ? options : options?.filename, code),
        options as vm.ScriptOptions,
      )
    }
  }
  const OriginalModule = (
    vm as unknown as { SourceTextModule?: new (code: string, options?: { identifier?: string }) => object }
  ).SourceTextModule
  if (OriginalModule) {
    mutableVm.SourceTextModule = class extends OriginalModule {
      constructor(code: string, options?: { identifier?: string }) {
        super(note(options?.identifier, code), options)
      }
    }
  }
}

const ISOLATE_KEY = Symbol.for('veyrum.capture.isolate')

interface ScriptLocation {
  readonly absolute: string
  readonly ignored: boolean
  /** Inside the repository and outside node_modules: a module whose code is fingerprinted. */
  readonly repositoryModule: boolean
}

/**
 * Where a script's URL points, computed once per URL: a worker that hosts many files (Jest) sees
 * the same thousands of scripts in every coverage result.
 */
const scriptLocations = new Map<string, ScriptLocation>()

function scriptLocation(url: string, options: WorkerCaptureOptions): ScriptLocation {
  let where = scriptLocations.get(url)
  if (!where) {
    const absolute = normalizeAbsolute(url.startsWith('file://') ? fileURLToPath(url) : url)
    where = {
      absolute,
      ignored: options.ignoredPrefixes.some((p) => absolute.startsWith(p)),
      repositoryModule:
        isInside(options.root, absolute) && !absolute.includes(`${path.sep}node_modules${path.sep}`),
    }
    scriptLocations.set(url, where)
  }
  return where
}

/**
 * Diagnostics: a directory to write a CPU profile of each test file's capture window into. Runners
 * end their workers without letting `--cpu-prof` write, so the profile is taken here.
 */
const CPU_PROFILE_DIR = process.env.VEYRUM_CPU_PROFILE

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
  readonly packageNames = new Set<string>()
  readonly dlopens = new Set<string>()
  sourceObservedFlag = false
  /** The function source texts code read, to find the modules they belong to (see assemble). */
  readonly observedSources = new Set<string>()
  observedSourcesOverflow = false
  private observedSourceBytes = 0
  private readonly volatileEnv: RegExp
  /** Under the Jest layout, tests read their context's copy of the environment, never the process's. */
  private readonly testScopeOnly: boolean

  /** Where this file's child processes log what they do (see trace.ts); created on first use. */
  private readonly traceFile: string
  private traceStarted = false

  constructor(volatileEnv: RegExp, testScopeOnly: boolean, traceFile: string) {
    this.volatileEnv = volatileEnv
    this.testScopeOnly = testScopeOnly
    this.traceFile = traceFile
  }

  traceLog(): string {
    if (!this.traceStarted) {
      fs.mkdirSync(path.dirname(this.traceFile), { recursive: true })
      this.traceStarted = true
    }
    return this.traceFile
  }

  /** Records what this file's child processes did, then removes their log. */
  replayChildren(): void {
    if (!this.traceStarted) return
    let text = ''
    try {
      text = fs.readFileSync(this.traceFile, 'utf8')
      fs.rmSync(this.traceFile, { force: true })
    } catch {
      // No child wrote anything (the start failed, or the program ran no traced code).
    }
    replayTrace(parseTrace(text), this)
  }

  seen(absolute: string, kind: PathKind): boolean {
    return this.writes.has(absolute) || this.paths.has(`${kind}\u0000${absolute}`)
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
    const recorded: PathKind = reader === 'manifest' ? 'manifest' : kind
    const key = `${recorded}\u0000${absolute}`
    if (!this.paths.has(key)) this.paths.set(key, { p: absolute, kind: recorded, type })
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
  packageName(name: string): void {
    this.packageNames.add(name)
  }
  dlopen(absolute: string): void {
    this.dlopens.add(absolute)
  }
  sourceObserved(text: string): void {
    this.sourceObservedFlag = true
    if (this.observedSources.has(text)) return
    this.observedSourceBytes += text.length
    if (this.observedSourceBytes > MAX_OBSERVED_SOURCE_BYTES) this.observedSourcesOverflow = true
    else this.observedSources.add(text)
  }
}

/**
 * Returns the code strings a runner evaluated for a file (a file can be evaluated more than once).
 * Reading them from the runner avoids the Debugger domain, which slows execution noticeably.
 */
export type ModuleSources = (absolutePath: string) => readonly string[] | undefined

export interface WorkerCapture {
  /**
   * Starts coverage for a capture begun with deferCoverage. `loadedBefore` lists the absolute paths
   * of the modules the runner evaluated before this: they are recorded whole (a repository module is
   * compared by its source, a dependency like any other), since coverage saw none of their start.
   */
  startCoverage(loadedBefore: Iterable<string>): Promise<void>
  /** Collects coverage and writes the payload for the test file that just ran. */
  finish(
    testFile: string,
    snapshot: { added: number; updated: number },
    sources?: ModuleSources,
  ): Promise<void>
  /** Ends capture without a payload, for a file that turns out to need none. */
  abandon(): Promise<void>
}

/** Function source text kept per file for locating it; beyond this, all modules compare raw. */
const MAX_OBSERVED_SOURCE_BYTES = 4 * 1024 * 1024

/** Where a run lists the test files that execute without capture (their evidence is valid). */
export const UNCAPTURED_FILE = 'uncaptured.json'
const UNCAPTURED_KEY = Symbol.for('veyrum.capture.uncaptured')

/**
 * The test files of this run that execute without capture, read once per isolate from the run's
 * scratch directory. A missing or unreadable list means every file is captured.
 */
export function uncapturedFiles(outDir: string): ReadonlySet<string> {
  const g = globalThis as unknown as Record<symbol, { dir: string; files: ReadonlySet<string> } | undefined>
  const cached = g[UNCAPTURED_KEY]
  if (cached?.dir === outDir) return cached.files
  let files: ReadonlySet<string> = new Set()
  unobserved(() => {
    try {
      files = new Set(JSON.parse(fs.readFileSync(path.join(outDir, UNCAPTURED_FILE), 'utf8')) as string[])
    } catch {
      // Every file is captured.
    }
  })
  g[UNCAPTURED_KEY] = { dir: outDir, files }
  return files
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
  // Before the project's own coverage can start (Jest starts it after the environment's setup,
  // also for files that run without capture): its calls must go through the hub.
  coverageHub()
  const g = globalThis as unknown as Record<symbol, IsolateState | undefined>
  if (g[ISOLATE_KEY]) return
  installHooks({
    root: options.root,
    ignoredPrefixes: [...options.ignoredPrefixes, path.resolve(options.outDir) + path.sep],
    observeSource: true,
    manifestReaders: MANIFEST_READERS,
    ...(options.layout === 'jest' ? { runnerReaders: [JEST_RUNTIME_FRAME] } : {}),
  })
  const isolate: IsolateState = {
    session: null,
    files: 0,
    compiled: null,
    loaded: null,
    toolchain: new Set(),
    toolchainFiles: new Set(),
    toolchainObserved: true,
    heapAfterCollection: 0,
  }
  g[ISOLATE_KEY] = isolate
  if (options.layout === 'jest') {
    installCompileHooks(isolate, options)
    isolate.toolchainObserved = recordToolchain(isolate.toolchain, isolate.toolchainFiles)
  }
  if (options.layout === 'node') isolate.toolchainObserved = recordLoadedSources(isolate, options)
}

const scopes = new Map<string, string | null>()

/** The package.json that governs a module (the nearest one above it), or null. */
function packageScope(file: string): string | null {
  const dir = path.dirname(file)
  let found = scopes.get(dir)
  if (found === undefined) {
    const candidate = path.join(dir, 'package.json')
    const exists = unobserved(() => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() === true)
    const parent = path.dirname(dir)
    found = exists ? candidate : parent === dir ? null : packageScope(path.join(parent, 'x'))
    scopes.set(dir, found)
  }
  return found
}

const JAVASCRIPT_FORMATS = new Set(['commonjs', 'module', 'commonjs-typescript', 'module-typescript'])

/** Node layout: keeps the source Node's loader compiles for each repository module. */
function recordLoadedSources(isolate: IsolateState, options: WorkerCaptureOptions): boolean {
  const register = (module as unknown as { registerHooks?: (hooks: object) => unknown }).registerHooks
  if (!register) return false
  const loaded = new Map<string, string[]>()
  isolate.loaded = loaded
  register({
    load: (
      url: string,
      context: unknown,
      nextLoad: (url: string, context: unknown) => { source?: unknown },
    ) => {
      const result = nextLoad(url, context) as { source?: unknown; format?: string }
      if (url.startsWith('file:')) {
        const where = scriptLocation(url, options)
        const source = result.source
        // Node reads the package scope's manifest itself (module format, exports, imports).
        const manifest = where.ignored ? null : packageScope(where.absolute)
        if (manifest) getSink()?.path(manifest, 'manifest', 'file', 'manifest')
        // JSON, WebAssembly and the like run no JavaScript coverage sees: their file is the input.
        if (!where.ignored && !JAVASCRIPT_FORMATS.has(result.format ?? '')) {
          getSink()?.path(where.absolute, 'read', 'file', 'other')
          return result
        }
        if (!where.ignored && where.repositoryModule && source != null) {
          const text =
            typeof source === 'string' ? source : Buffer.from(source as Uint8Array).toString('utf8')
          const list = loaded.get(where.absolute)
          if (list) list.push(text)
          else loaded.set(where.absolute, [text])
        }
      }
      return result
    },
  })
  return true
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

/**
 * Directories of repository packages this process resolved by name, with those names (see
 * observeJestResolver), and names to record for every file when a resolver's cache cannot be
 * observed.
 */
const hastePackageDirs = new Map<string, Set<string>>()
const unobservedCacheNames = new Set<string>()
let hasteModuleResolved = false
const RESOLVER_HOOK_KEY = Symbol.for('veyrum.resolverHook')

interface JestResolverPrototype {
  getPackage(name: string): string | null
  getModule(name: string): string | null
}

/**
 * Observes how Jest's resolver consults its haste map. A bare specifier that node_modules
 * resolution cannot find is looked up by name among the repository's package.json files, so the
 * set of packages declaring that name is an input of the file that looked it up.
 *
 * Jest's resolver caches successful resolutions per worker across files, so a later file
 * resolving the same specifier gets the cached path without a lookup. Cache hits inside a
 * package resolved by name therefore record that name too; inside such a package that can include
 * paths resolved another way, which only adds inputs. Haste modules (named by a
 * `hasteImplModulePath`) cannot be recomputed at plan time, so resolving one ends reuse.
 */
export function observeJestResolver(resolver: { prototype: JestResolverPrototype }): void {
  const proto = resolver.prototype as JestResolverPrototype & { [RESOLVER_HOOK_KEY]?: true }
  if (proto[RESOLVER_HOOK_KEY]) return
  proto[RESOLVER_HOOK_KEY] = true
  const getPackage = proto.getPackage
  proto.getPackage = function (this: { _moduleNameCache?: unknown }, name: string) {
    const found = getPackage.call(this, name)
    try {
      getSink()?.packageName(name)
      if (found) {
        const dir = path.dirname(found) + path.sep
        const names = hastePackageDirs.get(dir) ?? new Set<string>()
        hastePackageDirs.set(dir, names.add(name))
        if (!observeNameCache(this._moduleNameCache)) unobservedCacheNames.add(name)
      }
    } catch {
      // Observation must never change behavior.
    }
    return found
  }
  const getModule = proto.getModule
  proto.getModule = function (this: unknown, name: string) {
    const found = getModule.call(this, name)
    if (found) hasteModuleResolved = true
    return found
  }
}

/** Records package names for cache hits inside packages resolved by name; false if not a Map. */
function observeNameCache(cache: unknown): boolean {
  if (!(cache instanceof Map)) return false
  const hooked = cache as Map<string, unknown> & { [RESOLVER_HOOK_KEY]?: true }
  if (hooked[RESOLVER_HOOK_KEY]) return true
  hooked[RESOLVER_HOOK_KEY] = true
  const get = cache.get
  cache.get = function (this: Map<string, unknown>, key: string) {
    const value = get.call(this, key)
    try {
      if (typeof value === 'string') {
        const sink = getSink()
        for (const [dir, names] of hastePackageDirs)
          if (value.startsWith(dir)) for (const name of names) sink?.packageName(name)
      }
    } catch {
      // Observation must never change behavior.
    }
    return value
  }
  return true
}

export async function beginWorkerCapture(options: WorkerCaptureOptions): Promise<WorkerCapture> {
  const beginStarted = performance.now()
  const errors: string[] = []
  prepareWorkerHooks(options)
  const isolate = (globalThis as unknown as Record<symbol, IsolateState>)[ISOLATE_KEY]!
  const layout = options.layout ?? 'vitest'
  // Under Jest one session serves every file of the process: starting coverage deoptimizes all code
  // and walks the heap, which per file would dominate the cost of short test files. Counts are reset
  // by each take, so a file sees only its own executions. The session is restarted, after a
  // collection, once the functions it pins have grown the heap.
  // Count coverage keeps V8 from optimizing, which slows CPU-bound test code. Binary coverage does
  // not, but reports each compiled function only once per session, and Jest's files share compiled
  // functions through V8's compilation cache, so a later file's calls would go unreported. Giving
  // each file unique source restores binary coverage but defeats the cache, which costs more.
  const hub = coverageHub()
  let session: Session | null = null
  const loadedBeforeCoverage = new Set<string>()
  let startMs = 0
  const startCoverage = async (loadedBefore: Iterable<string>): Promise<void> => {
    if (session) return
    const started = performance.now()
    if (layout === 'jest' && isolate.session && heapGrown(isolate))
      await hub.restart((fresh) => collectDeadCode(fresh, isolate))
    // Under Vitest, a second file in the same isolate (isolation off) starts coverage again, but
    // modules cached by earlier files will not re-execute, so its payload is marked as reused.
    session = await hub.acquire(
      CAPTURE_CONSUMER,
      options.projectCoverage ? { callCount: true, detailed: true } : { callCount: false, detailed: false },
      (fresh) => collectDeadCode(fresh, isolate),
    )
    isolate.session = session
    for (const file of loadedBefore)
      if (path.isAbsolute(file) || file.startsWith('file://'))
        loadedBeforeCoverage.add(normalizeAbsolute(file.startsWith('file://') ? fileURLToPath(file) : file))
    // Reported before this file began: under Jest, scripts of earlier files, which it ignores anyway.
    hub.discard(CAPTURE_CONSUMER)
    if (CPU_PROFILE_DIR) await session.post('Profiler.start')
    startMs = performance.now() - started
  }
  if (!options.deferCoverage) await startCoverage([])
  isolate.files++
  const reused = isolate.files > 1
  const envBaseline = unobserved(() => {
    const out: Record<string, string | null> = {}
    for (const [n, v] of Object.entries(process.env))
      if (!options.volatileEnv.test(n)) out[n] = hashEnvValue(v)
    return out
  })
  const recorder = new FileRecorder(
    options.volatileEnv,
    layout === 'jest',
    path.join(options.outDir, 'traces', `${process.pid}-${threadId}-${isolate.files}.log`),
  )
  if (layout === 'jest') isolate.compiled = new Map()
  const compiled = isolate.compiled
  // Restored at finish: tests can run inside the runner's main process, whose recorder is active.
  const outerSink = getSink()
  setSink(recorder)
  const state = isolate

  const beginMs = performance.now() - beginStarted
  return {
    startCoverage,
    async abandon() {
      setSink(outerSink)
      state.compiled = null
      if (!session) return
      if (CPU_PROFILE_DIR) await session.post('Profiler.stop').catch(() => {})
      if (layout !== 'jest') {
        state.session = null
        await hub.release(CAPTURE_CONSUMER)
      }
    },
    async finish(testFile, snapshot, sources) {
      const finishStarted = performance.now()
      if (!session) {
        errors.push('coverage never started')
        await startCoverage([])
      }
      const active = session as unknown as Session
      let debuggerEnabled = false
      /** The executed module code and its offset inside the script, or null if not a wrapped module. */
      const moduleCode = async (
        absolute: string,
        scriptId: string,
        scriptLength: number,
      ): Promise<{ code: string; offset: number } | null> => {
        // The script is WRAPPER_START + args + WRAPPER_OPEN + code + WRAPPER_CLOSE.
        const evaluated = sources?.(absolute)
        // A file the runner never evaluated was loaded natively (an externalized workspace package,
        // for example): it is no wrapped module, and asking the Debugger to confirm is costly.
        if (sources && evaluated === undefined) return null
        for (const code of evaluated ?? []) {
          const offset = scriptLength - WRAPPER_CLOSE.length - code.length
          if (offset > WRAPPER_START.length + WRAPPER_OPEN.length) return { code, offset }
        }
        if (!debuggerEnabled) {
          await active.post('Debugger.enable')
          debuggerEnabled = true
        }
        const source = (
          (await active.post('Debugger.getScriptSource', { scriptId })) as { scriptSource: string }
        ).scriptSource
        const open = source.startsWith(WRAPPER_START) ? source.indexOf(WRAPPER_OPEN) : -1
        if (open < 0 || !source.endsWith(WRAPPER_CLOSE)) return null
        const offset = open + WRAPPER_OPEN.length
        return { code: source.slice(offset, source.length - WRAPPER_CLOSE.length), offset }
      }
      /** The module code of a script Node's loader compiled: as loaded, else from the Debugger. */
      const nodeCode = async (
        absolute: string,
        scriptId: string,
        scriptLength: number,
      ): Promise<{ code: string; offset: number }> => {
        for (const source of state.loaded?.get(absolute) ?? [])
          if (source.length === scriptLength) return { code: source, offset: 0 }
        if (!debuggerEnabled) {
          await active.post('Debugger.enable')
          debuggerEnabled = true
        }
        const source = (
          (await active.post('Debugger.getScriptSource', { scriptId })) as { scriptSource: string }
        ).scriptSource
        return { code: source, offset: 0 }
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
          await active.post('Debugger.enable')
          debuggerEnabled = true
        }
        const source = (
          (await active.post('Debugger.getScriptSource', { scriptId })) as { scriptSource: string }
        ).scriptSource
        return jestModuleCode(source)
      }
      setSink(outerSink)
      unobserved(() => recorder.replayChildren())
      state.compiled = null
      if (!state.toolchainObserved)
        errors.push('module loads cannot be observed (Node lacks module.registerHooks)')
      if (hasteModuleResolved) errors.push('a haste module was resolved; haste module names are not observed')
      const modules: PayloadModule[] = []
      const wholeModules: string[] = []
      const natives = new Set<string>()
      let evalScripts = 0
      let takeMs = 0
      try {
        const takeStarted = performance.now()
        // Also what the project's own coverage took since this file began (see coverage.ts).
        const coverage = { result: await hub.take(CAPTURE_CONSUMER) }
        if (hub.disturbed(CAPTURE_CONSUMER))
          errors.push('the coverage mode changed while capturing, which can leave executions unreported')
        takeMs = performance.now() - takeStarted
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
          if (!url.startsWith('file://') && !path.isAbsolute(url)) continue
          const where = scriptLocation(url, options)
          if (where.ignored) continue
          const absolute = where.absolute
          const executed = script.functions.some((f) => (f.ranges[0]?.count ?? 0) > 0)
          if (!where.repositoryModule) {
            // Under Jest, dependencies come from what the file compiled (below).
            if (layout !== 'jest') natives.add(absolute)
            continue
          }
          // Evaluated before coverage started: recorded whole (below), so its functions need no mapping.
          if (loadedBeforeCoverage.has(absolute)) continue
          // Jest keeps earlier files' scripts in the isolate; only those that ran now belong to this
          // file. Scripts Jest did not compile into the test context during this file are the runner
          // and its toolchain (transformers), recorded as shared inputs instead.
          if (layout === 'jest' && (!executed || !compiled?.has(absolute))) continue
          const scriptLength = Math.max(0, ...script.functions.map((f) => f.ranges[0]?.endOffset ?? 0))
          const found =
            layout === 'jest'
              ? await jestCode(absolute, script.scriptId, scriptLength)
              : layout === 'node'
                ? await nodeCode(absolute, script.scriptId, scriptLength)
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
        // Every dependency Jest compiled into the file's context ran there: Jest runs each module it
        // compiles. Under binary coverage, a dependency an earlier file already ran is not reported
        // again, so what was compiled is the record of what was loaded.
        if (layout === 'jest')
          for (const file of compiled?.keys() ?? []) {
            const where = scriptLocation(file, options)
            if (!where.ignored && !where.repositoryModule) natives.add(where.absolute)
          }
        // Evaluated before coverage started: repository modules are compared whole.
        for (const file of loadedBeforeCoverage) {
          const where = scriptLocation(file, options)
          if (where.ignored) continue
          if (where.repositoryModule) wholeModules.push(where.absolute)
          else natives.add(where.absolute)
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
        ...(wholeModules.length > 0 ? { wholeModules } : {}),
        paths: [
          // Node layout: the loader's own reads of a module it compiled are that module, recorded by
          // what executed.
          ...[...recorder.paths.values()].filter(
            (e) => !(layout === 'node' && e.kind !== 'dir' && state.loaded?.has(e.p)),
          ),
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
        packageNames: [...new Set([...recorder.packageNames, ...unobservedCacheNames])].sort(),
        dlopen: [...recorder.dlopens],
        evalScripts,
        sourceObserved: recorder.sourceObservedFlag,
        ...(recorder.sourceObservedFlag && !recorder.observedSourcesOverflow
          ? { observedSources: [...recorder.observedSources] }
          : {}),
        snapshot,
        toolchain: [...state.toolchain],
        toolchainFiles: [...state.toolchainFiles],
        captureErrors: errors,
        timings: { beginMs, finishMs: performance.now() - finishStarted, takeMs, startMs },
      }
      if (CPU_PROFILE_DIR) {
        try {
          const { profile } = await active.post('Profiler.stop')
          const name = `${digest(testFile)}-${process.pid}-${threadId}-${Date.now()}.cpuprofile`
          unobserved(() => {
            fs.mkdirSync(CPU_PROFILE_DIR, { recursive: true })
            fs.writeFileSync(path.join(CPU_PROFILE_DIR, name), JSON.stringify(profile))
          })
        } catch {
          // Diagnostics only.
        }
      }
      if (debuggerEnabled) {
        try {
          await active.post('Debugger.disable')
        } catch {
          // The session failed; the coverage above reports it.
        }
      }
      if (layout !== 'jest') {
        // Detach so the worker can terminate promptly (an attached inspector keeps threads alive).
        state.session = null
        await hub.release(CAPTURE_CONSUMER)
      }
      unobserved(() => {
        const dir = path.join(options.outDir, 'payloads')
        fs.mkdirSync(dir, { recursive: true })
        const name = `${digest(testFile)}-${process.pid}-${threadId}-${Date.now()}.json`
        fs.writeFileSync(path.join(dir, name), JSON.stringify(payload))
      })
    },
  }
}
