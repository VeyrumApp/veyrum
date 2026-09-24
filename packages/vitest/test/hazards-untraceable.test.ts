import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox } from '../../../test/support/sandbox.ts'
import { TRACED_PLATFORMS } from '../../capture/src/trace.ts'

/**
 * Programs child-process tracing cannot follow: statically linked and Go programs run under ptrace
 * (hazards-launched.test.ts), but not a program for another machine. Kept apart from the other
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

// ELF programs and POSIX shell commands: Linux only (Windows: hazards-windows.test.ts).
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
