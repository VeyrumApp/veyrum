import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { describe, expect, test } from 'vitest'
import { exec } from '../src/exec.ts'

// The rig runs on Linux, where coreutils `timeout` bounds every command; macOS lacks it.
const hasTimeout = /coreutils/i.test(spawnSync('timeout', ['--version'], { encoding: 'utf8' }).stdout ?? '')

test.skipIf(hasTimeout)('without coreutils timeout the rig says so', () => {
  expect(() => exec('true', [], { cwd: process.cwd() })).toThrow(/needs coreutils `timeout`/)
})

/**
 * Whether a process is gone, waiting a few seconds for it. A killed orphan stays a zombie until
 * init reaps it, and signal 0 still reaches a zombie: on Linux its state is read instead.
 */
function killed(pid: number): boolean {
  const deadline = Date.now() + 5000
  const pause = new Int32Array(new SharedArrayBuffer(4))
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (process.platform === 'linux') {
      let stat: string
      try {
        stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      } catch {
        return true
      }
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return true
    }
    Atomics.wait(pause, 0, 0, 50)
  }
  return false
}

describe.runIf(hasTimeout)('commands', () => {
  test('a grandchild left running does not keep the rig waiting, and is killed', () => {
    const started = Date.now()
    const r = exec('sh', ['-c', 'sleep 30 & echo $! ; echo done'], { cwd: process.cwd() })
    expect(Date.now() - started).toBeLessThan(10_000)
    const [pid, done] = r.stdout.trim().split('\n')
    expect(done).toBe('done')
    expect(killed(Number(pid))).toBe(true)
  })

  test('a command over its time limit is reported as timed out', () => {
    const r = exec('sleep', ['30'], { cwd: process.cwd(), timeoutMs: 1000 })
    expect(r.code).toBe(124)
    expect(r.signal).toBe('timeout')
    expect(r.ms).toBeLessThan(10_000)
  })
})
