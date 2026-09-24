import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import workerThreads from 'node:worker_threads'
import {
  executableTraceable,
  resolveExecutable,
  TRACE_LIBRARY,
  type TraceEvent,
  type TraceFs,
  tracingAvailable,
} from './trace.ts'

/** `manifest`: a package manifest a manifest reader read (see InstallOptions.manifestReaders). */
export type PathKind = 'read' | 'stat' | 'dir' | 'manifest'
/**
 * Which environment object a read went through: the process's own `process.env`, or a copy a
 * runner made for test code (Jest gives each test file's context its own copy). Under Jest, reads
 * of the process's environment come from the runner and its transformers, not from tests.
 */
export type EnvScope = 'process' | 'test'

export type Reader = 'runner' | 'manifest' | 'node-loader' | 'other'
export type PathType = 'file' | 'dir' | 'other' | 'absent'

/** Receives observations from the hooks. Swapped per test file by the runner adapter. */
export interface HookSink {
  /**
   * `reader` says who read the file when the hooks classify reads (InstallOptions.runnerReaders):
   * the runner's module loader, a manifest reader (InstallOptions.manifestReaders), Node's own
   * module loader, or anything else (test code).
   */
  path(absolute: string, kind: PathKind, type: PathType, reader: Reader): void
  /** True when the observation is already recorded, so hooks can skip classifying it again. */
  seen?(absolute: string, kind: PathKind): boolean
  write(absolute: string): void
  /** `copying` is true when the read is part of copying the whole environment ({...process.env}). */
  env(name: string, value: string | undefined, copying: boolean, scope: EnvScope): void
  envEnumerated(scope: EnvScope): void
  envWrite(name: string): void
  net(host: string, port: number | undefined, local: boolean): void
  spawn(command: string): void
  /**
   * The log file child processes started now should trace into, or null when this sink does not
   * trace children (their start is then reported with `spawn`).
   */
  traceLog?(): string | null
  /** A package name looked up among the repository's own manifests (Jest's haste packages). */
  packageName(name: string): void
  dlopen(absolute: string): void
  /** Code read the source text of a (non-native) function: that text. */
  sourceObserved(text: string): void
}

const noop: HookSink = {
  path() {},
  write() {},
  env() {},
  envEnumerated() {},
  envWrite() {},
  net() {},
  spawn() {},
  packageName() {},
  dlopen() {},
  sourceObserved() {},
}

/** The unpatched fs functions, for the capture layer's own reads while hooks are active. */
export interface RawFs {
  readonly statSync: typeof fs.statSync
  readonly readFileSync: typeof fs.readFileSync
  readonly readdirSync: typeof fs.readdirSync
}

interface HookState {
  raw: RawFs
  sink: HookSink
  /** Re-entrancy guard: hooks must not observe the capture layer's own I/O. */
  depth: number
  installed: boolean
  /** Explicitly ignored prefixes (the capture layer's own files and scratch space). */
  ignoredPrefixes: string[]
  /** Temporary-directory prefixes: ignored unless inside the repository root. */
  tempPrefixes: string[]
  /** Repository root prefix; paths inside it are always observed unless explicitly ignored. */
  rootPrefix: string | null
  /** Callers whose reads are the runner loading modules (see InstallOptions.runnerReaders). */
  runnerReaders: RegExp[]
  /** Callers that read package manifests for known fields (see InstallOptions.manifestReaders). */
  manifestReaders: RegExp[]
}

const STATE_KEY = Symbol.for('veyrum.capture.hooks')
const g = globalThis as unknown as Record<symbol, HookState | undefined>
function sharedState(): HookState {
  const existing = g[STATE_KEY]
  if (existing) return existing
  const created: HookState = {
    raw: { statSync: fs.statSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync },
    sink: noop,
    depth: 0,
    installed: false,
    ignoredPrefixes: [],
    tempPrefixes: [],
    rootPrefix: null,
    runnerReaders: [],
    manifestReaders: [],
  }
  g[STATE_KEY] = created
  return created
}

