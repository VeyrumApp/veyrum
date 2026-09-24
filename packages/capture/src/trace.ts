import type fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Child processes a test starts are traced by a preloaded library (native/trace.c) that logs the
 * files they open, check and list, what they execute and where they connect. This module decides
 * whether a program can be traced and parses the log. Everything here runs with the capture
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

const PT_INTERP = 3
const MAX_SHEBANG_DEPTH = 4
const traceableCache = new Map<string, { key: string; value: boolean }>()

/**
 * Whether a program can be traced: a dynamically linked 64-bit ELF file that is not a Go program
 * (Go makes system calls directly), or a script whose interpreter can be. Must match `traceable`
 * in native/trace.c, which applies the same rule to everything a traced process executes.
 */
export function executableTraceable(file: string, raw: TraceFs, depth = 0): boolean {
  if (depth > MAX_SHEBANG_DEPTH) return false
  const st = raw.statSync(file, { throwIfNoEntry: false })
  if (!st?.isFile()) return false
  const key = `${st.size}:${st.mtimeMs}:${st.ino}`
  const cached = traceableCache.get(file)
  if (cached?.key === key) return cached.value
  let value = false
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
      value = interpreter.startsWith('/') && executableTraceable(interpreter, raw, depth + 1)
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
      value = dynamic && !go
    }
  } catch {
    value = false
  } finally {
    if (fd !== undefined) raw.closeSync(fd)
  }
  traceableCache.set(file, { key, value })
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
