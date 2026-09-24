import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { dynamicTool, install, staticTool } from '../../../test/support/programs.ts'
import { Sandbox } from '../../../test/support/sandbox.ts'
import { TRACED_PLATFORMS } from '../../capture/src/trace.ts'

/**
 * Programs child-process tracing cannot follow: statically linked and Go programs run under ptrace
 * (hazards-launched.test.ts), but not a program for another machine, nor one that already has a
 * ptrace tracer (a debugger's) or does what only an untraced program can. Kept apart from the other
 * runner scenarios: the program this starts cannot be traced when Veyrum runs its own suite
 * either, which would keep the file holding it from ever being reused.
 */

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

/** A minimal ELF executable for another machine (32-bit Arm): nothing here can trace it. */
function writeForeignProgram(dir: string, rel: string): void {
  const elf = Buffer.alloc(64)
  elf.write('\x7fELF', 0, 'latin1')
  elf[4] = 2 // 64-bit
  elf[5] = 1 // little endian
  elf[6] = 1
  elf.writeUInt16LE(2, 16) // executable
  elf.writeUInt16LE(0x28, 18) // 32-bit Arm
  elf.writeUInt32LE(1, 20)
  elf.writeBigUInt64LE(64n, 32) // program headers (none)
  elf.writeUInt16LE(64, 52)
  elf.writeUInt16LE(56, 54)
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, elf, { mode: 0o755 })
}

// ELF programs and POSIX shell commands: Linux only; an ELF program is foreign on macOS too, where
// the kernel refuses to run it at all (Windows: hazards-windows.test.ts).
const tracing =
  process.platform === 'linux' && TRACED_PLATFORMS.includes(`${process.platform}-${process.arch}`)

describe.runIf(tracing)('programs that cannot be traced', () => {
  const spawnTest = (body: string): string =>
    `import { execFileSync, execSync } from 'node:child_process'\nimport { expect, test } from 'vitest'\ntest('child', () => {\n${body}\n})\n`

  test('a program that cannot be traced blocks reuse, started directly or by a traced one', () => {
    sandbox = new Sandbox('child-foreign')
      .write(
        'test/direct.test.ts',
        spawnTest("  try { execFileSync('./fixtures/foreign') } catch {}\n  expect(1).toBe(1)"),
      )
      .write(
        'test/nested.test.ts',
        spawnTest("  execSync('./fixtures/foreign 2>/dev/null || true')\n  expect(1).toBe(1)"),
      )
    writeForeignProgram(sandbox.dir, 'fixtures/foreign')
    sandbox.capture()
    const plan = sandbox.plan()
    expect(plan['test/direct.test.ts']?.reason).toBe('blocked-flag')
    expect(plan['test/nested.test.ts']?.reason).toBe('blocked-flag')
    expect(plan['test/nested.test.ts']?.details[0]).toMatch(/spawn \(.*fixtures\/foreign\)$/)
  })
})

/** A statically linked program (run under Veyrum's ptrace tracer) and a debugger-like one. */
const tool = tracing ? staticTool() : null
const debuggerTool = tracing ? dynamicTool() : null

// A process has one ptrace tracer.
describe.runIf(tracing && tool && debuggerTool)('programs and ptrace', () => {
  const spawnTest = (body: string): string =>
    `import { execFileSync } from 'node:child_process'\nimport { expect, test } from 'vitest'\ntest('child', () => {\n${body}\n})\n`

  test('a program a debugger starts runs as it would, untraced, and blocks reuse', () => {
    sandbox = new Sandbox('child-debugger')
      .write('fixtures/x.txt', 'a')
      .write(
        'test/child.test.ts',
        spawnTest(
          "  const out = execFileSync('./fixtures/debugger', ['trace', './fixtures/tool', 'read', 'fixtures/x.txt'])\n  expect(out.toString()).toBe('exec tool\\na')",
        ),
      )
    install(debuggerTool!, sandbox.dir, 'fixtures/debugger')
    install(tool!, sandbox.dir, 'fixtures/tool')
    sandbox.capture()
    const decision = sandbox.plan()['test/child.test.ts']
    expect(decision?.reason).toBe('blocked-flag')
    expect(decision?.details[0]).toMatch(/spawn \(.*fixtures\/tool\)$/)
  })

  test('what a traced program cannot do as it would untraced blocks reuse', () => {
    // Tracing its own child, being attached to by a debugger, and seccomp filters that stop calls
    // for a tracer or a supervisor. Each program still runs; what it prints may differ.
    const cases = {
      traceme: "'./fixtures/tool', ['trace', './fixtures/tool']",
      attach: "'./fixtures/debugger', ['attach', './fixtures/tool']",
      filter: "'./fixtures/tool', ['seccomp', 'trace']",
      listener: "'./fixtures/tool', ['seccomp', 'listen']",
    }
    sandbox = new Sandbox('child-ptrace')
    for (const [name, call] of Object.entries(cases))
      sandbox.write(`test/${name}.test.ts`, spawnTest(`  execFileSync(${call})\n  expect(1).toBe(1)`))
    install(debuggerTool!, sandbox.dir, 'fixtures/debugger')
    install(tool!, sandbox.dir, 'fixtures/tool')
    sandbox.capture()
    const plan = sandbox.plan()
    const blocked = (name: string) => [
      plan[`test/${name}.test.ts`]?.reason,
      plan[`test/${name}.test.ts`]?.details[0],
    ]
    expect(blocked('traceme')).toEqual(['blocked-flag', expect.stringMatching(/spawn \(ptrace\)$/)])
    expect(blocked('attach')).toEqual(['blocked-flag', expect.stringMatching(/spawn \(ptrace\)$/)])
    expect(blocked('filter')).toEqual(['blocked-flag', expect.stringMatching(/spawn \(seccomp filter\)$/)])
    expect(blocked('listener')).toEqual([
      'blocked-flag',
      expect.stringMatching(/spawn \(seccomp listener\)$/),
    ])
  })
})