// One state per isolate, even if several copies of this module load (native and bundled).
const state: HookState = sharedState()

export const rawFs: RawFs = state.raw

export function setSink(sink: HookSink | null): void {
  state.sink = sink ?? noop
}

/** The active sink, so a nested capture can restore it (tests running in the main process). */
export function getSink(): HookSink | null {
  return state.sink === noop ? null : state.sink
}

/**
 * Whether hooks should record now: outside the capture layer's own I/O, with a sink attached.
 * Hooks stay installed in a worker once any file installed them; between captures (a file whose
 * evidence is valid runs without capture) they return at once instead of classifying callers.
 */
function recording(): boolean {
  return state.depth === 0 && state.sink !== noop
}

/** Runs fn without recording anything (for the capture layer's own I/O). */
export function unobserved<T>(fn: () => T): T {
  state.depth++
  try {
    return fn()
  } finally {
    state.depth--
  }
}

const origStatSync = state.raw.statSync

function typeOf(absolute: string): PathType {
  try {
    const st = origStatSync(absolute, { throwIfNoEntry: false })
    if (!st) return 'absent'
    return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'
  } catch {
    return 'absent'
  }
}

/** Already absolute and normalized: no `.` or `..` segments, doubled or trailing separators. */
const NOT_NORMAL = /\/\.\.?(\/|$)|\/\/|.\/$/

function toAbsolute(p: unknown): string | null {
  // Most paths the runner and its toolchain pass are already absolute and normal (POSIX only).
  if (typeof p === 'string')
    return path.sep === '/' && p.startsWith('/') && !NOT_NORMAL.test(p) ? p : path.resolve(p)
  if (p instanceof URL) return p.protocol === 'file:' ? fileURLToPath(p) : null
  if (Buffer.isBuffer(p)) return path.resolve(p.toString('utf8'))
  return null
}

function ignored(absolute: string): boolean {
  for (const prefix of state.ignoredPrefixes) if (absolute.startsWith(prefix)) return true
  // Temporary files are assumed to be created by the test itself, but a repository can live under
  // the temporary directory (some CI systems check out there): its files are always inputs.
  if (state.rootPrefix && absolute.startsWith(state.rootPrefix)) return false
  // The temporary directory itself too: its listing is every process's scratch space.
  for (const prefix of state.tempPrefixes)
    if (absolute.startsWith(prefix) || absolute === prefix.slice(0, -1)) return true
  return false
}

/** This package's built output: stack frames inside it are the hooks themselves. */
const OWN_DIR = path.dirname(fileURLToPath(import.meta.url)) + path.sep

/**
 * File names of the calling frames, innermost first. Reads raw call sites instead of formatting a
 * stack: runners install source-map support, which would map every frame of every stack.
 */
function callerFiles(limit: number): string[] {
  const prepare = Error.prepareStackTrace
  const stackLimit = Error.stackTraceLimit
  const holder: { stack?: unknown } = {}
  let stack: unknown
  try {
    Error.stackTraceLimit = limit
    Error.prepareStackTrace = (_error, sites) => sites
    Error.captureStackTrace(holder, callerFiles)
    // The stack is formatted lazily, on first access: read it while the override is in place.
    stack = holder.stack
  } finally {
    Error.prepareStackTrace = prepare
    Error.stackTraceLimit = stackLimit
  }
  const sites = Array.isArray(stack) ? (stack as NodeJS.CallSite[]) : []
  return sites.map((site) => {
    // ES modules report file URLs.
    const file = site.getFileName() ?? ''
    if (!file.startsWith('file://')) return file
    let converted = urlPaths.get(file)
    if (converted === undefined) {
      converted = fileURLToPath(file)
      urlPaths.set(file, converted)
    }
    return converted
  })
}

/** File URLs of call sites, converted once: the same few modules read files over and over. */
const urlPaths = new Map<string, string>()

/** Deep enough to reach a manifest reader behind its fs abstraction (Babel reads through gensync). */
const MANIFEST_STACK_LIMIT = 40

