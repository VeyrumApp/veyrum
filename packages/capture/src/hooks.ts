import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type PathKind = 'read' | 'stat' | 'dir'
export type PathType = 'file' | 'dir' | 'other' | 'absent'

/** Receives observations from the hooks. Swapped per test file by the runner adapter. */
export interface HookSink {
  path(absolute: string, kind: PathKind, type: PathType): void
  write(absolute: string): void
  env(name: string, value: string | undefined): void
  envEnumerated(): void
  envWrite(name: string): void
  net(host: string, port: number | undefined, local: boolean): void
  spawn(command: string): void
  dlopen(absolute: string): void
  sourceObserved(): void
}

const noop: HookSink = {
  path() {},
  write() {},
  env() {},
  envEnumerated() {},
  envWrite() {},
  net() {},
  spawn() {},
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
  ignoredPrefixes: string[]
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

function toAbsolute(p: unknown): string | null {
  if (typeof p === 'string') return path.resolve(p)
  if (p instanceof URL) return p.protocol === 'file:' ? fileURLToPath(p) : null
  if (Buffer.isBuffer(p)) return path.resolve(p.toString('utf8'))
  return null
}

function ignored(absolute: string): boolean {
  for (const prefix of state.ignoredPrefixes) if (absolute.startsWith(prefix)) return true
  return false
}

function observePath(p: unknown, kind: PathKind): void {
  if (state.depth > 0) return
  const absolute = toAbsolute(p)
  if (!absolute || ignored(absolute)) return
  state.depth++
  try {
    state.sink.path(absolute, kind, typeOf(absolute))
  } finally {
    state.depth--
  }
}

function observeWrite(p: unknown): void {
  if (state.depth > 0) return
  const absolute = toAbsolute(p)
  if (!absolute || ignored(absolute)) return
  state.sink.write(absolute)
}

type AnyFn = (...args: any[]) => any

function wrap(target: any, name: string, before: (args: any[]) => void): void {
  const original = target[name] as AnyFn | undefined
  if (typeof original !== 'function') return
  const wrapped = function (this: unknown, ...args: any[]) {
    try {
      before(args)
    } catch {
      // Observation must never change behavior.
    }
    return original.apply(this, args)
  }
  Object.defineProperty(wrapped, 'name', { value: original.name })
  Object.defineProperty(wrapped, 'length', { value: original.length })
  for (const key of Object.keys(original)) (wrapped as any)[key] = (original as any)[key]
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

function installEnvProxy(): void {
  const real = process.env
  if ((real as any)[STATE_KEY]) return
  const proxy = new Proxy(real, {
    get(target, key, receiver) {
      if (key === STATE_KEY) return true
      const value = Reflect.get(target, key, receiver)
      if (typeof key === 'string' && state.depth === 0)
        state.sink.env(key, typeof value === 'string' ? value : undefined)
      return value
    },
    has(target, key) {
      const present = Reflect.has(target, key)
      if (typeof key === 'string' && state.depth === 0) state.sink.env(key, present ? target[key] : undefined)
      return present
    },
    getOwnPropertyDescriptor(target, key) {
      const desc = Reflect.getOwnPropertyDescriptor(target, key)
      if (typeof key === 'string' && state.depth === 0)
        state.sink.env(key, desc ? String(desc.value) : undefined)
      return desc
    },
    ownKeys(target) {
      if (state.depth === 0) state.sink.envEnumerated()
      return Reflect.ownKeys(target)
    },
    set(target, key, value) {
      if (typeof key === 'string' && state.depth === 0) state.sink.envWrite(key)
      ;(target as any)[key] = value
      return true
    },
    deleteProperty(target, key) {
      if (typeof key === 'string' && state.depth === 0) state.sink.envWrite(key)
      return Reflect.deleteProperty(target, key)
    },
  })
  process.env = proxy
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
    wrap(childProcess, name, (a) => state.sink.spawn(String(a[0]).split(/\s+/)[0] ?? ''))
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
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 4
  const stack = new Error().stack ?? ''
  Error.stackTraceLimit = limit
  // Frames: Error, the proxy trap, then the caller.
  const caller = stack.split('\n')[3] ?? ''
  return BENIGN_SOURCE_READERS.some((re) => re.test(caller))
}

function installToStringHook(): void {
  const original = Function.prototype.toString
  // A Proxy keeps `Function.prototype.toString.toString()` looking native for feature detection.
  const proxy = new Proxy(original, {
    apply(target, thisArg, args) {
      const text = Reflect.apply(target, thisArg, args) as string
      if (state.depth === 0 && !text.endsWith('[native code] }') && !sourceReaderIsBenign())
        state.sink.sourceObserved()
      return text
    },
  })
  Object.defineProperty(Function.prototype, 'toString', { value: proxy, writable: true, configurable: true })
}

export interface InstallOptions {
  /** Absolute path prefixes whose accesses are never recorded (the capture layer's own files). */
  readonly ignoredPrefixes?: readonly string[]
  /** Observe Function.prototype.toString (worker processes only). */
  readonly observeSource?: boolean
}

/** Installs every hook once per isolate. Subsequent calls only update ignored prefixes. */
export function installHooks(options: InstallOptions = {}): void {
  const tmp = [os.tmpdir(), safeRealpath(os.tmpdir())]
  state.ignoredPrefixes = [
    ...new Set([
      ...tmp.map((t) => t + path.sep),
      '/proc/',
      '/dev/',
      '/sys/',
      ...(options.ignoredPrefixes ?? []),
    ]),
  ]
  if (state.installed) return
  state.installed = true
  installFsHooks()
  installEnvProxy()
  installNetHooks()
  installProcessHooks()
  if (options.observeSource) installToStringHook()
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
