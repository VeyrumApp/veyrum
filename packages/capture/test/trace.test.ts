import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { dynamicTool, staticTool } from '../../../test/support/programs.ts'
import { launchArguments, nativeTools, quoteWindowsArgument, windowsCommandLine } from '../src/trace.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-native-'))
  dirs.push(dir)
  return dir
}

/** A built package's native directory, with the launcher's mode as a package manager left it. */
function packaged(mode: number): { library: string; launcher: string } {
  const dir = tempDir()
  const library = path.join(dir, 'libveyrum-trace.so')
  const launcher = path.join(dir, 'veyrum-exec')
  fs.writeFileSync(library, 'library')
  fs.writeFileSync(launcher, 'launcher')
  fs.chmodSync(launcher, mode)
  return { library, launcher }
}

test.skipIf(process.platform === 'win32')('an executable launcher is used where it is', () => {
  const built = packaged(0o755)
  expect(nativeTools(tempDir(), built.library, built.launcher)).toEqual(built)
})

test.skipIf(process.platform === 'win32')(
  'a launcher packed without its executable bit is copied, with the library, and made executable',
  () => {
    const built = packaged(0o644)
    const run = tempDir()
    const tools = nativeTools(run, built.library, built.launcher)
    expect(path.dirname(tools.launcher!)).toBe(path.dirname(tools.library))
    expect(path.dirname(tools.launcher!).startsWith(run)).toBe(true)
    expect(fs.statSync(tools.launcher!).mode & 0o111).not.toBe(0)
    expect(fs.readFileSync(tools.library, 'utf8')).toBe('library')
    expect(fs.readFileSync(tools.launcher!, 'utf8')).toBe('launcher')
  },
)

/** The tracer as built for Linux (scripts/build-native.mjs); what the tests below run. */
const native = path.resolve(
  fileURLToPath(import.meta.url),
  `../../dist/native/${process.platform}-${process.arch}`,
)
const launcher = path.join(native, 'veyrum-exec')
const library = path.join(native, 'libveyrum-trace.so')
const linuxTracing = process.platform === 'linux' && fs.existsSync(launcher)
/** A statically linked program, which runs under the launcher, and a debugger-like one (`trace`). */
const tool = linuxTracing ? staticTool() : null
const tracer = linuxTracing ? dynamicTool() : null

function logLines(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}

/**
 * Runs a shell command, returning its output. The command sets the tracer's variables itself: a
 * test's capture replaces VEYRUM_TRACE in the environment of a process the test starts, but keeps
 * a value a traced process sets for its own children (a nested capture's log).
 */