/**
 * Enough for the reader: Veyrum's own hook frames and Node's fs frames come first, then the caller.
 * A deeper caller is classified as other code, which records the read as an input.
 */
const READER_STACK_LIMIT = 8

/**
 * Who called into fs: the runner's module loader, Node's module loader, a manifest reader (for a
 * package manifest), or other code. The first caller outside Veyrum and Node decides, except that a
 * manifest read by other code counts as a manifest read when a manifest reader is anywhere below.
 */
function classifyReader(isManifest: boolean): Reader {
  const files = callerFiles(isManifest ? MANIFEST_STACK_LIMIT : READER_STACK_LIMIT)
  for (const file of files) {
    if (file.startsWith(OWN_DIR)) continue
    if (file.startsWith('node:internal/modules/')) return 'node-loader'
    // Skip Node's own fs internals (readFileSync calls openSync, which is hooked too).
    if (file.startsWith('node:') || file === '') continue
    if (state.runnerReaders.some((re) => re.test(file))) return 'runner'
    break
  }
  if (isManifest && files.some((file) => state.manifestReaders.some((re) => re.test(file)))) return 'manifest'
  return 'other'
}

function observePath(p: unknown, kind: PathKind): void {
  if (!recording()) return
  const absolute = toAbsolute(p)
  if (!absolute || ignored(absolute) || state.sink.seen?.(absolute, kind)) return
  state.depth++
  try {
    const isManifest = state.manifestReaders.length > 0 && path.basename(absolute) === 'package.json'
    const classify = kind === 'read' && (state.runnerReaders.length > 0 || isManifest)
    const reader = classify ? classifyReader(isManifest) : 'other'
    state.sink.path(absolute, kind, typeOf(absolute), reader)
  } finally {
    state.depth--
  }
}

function observeWrite(p: unknown): void {
  if (!recording()) return
  const absolute = toAbsolute(p)
  if (!absolute || ignored(absolute)) return
  state.sink.write(absolute)
}

type AnyFn = (...args: any[]) => any

/**
 * Replaces target[name] with a function that calls `before` with the arguments first. `before` may
 * return an array of replacement arguments. The original's own properties are kept, and its promisified form
 * (`util.promisify.custom`, which `exec` and `exists` define) is wrapped the same way, so
 * `promisify(exec)` is observed and behaves as it does without Veyrum.
 */
function wrap(target: any, name: string, before: (args: any[]) => unknown): void {
  const original = target[name] as AnyFn | undefined
  if (typeof original !== 'function') return
  const wrapFn = (fn: AnyFn): AnyFn =>
    function (this: unknown, ...args: any[]) {
      let actual = args
      try {
        const replaced = before(args)
        if (Array.isArray(replaced)) actual = replaced
      } catch {
        // Observation must never change behavior.
      }
      return fn.apply(this, actual)
    }
  const wrapped = wrapFn(original)
  for (const key of Reflect.ownKeys(original)) {
    if (key === 'prototype') continue
    const descriptor = Object.getOwnPropertyDescriptor(original, key)!
    if (key === promisify.custom && typeof descriptor.value === 'function')
      descriptor.value = wrapFn(descriptor.value as AnyFn)
    Object.defineProperty(wrapped, key, descriptor)
  }
  target[name] = wrapped
}

const READ_FNS = ['readFileSync', 'readFile', 'createReadStream', 'readlinkSync', 'readlink'] as const
const STAT_FNS = [
  'existsSync',
  'exists',
  'statSync',
  'stat',
  'lstatSync',
  'lstat',
  'accessSync',
  'access',
  'realpathSync',
  'realpath',
] as const
const DIR_FNS = ['readdirSync', 'readdir', 'opendirSync', 'opendir'] as const
const WRITE_FNS = [
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'appendFile',
  'mkdirSync',
  'mkdir',
  'rmSync',
  'rm',
  'rmdirSync',
  'rmdir',
  'unlinkSync',
  'unlink',
  'truncateSync',
  'truncate',
  'createWriteStream',
  'symlinkSync',
  'symlink',
  'utimesSync',
  'utimes',
  'chmodSync',
  'chmod',
] as const
const TWO_PATH_WRITE_FNS = [
  'renameSync',
  'rename',
  'copyFileSync',
  'copyFile',
  'cpSync',
  'cp',
  'linkSync',
  'link',
] as const
const PROMISE_READ = ['readFile', 'readlink'] as const
const PROMISE_STAT = ['stat', 'lstat', 'access', 'realpath'] as const
const PROMISE_DIR = ['readdir', 'opendir'] as const
const PROMISE_WRITE = [
  'writeFile',
  'appendFile',
  'mkdir',
  'rm',
  'rmdir',
  'unlink',
  'truncate',
  'symlink',
  'utimes',
  'chmod',
] as const
const PROMISE_TWO_PATH_WRITE = ['rename', 'copyFile', 'cp', 'link'] as const

