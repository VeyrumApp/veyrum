import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { threadId } from 'node:worker_threads'

/**
 * Child processes a test starts are traced by a preloaded library (native/trace.c) that logs the
 * files they open, check and list, what they execute and where they connect. Programs it cannot
 * follow, statically linked and Go ones, run under a ptrace tracer (native/exec.c) that writes the
 * same log. This module decides how a program runs and parses the log. Everything here runs with the capture
 * layer's hooks suspended, on the unpatched fs functions it is given.
 */

/**
 * Built per platform by scripts/build-native.mjs into native/<platform>-<arch>/ next to this
 * module (a published package carries every platform's); absent where tracing is not built.
 */
export const NATIVE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'native',
  `${process.platform}-${process.arch}`,
)
export const TRACE_LIBRARY = path.join(NATIVE_DIR, 'libveyrum-trace.so')

/** Preloaded into Node programs and worker threads no native tracer follows (see child.ts). */
export const CHILD_PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'child-preload.cjs')

/** The launcher that traces statically linked and Go programs with ptrace; built with the library. */
export const EXEC_LAUNCHER = path.join(NATIVE_DIR, 'veyrum-exec')

export interface TraceFs {
  readonly statSync: typeof fs.statSync
  readonly openSync: typeof fs.openSync
  readonly readSync: typeof fs.readSync
  readonly closeSync: typeof fs.closeSync
}

/** Where the tracer is built (scripts/build-native.mjs keeps the same list). */
export const TRACED_PLATFORMS: readonly string[] = ['linux-x64', 'linux-arm64']

let libraryPresent: boolean | undefined
/**
 * Whether native tracing (the preloaded library, and veyrum-exec) follows child processes here.
 * VEYRUM_NATIVE_TRACING=off turns it off: Node programs are then traced with capture's own hooks,
 * as on platforms without it, and any other program blocks reuse.
 */
export function tracingAvailable(raw: TraceFs): boolean {
  if (process.env.VEYRUM_NATIVE_TRACING === 'off') return false
  if (libraryPresent === undefined) {
    libraryPresent =
      TRACED_PLATFORMS.includes(`${process.platform}-${process.arch}`) &&
      raw.statSync(TRACE_LIBRARY, { throwIfNoEntry: false })?.isFile() === true &&
      libraryLoads()
  }
  return libraryPresent
}

/**
 * Whether the dynamic loader here loads the library: one built against a newer C library than the
 * system's is skipped with a warning, and its children would then run unobserved. Its constructor
 * creates the log, so a trivial traced program shows whether it loaded.
 */
function libraryLoads(): boolean {
  const log = path.join(os.tmpdir(), `veyrum-probe-${process.pid}-${threadId}-${Date.now()}.log`)
  try {
    const shell = fs.existsSync('/bin/sh') ? '/bin/sh' : process.execPath
    childProcess.spawnSync(shell, shell === '/bin/sh' ? ['-c', ':'] : ['-e', '0'], {
      env: { PATH: process.env.PATH ?? '', LD_PRELOAD: TRACE_LIBRARY, VEYRUM_TRACE: log },
      stdio: 'ignore',
      timeout: 10_000,
    })
    return fs.existsSync(log)
  } catch {
    return false
  } finally {
    fs.rmSync(log, { force: true })
  }
}

export interface NativeTools {
  /** The preloaded library. */
  readonly library: string
  /** veyrum-exec, next to the library, or null when it cannot run. */
  readonly launcher: string | null
}

const toolsByDir = new Map<string, NativeTools>()

/**
 * The tracer's files as a run uses them. npm and pnpm pack files without their executable bit,
 * which the launcher needs: without it, the launcher and the library it is found next to are
 * copied into `dir` (a directory of the run's own) and used from there. Call with the capture
 * layer's hooks suspended.
 */
export function nativeTools(dir: string, library = TRACE_LIBRARY, launcher = EXEC_LAUNCHER): NativeTools {
  const cached = toolsByDir.get(dir)
  if (cached) return cached
  let tools: NativeTools = { library, launcher: null }
  const st = fs.statSync(launcher, { throwIfNoEntry: false })
  if (st?.isFile() && (st.mode & 0o111) !== 0) {
    tools = { library, launcher }
  } else if (st?.isFile()) {
    try {
      const target = path.join(dir, 'native')
      fs.mkdirSync(target, { recursive: true })
      // Workers of one run share the copies: each is written under its own name, then renamed.
      const place = (from: string, mode: number): string => {
        const to = path.join(target, path.basename(from))
        if (fs.statSync(to, { throwIfNoEntry: false })?.size !== fs.statSync(from).size) {
          const temporary = `${to}.${process.pid}-${threadId}`
          fs.copyFileSync(from, temporary)
          fs.chmodSync(temporary, mode)
          fs.renameSync(temporary, to)
        }
        return to
      }
      tools = { library: place(library, 0o644), launcher: place(launcher, 0o755) }
    } catch {
      // Without a launcher, static and Go programs block reuse.
    }
  }
  toolsByDir.set(dir, tools)
  return tools
}