function shell(command: string, cwd: string): string {
  return execFileSync('/bin/sh', ['-c', command], {
    cwd,
    env: { PATH: process.env.PATH ?? '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString()
}

describe.runIf(tool && tracer)('Linux: one ptrace tracer per process', () => {
  test("another build's launcher (a nested capture's) runs as it is, and traces what it runs", () => {
    const dir = fs.realpathSync(tempDir())
    // A copy is another file, as the launcher of another checkout of Veyrum is.
    const other = path.join(dir, 'other', 'veyrum-exec')
    fs.mkdirSync(path.dirname(other))
    fs.copyFileSync(launcher, other)
    fs.chmodSync(other, 0o755)
    fs.writeFileSync(path.join(dir, 'x.txt'), 'a')
    const outer = path.join(dir, 'outer.log')
    const inner = path.join(dir, 'inner.log')
    const out = shell(
      `LD_PRELOAD='${library}' VEYRUM_TRACE='${outer}' /bin/sh -c "VEYRUM_TRACE='${inner}' '${other}' '${tool}' tool read x.txt"`,
      dir,
    )
    expect(out).toBe('a')
    // For the shell's tracer, the launcher is a program it ran.
    expect(logLines(outer)).toContain(`x ${other}`)
    // The launcher traced its program into its own log, and none of its own calls are there.
    const lines = logLines(inner)
    expect(lines).toContain(`x ${tool}`)
    expect(lines).toContain(`r ${dir}/x.txt`)
    expect(lines.filter((line) => line.startsWith('u ') || line === 'w /dev/null')).toEqual([])
  })

  test('a static program a debugger starts runs as it is, untraced, and cannot be traced', () => {
    const dir = fs.realpathSync(tempDir())
    fs.writeFileSync(path.join(dir, 'x.txt'), 'a')
    const log = path.join(dir, 'trace.log')
    const out = shell(
      `LD_PRELOAD='${library}' VEYRUM_TRACE='${log}' '${tracer}' trace '${tool}' read x.txt`,
      dir,
    )
    // The debugger sees the program execute, and nothing else.
    expect(out).toBe(`exec ${path.basename(tool!)}\na`)
    expect(logLines(log)).toContain(`u ${tool}`)
  })

  test('the launcher under a debugger runs its program as it is, and records it as untraceable', () => {
    const dir = fs.realpathSync(tempDir())
    fs.writeFileSync(path.join(dir, 'x.txt'), 'a')
    const log = path.join(dir, 'trace.log')
    const out = shell(`VEYRUM_TRACE='${log}' '${tracer}' trace '${launcher}' '${tool}' tool read x.txt`, dir)
    expect(out).toBe(`exec veyrum-exec\nexec ${path.basename(tool!)}\na`)
    expect(logLines(log).filter((line) => line.startsWith('u '))).toEqual([`u ${tool}`])
  })

  test('what a traced program cannot do as it would untraced is recorded as untraceable', () => {
    const dir = fs.realpathSync(tempDir())
    const cases: [string, string][] = [
      // A process has one tracer: the program cannot trace its own child.
      [`trace '${tool}'`, 'u ptrace'],
      ['seccomp trace', 'u seccomp filter'],
      ['seccomp listen', 'u seccomp listener'],
    ]
    for (const [i, [args, line]] of cases.entries()) {
      const log = path.join(dir, `${i}.log`)
      shell(`VEYRUM_TRACE='${log}' '${launcher}' '${tool}' tool ${args}`, dir)
      expect(logLines(log), args).toContain(line)
    }
    // Nor can a debugger attach to a program the launcher traces.
    const log = path.join(dir, 'attach.log')
    expect(shell(`LD_PRELOAD='${library}' VEYRUM_TRACE='${log}' '${tracer}' attach '${tool}'`, dir)).toBe(
      'refused\n',
    )
    expect(logLines(log)).toContain('u ptrace')
  })
})

test('without a launcher, there is none', () => {
  const built = packaged(0o644)
  fs.rmSync(built.launcher)
  expect(nativeTools(tempDir(), built.library, built.launcher)).toEqual({
    library: built.library,
    launcher: null,
  })
})

// Node's own quoting (libuv's quote_cmd_arg), which the Windows launcher must receive unchanged.
test('Windows arguments are quoted as Node quotes them', () => {
  const cases: [string, string][] = [
    ['', '""'],
    ['plain', 'plain'],
    ['a b', '"a b"'],
    ['C:\\dir\\file', 'C:\\dir\\file'],
    ['C:\\Program Files\\x.exe', '"C:\\Program Files\\x.exe"'],
    ['hello"world', '"hello\\"world"'],
    ['hello""world', '"hello\\"\\"world"'],
    ['hello\\"world', '"hello\\\\\\"world"'],
    ['hello\\\\"world', '"hello\\\\\\\\\\"world"'],
    ['hello world\\', '"hello world\\\\"'],
  ]
  for (const [arg, quoted] of cases) expect(quoteWindowsArgument(arg), arg).toBe(quoted)
  expect(windowsCommandLine(['node', '-e', 'a b'], false)).toBe('node -e "a b"')
  expect(windowsCommandLine(['cmd.exe', '/d', '/s', '/c', '"echo a b"'], true)).toBe(
    'cmd.exe /d /s /c "echo a b"',
  )
})

test('the launcher gets the program, quoted when it has spaces, and the command line as is', () => {
  expect(launchArguments('C:\\Program Files\\x.exe', 'x "a b"')).toEqual([
    '"C:\\Program Files\\x.exe"',
    'x "a b"',
  ])
  expect(launchArguments('C:\\bin\\x.exe', 'x')).toEqual(['C:\\bin\\x.exe', 'x'])
})