const WRITE_FLAG = /[wa+]/

function installFsHooks(): void {
  for (const name of READ_FNS) wrap(fs, name, (a) => observePath(a[0], 'read'))
  for (const name of STAT_FNS) wrap(fs, name, (a) => observePath(a[0], 'stat'))
  for (const name of DIR_FNS) wrap(fs, name, (a) => observePath(a[0], 'dir'))
  for (const name of WRITE_FNS) wrap(fs, name, (a) => observeWrite(a[0]))
  for (const name of TWO_PATH_WRITE_FNS)
    wrap(fs, name, (a) => {
      observePath(a[0], 'read')
      observeWrite(a[1])
    })
  const openHook = (a: any[]): void => {
    const flags = typeof a[1] === 'string' ? a[1] : 'r'
    if (WRITE_FLAG.test(flags)) observeWrite(a[0])
    else observePath(a[0], 'read')
  }
  wrap(fs, 'openSync', openHook)
  wrap(fs, 'open', openHook)
  const p = fs.promises as any
  for (const name of PROMISE_READ) wrap(p, name, (a) => observePath(a[0], 'read'))
  for (const name of PROMISE_STAT) wrap(p, name, (a) => observePath(a[0], 'stat'))
  for (const name of PROMISE_DIR) wrap(p, name, (a) => observePath(a[0], 'dir'))
  for (const name of PROMISE_WRITE) wrap(p, name, (a) => observeWrite(a[0]))
  for (const name of PROMISE_TWO_PATH_WRITE)
    wrap(p, name, (a) => {
      observePath(a[0], 'read')
      observeWrite(a[1])
    })
  wrap(p, 'open', openHook)
}

/** Wraps an environment object so reads, enumerations and writes are reported to the sink. */
export function observeEnv<T extends Record<string, string | undefined>>(
  real: T,
  scope: EnvScope = 'process',
): T {
  if ((real as any)[STATE_KEY]) return real
  // Spreads and Object.assign enumerate keys, then read every property in the same tick.
  let copying = false
  const noteEnumeration = (): void => {
    if (copying) return
    copying = true
    queueMicrotask(() => {
      copying = false
    })
  }
  return new Proxy(real, {
    get(target, key, receiver) {
      if (key === STATE_KEY) return true
      const value = Reflect.get(target, key, receiver)
      if (typeof key === 'string' && recording())
        state.sink.env(key, typeof value === 'string' ? value : undefined, copying, scope)
      return value
    },
    has(target, key) {
      const present = Reflect.has(target, key)
      if (typeof key === 'string' && recording())
        state.sink.env(key, present ? (target as any)[key] : undefined, copying, scope)
      return present
    },
    getOwnPropertyDescriptor(target, key) {
      const desc = Reflect.getOwnPropertyDescriptor(target, key)
      if (typeof key === 'string' && recording())
        state.sink.env(key, desc ? String(desc.value) : undefined, copying, scope)
      return desc
    },
    ownKeys(target) {
      if (recording()) state.sink.envEnumerated(scope)
      noteEnumeration()
      return Reflect.ownKeys(target)
    },
    set(target, key, value) {
      if (typeof key === 'string' && recording()) state.sink.envWrite(key)
      ;(target as any)[key] = value
      return true
    },
    deleteProperty(target, key) {
      if (typeof key === 'string' && recording()) state.sink.envWrite(key)
      return Reflect.deleteProperty(target, key)
    },
  })
}

