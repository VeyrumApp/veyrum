import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox } from './sandbox.ts'

/** Runner behavior and unobservable channels: when a pass must not be treated as evidence. */

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

const PLAIN_TEST = "import { expect, test } from 'vitest'\ntest('plain', () => expect(1).toBe(1))\n"

describe('verdicts', () => {
  test('a failing test file always runs', () => {
    sandbox = new Sandbox('failing')
      .write(
        'test/fail.test.ts',
        "import { expect, test } from 'vitest'\ntest('fails', () => expect(1).toBe(2))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    const result = sandbox.cli(['run', '--full'])
    expect(result.code).toBe(1)
    expect(sandbox.actions()).toEqual({ 'test/fail.test.ts': 'run', 'test/plain.test.ts': 'skip' })
  })

  test('a pass that needed a retry is not evidence', () => {
    sandbox = new Sandbox('flaky').write(
      'test/flaky.test.ts',
      "import { expect, test } from 'vitest'\nlet attempts = 0\ntest('flaky', { retry: 1 }, () => {\n  attempts++\n  expect(attempts).toBe(2)\n})\n",
    )
    sandbox.capture()
    const decision = sandbox.plan()['test/flaky.test.ts']
    expect(decision?.action).toBe('run')
    expect(decision?.reason).toBe('not-reusable')
  })

  test('snapshots that record source positions make formatting observable', () => {
    sandbox = new Sandbox('positions')
      .write('src/thrower.ts', 'export function boom(): never {\n  throw new Error("boom")\n}\n')
      .write(
        'test/stack.test.ts',
        "import { expect, test } from 'vitest'\nimport { boom } from '../src/thrower'\ntest('stack', () => {\n  try {\n    boom()\n  } catch (e) {\n    const frame = String((e as Error).stack).split('\\n').find((l) => l.includes('thrower')) ?? ''\n    expect(frame.replace(/^.*src\\//, 'src/').replace(/\\)$/, '')).toMatchSnapshot()\n  }\n})\n",
      )
    sandbox.capture()
    sandbox.capture()
    expect(sandbox.actions()['test/stack.test.ts']).toBe('skip')
    sandbox.edit('src/thrower.ts', 'export function boom', '// moved down one line\nexport function boom')
    expect(sandbox.actions()['test/stack.test.ts']).toBe('run')
  })
})

describe('evidence store placement', () => {
  test('a store in a parent directory of the project does not hide the project', () => {
    sandbox = new Sandbox('store-above')
      .write('src/a.ts', 'export function a(): number {\n  return 1\n}\n')
      .write(
        'test/a.test.ts',
        "import { expect, test } from 'vitest'\nimport { a } from '../src/a'\ntest('a', () => expect(a()).toBe(1))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    const store = path.join(path.dirname(sandbox.dir), `${path.basename(sandbox.dir)}.sqlite`)
    try {
      const captured = sandbox.cli(['run', '--full', '--store', store])
      expect(captured.code).toBe(0)
      const plan = () =>
        Object.fromEntries(
          sandbox!.cli(['plan', '--store', store]).decisions.map((d) => [d.check.path, d.action]),
        )
      expect(plan()).toEqual({ 'test/a.test.ts': 'skip', 'test/plain.test.ts': 'skip' })
      sandbox.edit('src/a.ts', 'return 1', 'return 2')
      expect(plan()).toEqual({ 'test/a.test.ts': 'run', 'test/plain.test.ts': 'skip' })
    } finally {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${store}${suffix}`, { force: true })
    }
  })
})

describe('unobservable channels', () => {
  test('spawning a process blocks reuse', () => {
    sandbox = new Sandbox('spawn')
      .write(
        'test/spawn.test.ts',
        "import { execFileSync } from 'node:child_process'\nimport { expect, test } from 'vitest'\ntest('spawn', () => expect(execFileSync(process.execPath, ['-e', 'process.stdout.write(\"ok\")']).toString()).toBe('ok'))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    const plan = sandbox.plan()
    expect(plan['test/spawn.test.ts']?.action).toBe('run')
    expect(plan['test/spawn.test.ts']?.reason).toBe('blocked-flag')
    expect(plan['test/plain.test.ts']?.action).toBe('skip')
  })

  test('a remote connection blocks reuse; a loopback server does not', () => {
    sandbox = new Sandbox('network')
      .write(
        'test/remote.test.ts',
        "import net from 'node:net'\nimport { test } from 'vitest'\ntest('remote', () => {\n  const socket = net.connect({ host: '203.0.113.1', port: 9 })\n  socket.on('error', () => {})\n  socket.destroy()\n})\n",
      )
      .write(
        'test/local.test.ts',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source code with its own template literal
        "import http from 'node:http'\nimport { expect, test } from 'vitest'\ntest('local', async () => {\n  const server = http.createServer((_, res) => res.end('hi'))\n  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))\n  const { port } = server.address() as { port: number }\n  const body = await (await fetch(`http://127.0.0.1:${port}/`)).text()\n  server.close()\n  expect(body).toBe('hi')\n})\n",
      )
    sandbox.capture()
    const plan = sandbox.plan()
    expect(plan['test/remote.test.ts']?.action).toBe('run')
    expect(plan['test/local.test.ts']?.action).toBe('skip')
    expect(plan['test/local.test.ts']?.flagsRelied).toContain('net-local')
  })

  test('files sharing a worker (isolation off) are never reused', () => {
    sandbox = new Sandbox('no-isolate')
      .write(
        'vitest.config.ts',
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { isolate: false } })\n",
      )
      .write('test/a.test.ts', PLAIN_TEST)
      .write('test/b.test.ts', PLAIN_TEST)
    sandbox.capture()
    expect(Object.values(sandbox.actions())).toEqual(['run', 'run'])
  })

  test('the threads pool isolates files and is reusable', () => {
    sandbox = new Sandbox('threads')
      .write(
        'vitest.config.ts',
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { pool: 'threads' } })\n",
      )
      .write('src/a.ts', 'export const a = 1\n')
      .write('src/b.ts', 'export const b = 2\n')
      .write(
        'test/a.test.ts',
        "import { expect, test } from 'vitest'\nimport { a } from '../src/a'\ntest('a', () => expect(a).toBe(1))\n",
      )
      .write(
        'test/b.test.ts',
        "import { expect, test } from 'vitest'\nimport { b } from '../src/b'\ntest('b', () => expect(b).toBe(2))\n",
      )
    sandbox.capture()
    expect(sandbox.actions()).toEqual({ 'test/a.test.ts': 'skip', 'test/b.test.ts': 'skip' })
    sandbox.edit('src/a.ts', '1', '3')
    expect(sandbox.actions()).toEqual({ 'test/a.test.ts': 'run', 'test/b.test.ts': 'skip' })
  })

  test('setup files are inputs of every test file', () => {
    sandbox = new Sandbox('setup-file')
      .write(
        'vitest.config.ts',
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { setupFiles: ['./test/setup.ts'] } })\n",
      )
      .write(
        'test/setup.ts',
        "import { beforeEach } from 'vitest'\nbeforeEach(() => {\n  ;(globalThis as any).seed = 1\n})\n",
      )
      .write(
        'test/a.test.ts',
        "import { expect, test } from 'vitest'\ntest('a', () => expect((globalThis as any).seed).toBe(1))\n",
      )
    sandbox.capture()
    expect(sandbox.actions()['test/a.test.ts']).toBe('skip')
    sandbox.edit('test/setup.ts', 'seed = 1', 'seed = 2')
    expect(sandbox.actions()['test/a.test.ts']).toBe('run')
  })
})