/**
 * How a program runs under capture: traced by the preloaded library, launched under the ptrace
 * tracer, or not followed at all.
 */
export type ExecutableKind = 'traced' | 'launched' | 'untraceable'

const PT_INTERP = 3
const MAX_SHEBANG_DEPTH = 4
/** ELF machine numbers of the platforms tracing is built for. */
const NATIVE_MACHINE: Readonly<Record<string, number>> = { x64: 0x3e, arm64: 0xb7 }
const kindCache = new Map<string, { key: string; value: ExecutableKind }>()

/**
 * How a program runs: a dynamically linked 64-bit ELF file that is not a Go program is traced by
 * the preloaded library; a statically linked or Go program for this machine (Go makes system calls
 * directly) runs under the ptrace tracer; a script runs as its interpreter would. Must match
 * `classify` in native/trace.c, which applies the same rule to everything a traced process runs.
 */
export function classifyExecutable(file: string, raw: TraceFs, depth = 0): ExecutableKind {
  if (depth > MAX_SHEBANG_DEPTH) return 'untraceable'
  const st = raw.statSync(file, { throwIfNoEntry: false })
  if (!st?.isFile()) return 'untraceable'
  const key = `${st.size}:${st.mtimeMs}:${st.ino}`
  const cached = kindCache.get(file)
  if (cached?.key === key) return cached.value
  let value: ExecutableKind = 'untraceable'
  let fd: number | undefined
  try {
    fd = raw.openSync(file, 'r')
    const readAt = (length: number, position: number): Buffer => {
      const buf = Buffer.alloc(length)
      const n = raw.readSync(fd!, buf, 0, length, position)
      return buf.subarray(0, n)
    }
    const head = readAt(256, 0)
    if (head[0] === 0x23 && head[1] === 0x21) {
      const line = head.subarray(2).toString('latin1').split('\n')[0]!.trim()
      const interpreter = line.split(/[ \t]/)[0] ?? ''
      value = interpreter.startsWith('/') ? classifyExecutable(interpreter, raw, depth + 1) : 'untraceable'
    } else if (
      head.length >= 64 &&
      head.readUInt32BE(0) === 0x7f454c46 &&
      head[4] === 2 /* ELFCLASS64 */ &&
      head[5] === 1 /* little endian */
    ) {
      const phoff = Number(head.readBigUInt64LE(32))
      const shoff = Number(head.readBigUInt64LE(40))
      const phentsize = head.readUInt16LE(54)
      const phnum = head.readUInt16LE(56)
      const shentsize = head.readUInt16LE(58)
      const shnum = head.readUInt16LE(60)
      const shstrndx = head.readUInt16LE(62)
      let dynamic = false
      const phdrs = readAt(phentsize * Math.min(phnum, 512), phoff)
      for (let i = 0; i + 4 <= phdrs.length; i += phentsize)
        if (phdrs.readUInt32LE(i) === PT_INTERP) dynamic = true
      let go = false
      if (dynamic && shoff > 0 && shstrndx < shnum && shnum <= 4096) {
        const strtab = readAt(shentsize, shoff + shstrndx * shentsize)
        if (strtab.length >= 40) {
          const offset = Number(strtab.readBigUInt64LE(24))
          const size = Math.min(Number(strtab.readBigUInt64LE(32)), 1 << 16)
          const names = readAt(size, offset).toString('latin1')
          go = names.includes('.go.buildinfo') || names.includes('.note.go.buildid')
        }
      }
      if (dynamic && !go) value = 'traced'
      else if (head.readUInt16LE(18) === NATIVE_MACHINE[process.arch]) value = 'launched'
    }
  } catch {
    value = 'untraceable'
  } finally {
    if (fd !== undefined) raw.closeSync(fd)
  }
  kindCache.set(file, { key, value })
  return value
}

/** A variable of a child's environment; Windows names them case-insensitively. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== 'win32' || name in env) return env[name]
  const upper = name.toUpperCase()
  for (const key of Object.keys(env)) if (key.toUpperCase() === upper) return env[key]
  return undefined
}

/**
 * The files a spawn would try for a program, in order, as Node's spawn looks them up: on POSIX,
 * the name itself when it has a slash, else each PATH directory; on Windows (libuv), the current
 * directory and then PATH, each name as given when it has an extension, else with .com and .exe.
 */