function installEnvProxy(): void {
  process.env = observeEnv(process.env as Record<string, string | undefined>) as NodeJS.ProcessEnv
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|::|\[::1\])$/i

function installNetHooks(): void {
  const proto = net.Socket.prototype as any
  const original = proto.connect as AnyFn
  proto.connect = function (this: unknown, ...args: any[]) {
    try {
      let options: any = args[0]
      if (Array.isArray(options)) options = options[0]
      if (typeof options === 'number' || typeof options === 'string') {
        const port = typeof options === 'number' ? options : Number(options)
        if (Number.isNaN(port)) state.sink.net(String(options), undefined, true)
        else
          state.sink.net(
            typeof args[1] === 'string' ? args[1] : 'localhost',
            port,
            typeof args[1] !== 'string' || LOOPBACK.test(args[1]),
          )
      } else if (options && typeof options === 'object') {
        if (typeof options.path === 'string') state.sink.net(options.path, undefined, true)
        else {
          const host = typeof options.host === 'string' ? options.host : 'localhost'
          const port = typeof options.port === 'number' ? options.port : Number(options.port)
          state.sink.net(host, Number.isNaN(port) ? undefined : port, LOOPBACK.test(host))
        }
      }
    } catch {
      // Observation must never change behavior.
    }
    return original.apply(this, args)
  }
}

/**
 * Code in a worker thread runs in another isolate: its reads are not attributed to the test file,
 * so starting one is treated like starting a child process.
 */
function installWorkerThreadHook(): void {
  const Original = workerThreads.Worker
  class ObservedWorker extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      try {
        state.sink.spawn('worker_threads')
      } catch {
        // Observation must never change behavior.
      }
      super(...args)
    }
  }
  Object.defineProperty(ObservedWorker, 'name', { value: 'Worker' })
  ;(workerThreads as { Worker: typeof Original }).Worker = ObservedWorker
}

type SpawnFunction = 'spawn' | 'spawnSync' | 'exec' | 'execSync' | 'execFile' | 'execFileSync' | 'fork'

interface SpawnCall {
  /** The shell that runs the command, or null when the file runs directly. */
  readonly shell: string | null
  readonly file: string
  readonly options: Record<string, unknown> | undefined
  /** The same call with other options. */
  rebuild(options: Record<string, unknown>): unknown[]
}

const isOptions = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads a child_process call's arguments the way Node normalizes them. */
function spawnCall(name: SpawnFunction, args: unknown[]): SpawnCall {
  const file = String(args[0])
  if (name === 'exec' || name === 'execSync') {
    const second = args[1]
    const options = isOptions(second) ? second : undefined
    const callback = [args[1], args[2]].find((a) => typeof a === 'function')
    return {
      shell: typeof options?.shell === 'string' ? options.shell : '/bin/sh',
      file,
      options,
      rebuild: (o) => (callback ? [file, o, callback] : [file, o]),
    }
  }
  let i = 1
  let list: unknown[] = []
  if (Array.isArray(args[1])) {
    list = args[1]
    i = 2
  } else if (args[1] === null || (args[1] === undefined && args.length > 2)) {
    i = 2
  }
  const candidate = args[i]
  const options = isOptions(candidate) ? candidate : undefined
  if (options || args[i] === null || (args[i] === undefined && i < args.length)) i++
  const rest = args.slice(i)
  const shell =
    name === 'fork'
      ? null
      : options?.shell === true
        ? '/bin/sh'
        : typeof options?.shell === 'string'
          ? options.shell
          : null
  return {
    shell,
    file: name === 'fork' ? String(options?.execPath ?? process.execPath) : file,
    options,
    rebuild: (o) => [args[0], list, o, ...rest],
  }
}

const traceFs: TraceFs = {
  statSync: state.raw.statSync,
  openSync: fs.openSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync,
}

