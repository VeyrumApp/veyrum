import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { exec } from '../src/exec.ts'

// The rig runs on Linux, where coreutils `timeout` bounds every command; macOS lacks it.
const hasTimeout = /coreutils/i.test(spawnSync('timeout', ['--version'], { encoding: 'utf8' }).stdout ?? '')

test.skipIf(hasTimeout)('without coreutils timeout the rig says so', () => {
  expect(() => exec('true', [], { cwd: process.cwd() })).toThrow(/needs coreutils `timeout`/)
})

describe.runIf(hasTimeout)('commands', () => {
  test('a grandchild left running does not keep the rig waiting, and is killed', () => {
    const started = Date.now()
    const r = exec('sh', ['-c', 'sleep 30 & echo $! ; echo done'], { cwd: process.cwd() })
    expect(Date.now() - started).toBeLessThan(10_000)
    const [pid, done] = r.stdout.trim().split('\n')
    expect(done).toBe('done')
    expect(() => process.kill(Number(pid), 0)).toThrow()
  })

  test('a command over its time limit is reported as timed out', () => {
    const r = exec('sleep', ['30'], { cwd: process.cwd(), timeoutMs: 1000 })
    expect(r.code).toBe(124)
    expect(r.signal).toBe('timeout')
    expect(r.ms).toBeLessThan(10_000)
  })
})