export function executableCandidates(file: string, pathVariable: string | undefined, cwd: string): string[] {
  if (process.platform !== 'win32') {
    if (file.includes('/')) return [path.resolve(cwd, file)]
    return (pathVariable ?? '/usr/bin:/bin').split(':').map((dir) => path.resolve(cwd, dir || '.', file))
  }
  const names = path.extname(file) ? [file] : [`${file}.com`, `${file}.exe`]
  const dirs = /[\\/]/.test(file) ? [cwd] : [cwd, ...(pathVariable ?? '').split(';').filter(Boolean)]
  return dirs.flatMap((dir) => names.map((name) => path.resolve(cwd, dir, name)))
}

/** The program a spawn runs: the first candidate that is a program, or null when none is. */
export function resolveExecutable(
  file: string,
  pathVariable: string | undefined,
  cwd: string,
  raw: TraceFs,
): string | null {
  for (const candidate of executableCandidates(file, pathVariable, cwd)) {
    const st = raw.statSync(candidate, { throwIfNoEntry: false })
    // Windows has no executable bit: a file found there runs.
    if (st?.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0)) return candidate
  }
  return null
}

/**
 * How a program is this Node itself, for tracing it with capture's own hooks: the same binary, or
 * (POSIX) a script whose `#!` line runs it, directly or through `/usr/bin/env node`. Null for
 * anything else, including another Node, which may not take the flags the tracer adds.
 */
export type NodeProgram =
  | { readonly kind: 'binary' }
  | { readonly kind: 'script'; readonly interpreterLookup: readonly string[] }

export function nodeProgram(
  resolved: string,
  pathVariable: string | undefined,
  cwd: string,
  raw: TraceFs & { readonly realpathSync: (p: string) => string },
): NodeProgram | null {
  const real = (p: string): string | null => {
    try {
      return raw.realpathSync(p)
    } catch {
      return null
    }
  }
  const self = real(process.execPath)
  if (self !== null && real(resolved) === self) return { kind: 'binary' }
  if (process.platform === 'win32') return null
  let line = ''
  let fd: number | undefined
  try {
    fd = raw.openSync(resolved, 'r')
    const head = Buffer.alloc(256)
    const n = raw.readSync(fd, head, 0, head.length, 0)
    line = head.subarray(0, n).toString('latin1').split('\n')[0] ?? ''
  } catch {
    return null
  } finally {
    if (fd !== undefined) raw.closeSync(fd)
  }
  if (!line.startsWith('#!')) return null
  const words = line
    .slice(2)
    .trim()
    .split(/[ \t]+/)
  if (words.length === 1 && self !== null && real(words[0]!) === self)
    return { kind: 'script', interpreterLookup: [] }
  if (words.length === 2 && words[0] === '/usr/bin/env' && words[1] === 'node') {
    // env looks node up on PATH: the directories before the match are inputs (absent), like a
    // program's own lookup.
    const candidates = executableCandidates('node', pathVariable, cwd)
    const found = resolveExecutable('node', pathVariable, cwd, raw)
    if (found === null || real(found) !== self) return null
    return { kind: 'script', interpreterLookup: candidates.slice(0, candidates.indexOf(found)) }
  }
  return null
}

export type TraceEvent =
  | {
      readonly kind: 'read' | 'stat' | 'dir' | 'write' | 'exec'
      readonly path: string
      readonly present: boolean
    }
  | { readonly kind: 'untraceable'; readonly what: string }
  | { readonly kind: 'net'; readonly host: string; readonly port: number | undefined }

/** Parses a trace log (see native/trace.c for the format). Paths come back resolved. */
export function parseTrace(text: string): TraceEvent[] {
  const out: TraceEvent[] = []
  for (const line of text.split('\n')) {
    if (line.length < 3 || line[1] !== ' ') continue
    const rest = line.slice(2)
    switch (line[0]) {
      case 'r':
      case 'R':
        out.push({ kind: 'read', path: path.resolve(rest), present: line[0] === 'r' })
        break
      case 's':
      case 'S':
        out.push({ kind: 'stat', path: path.resolve(rest), present: line[0] === 's' })
        break
      case 'd':
        out.push({ kind: 'dir', path: path.resolve(rest), present: true })
        break
      case 'w':
        out.push({ kind: 'write', path: path.resolve(rest), present: true })
        break
      case 'x':
        out.push({ kind: 'exec', path: path.resolve(rest), present: true })
        break
      case 'n': {
        const space = rest.lastIndexOf(' ')
        const port = Number(rest.slice(space + 1))
        out.push({ kind: 'net', host: rest.slice(0, space), port: port > 0 ? port : undefined })
        break
      }
      default:
        out.push({ kind: 'untraceable', what: rest })
    }
  }
  return out
}