/**
 * Prepares a child process start. When the sink traces children and the program can be traced,
 * the child gets the tracer through its environment; the program, the PATH lookup that found it
 * and every variable of the child's environment are recorded as inputs (a shell reads its whole
 * environment). Otherwise the start is reported as an unobserved spawn.
 */
function prepareSpawn(name: SpawnFunction, args: unknown[]): unknown[] | undefined {
  if (!recording()) return undefined
  const label = String(args[0]).split(/\s+/)[0] ?? ''
  const sink = state.sink
  state.depth++
  try {
    const log = sink.traceLog?.() ?? null
    if (!log || !tracingAvailable(traceFs)) {
      sink.spawn(label)
      return undefined
    }
    const call = spawnCall(name, args)
    const given = call.options?.env as NodeJS.ProcessEnv | undefined
    // exec calls the exported execFile: a call an outer hook already prepared is left as is.
    if (given?.VEYRUM_TRACE === log) return undefined
    const env = given ?? { ...process.env }
    const cwd = typeof call.options?.cwd === 'string' ? path.resolve(call.options.cwd) : process.cwd()
    const program = call.shell ?? call.file
    const pathVariable = env.PATH
    const resolved = resolveExecutable(program, pathVariable, cwd, traceFs)
    // Programs looked up on PATH: the directories searched before the match, and the match.
    if (!program.includes('/')) {
      for (const dir of (pathVariable ?? '/usr/bin:/bin').split(':')) {
        const candidate = path.resolve(cwd, dir || '.', program)
        if (candidate === resolved) break
        if (!ignored(candidate)) sink.path(candidate, 'stat', typeOf(candidate), 'other')
      }
    }
    if (!resolved) return undefined // Nothing runs: the start fails.
    if (!executableTraceable(resolved, traceFs)) {
      sink.spawn(label)
      return undefined
    }
    if (!ignored(resolved)) sink.path(resolved, 'read', 'file', 'other')
    // The child's environment is an input where it comes from this process's: a value the call set
    // itself comes from the test's code, which is recorded already.
    for (const [n, v] of Object.entries(env)) {
      if (given !== undefined && unobserved(() => process.env[n]) !== v) continue
      sink.env(n, v, false, 'test')
    }
    const preload = env.LD_PRELOAD ? `${TRACE_LIBRARY}:${env.LD_PRELOAD}` : TRACE_LIBRARY
    // libuv can read files through io_uring, which the tracer cannot see.
    const childEnv = { ...env, LD_PRELOAD: preload, VEYRUM_TRACE: log, UV_USE_IO_URING: '0' }
    return call.rebuild({ ...call.options, env: childEnv })
  } finally {
    state.depth--
  }
}

/** Records what traced child processes did, as if the test had done it (see trace.ts). */
export function replayTrace(events: readonly TraceEvent[], sink: HookSink): void {
  state.depth++
  try {
    for (const e of events) {
      if (e.kind === 'untraceable') {
        sink.spawn(e.what)
      } else if (e.kind === 'net') {
        sink.net(e.host, e.port, e.host.startsWith('unix:') || LOOPBACK.test(e.host))
      } else if (!ignored(e.path)) {
        if (e.kind === 'write') {
          sink.write(e.path)
        } else if (e.kind === 'dir') {
          sink.path(e.path, 'dir', typeOf(e.path), 'other')
        } else {
          const type = e.present ? typeOf(e.path) : 'absent'
          // Opening a directory without listing it only shows that it exists.
          const kind = e.kind === 'stat' || type === 'dir' ? 'stat' : 'read'
          sink.path(e.path, kind, type, 'other')
        }
      }
    }
  } finally {
    state.depth--
  }
}

function installProcessHooks(): void {
  for (const name of [
    'spawn',
    'spawnSync',
    'exec',
    'execSync',
    'execFile',
    'execFileSync',
    'fork',
  ] as const) {
    wrap(childProcess, name, (a) => prepareSpawn(name, a))
  }
  const originalDlopen = process.dlopen
  process.dlopen = function (this: unknown, module: unknown, filename: string, ...rest: unknown[]) {
    try {
      state.sink.dlopen(path.resolve(filename))
    } catch {
      // Observation must never change behavior.
    }
    return (originalDlopen as AnyFn).call(this, module, filename, ...rest)
  } as typeof process.dlopen
}

