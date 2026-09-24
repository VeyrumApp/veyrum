import type fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Child processes a test starts are traced by a preloaded library (native/trace.c) that logs the
 * files they open, check and list, what they execute and where they connect. Programs it cannot
 * follow, statically linked and Go ones, run under a ptrace tracer (native/exec.c) that writes the
 * same log. This module decides how a program runs and parses the log. Everything here runs with the capture
 * layer's hooks suspended, on the unpatched fs functions it is given.
 */

/** Built next to this module on Linux by scripts/build-native.mjs; absent elsewhere. */
export const TRACE_LIBRARY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'native',
  'libveyrum-trace.so',
)

export interface TraceFs {
  readonly statSync: typeof fs.statSync
  readonly openSync: typeof fs.openSync
  readonly readSync: typeof fs.readSync
  readonly closeSync: typeof fs.closeSync
}

/** The launcher that traces statically linked and Go programs with ptrace; built with the library. */
export const EXEC_LAUNCHER = path.join(path.dirname(TRACE_LIBRARY), 'veyrum-exec')

/** Where the tracer is built (scripts/build-native.mjs keeps the same list). */
export const TRACED_PLATFORMS: readonly string[] = ['linux-x64', 'linux-arm64']

let libraryPresent: boolean | undefined
export function tracingAvailable(raw: TraceFs): boolean {
  if (libraryPresent === undefined) {
    libraryPresent =
      TRACED_PLATFORMS.includes(`${process.platform}-${process.arch}`) &&
      raw.statSync(TRACE_LIBRARY, { throwIfNoEntry: false })?.isFile() === true
  }
  return libraryPresent
}

let launcherPresent: boolean | undefined
export function launcherAvailable(raw: TraceFs): boolean {
  if (launcherPresent === undefined) {
    launcherPresent =
      tracingAvailable(raw) && raw.statSync(EXEC_LAUNCHER, { throwIfNoEntry: false })?.isFile() === true
  }
  return launcherPresent
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

/** The program a spawn runs: the name itself when it has a slash, else the first match on PATH. */
export function resolveExecutable(
  file: string,
  pathVariable: string | undefined,
  cwd: string,
  raw: TraceFs,
): string | null {
  const isProgram = (candidate: string): boolean => {
    const st = raw.statSync(candidate, { throwIfNoEntry: false })
    return st?.isFile() === true && (st.mode & 0o111) !== 0
  }
  if (file.includes('/')) {
    const absolute = path.resolve(cwd, file)
    return isProgram(absolute) ? absolute : null
  }
  for (const dir of (pathVariable ?? '/usr/bin:/bin').split(':')) {
    const candidate = path.resolve(cwd, dir || '.', file)
    if (isProgram(candidate)) return candidate
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