/**
 * Callers whose use of function source text cannot change a test outcome through formatting:
 * Vitest parses a test callback's parameter list to find the fixtures it uses.
 */
const BENIGN_SOURCE_READERS = [/[\\/]@vitest[\\/]runner[\\/]/, /[\\/]vitest[\\/]dist[\\/]/]

function sourceReaderIsBenign(): boolean {
  const caller = callerFiles(6).find((file) => !file.startsWith(OWN_DIR)) ?? ''
  return BENIGN_SOURCE_READERS.some((re) => re.test(caller))
}

/**
 * Observes Function.prototype.toString in a realm. The worker's own realm is hooked by
 * installHooks; runners that evaluate tests in a vm context (Jest) hook that context's realm too,
 * because functions defined there inherit its Function.prototype.
 */
export function observeSourceIn(realmFunction: FunctionConstructor): void {
  const proto = realmFunction.prototype as unknown as Record<PropertyKey, unknown>
  if (proto[SOURCE_HOOK_KEY]) return
  const original = proto.toString as AnyFn
  // A Proxy keeps `Function.prototype.toString.toString()` looking native for feature detection.
  const proxy = new Proxy(original, {
    apply(target, thisArg, args) {
      const text = Reflect.apply(target, thisArg, args) as string
      if (recording() && !text.endsWith('[native code] }') && !sourceReaderIsBenign())
        state.sink.sourceObserved(text)
      return text
    },
  })
  Object.defineProperty(proto, 'toString', { value: proxy, writable: true, configurable: true })
  Object.defineProperty(proto, SOURCE_HOOK_KEY, { value: true })
}

const SOURCE_HOOK_KEY = Symbol.for('veyrum.capture.sourceHook')

export interface InstallOptions {
  /** Absolute repository root; its files are observed even when it lives in a temporary directory. */
  readonly root?: string
  /** Absolute path prefixes whose accesses are never recorded (the capture layer's own files). */
  readonly ignoredPrefixes?: readonly string[]
  /** Observe Function.prototype.toString (worker processes only). */
  readonly observeSource?: boolean
  /**
   * Callers (matched against stack frames) that read files to load them as modules. Their reads
   * are reported with `byRunner`, so a recorder can drop the ones for files that were then
   * compiled as modules (their content is recorded as a module) and keep the rest (JSON, assets).
   */
  readonly runnerReaders?: readonly RegExp[]
  /**
   * Callers (matched against any stack frame) that read package manifests only for module format,
   * resolution or their own configuration field, never for dependency version ranges or scripts.
   * Their reads of package.json are reported as `manifest`, to be compared as manifests.
   */
  readonly manifestReaders?: readonly RegExp[]
}

/** Installs every hook once per isolate. Subsequent calls only update ignored prefixes. */
export function installHooks(options: InstallOptions = {}): void {
  const tmp = [os.tmpdir(), safeRealpath(os.tmpdir())]
  state.tempPrefixes = [...new Set(tmp.map((t) => t + path.sep))]
  state.rootPrefix = options.root ? path.resolve(options.root) + path.sep : null
  state.ignoredPrefixes = [...new Set(['/proc/', '/dev/', '/sys/', ...(options.ignoredPrefixes ?? [])])]
  if (options.runnerReaders) state.runnerReaders = [...options.runnerReaders]
  if (options.manifestReaders) state.manifestReaders = [...options.manifestReaders]
  if (state.installed) return
  state.installed = true
  installFsHooks()
  installEnvProxy()
  installNetHooks()
  installProcessHooks()
  installWorkerThreadHook()
  if (options.observeSource) observeSourceIn(Function)
  syncBuiltinESMExports()
}

function safeRealpath(p: string): string {
  return unobserved(() => {
    try {
      return fs.realpathSync(p)
    } catch {
      return p
    }
  })
}
