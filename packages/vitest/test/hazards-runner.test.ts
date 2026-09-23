import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox } from '../../../test/support/sandbox.ts'

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

describe('audit and canaries', () => {
  const SPAWN_READ =
    "import { execFileSync } from 'node:child_process'\nimport { expect, test } from 'vitest'\ntest('reads through a child process', () => expect(execFileSync('cat', ['fixtures/x.txt']).toString()).toBe('a'))\n"

  test('the audit catches a reuse that an allowed unobservable channel made wrong', () => {
    sandbox = new Sandbox('audit')
      .write('fixtures/x.txt', 'a')
      .write('test/spawn-read.test.ts', SPAWN_READ)
      .write('test/plain.test.ts', PLAIN_TEST)
    expect(sandbox.cli(['run', '--full', '--allow', 'spawn']).code).toBe(0)
    // The child process's read is invisible, so with spawn allowed the change goes unnoticed...
    sandbox.write('fixtures/x.txt', 'b')
    const plan = Object.fromEntries(
      sandbox.cli(['plan', '--allow', 'spawn']).decisions.map((d) => [d.check.path, d.action]),
    )
    expect(plan['test/spawn-read.test.ts']).toBe('skip')
    // ...and the audit (a full run that also plans) reports the wrong reuse as an escape.
    const audit = sandbox.cli(['run', '--full', '--audit', '--allow', 'spawn'])
    expect(audit.code).toBe(1)
    expect(audit.output).toContain('ESCAPE test/spawn-read.test.ts')
    expect(sandbox.cli(['stats']).output).toMatch(/escapes 1/)
  })

  test('canaries run a share of reusable files and record the verification', () => {
    sandbox = new Sandbox('canary').write('test/a.test.ts', PLAIN_TEST).write('test/b.test.ts', PLAIN_TEST)
    sandbox.capture()
    const run = sandbox.cli(['run', '--canary', '1'])
    expect(run.code).toBe(0)
    expect(run.output).toContain(
      'canaries: 2 reuse decisions verified by running them, 0 would have been wrong',
    )
    expect(sandbox.cli(['stats']).output).toMatch(/verified reuse decisions 2\nescapes 0/)
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

  test('starting a worker thread blocks reuse', () => {
    sandbox = new Sandbox('worker-thread').write(
      'test/thread.test.ts',
      "import { Worker } from 'node:worker_threads'\nimport { expect, test } from 'vitest'\ntest('thread', async () => {\n  const w = new Worker('require(\"node:worker_threads\").parentPort.postMessage(42)', { eval: true })\n  const n = await new Promise((r) => w.once('message', r))\n  await w.terminate()\n  expect(n).toBe(42)\n})\n",
    )
    sandbox.capture()
    const decision = sandbox.plan()['test/thread.test.ts']
    expect(decision?.action).toBe('run')
    expect(decision?.reason).toBe('blocked-flag')
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

  test('forcing isolation makes an isolate: false project reusable', () => {
    sandbox = new Sandbox('force-isolate')
      .write(
        'vitest.config.ts',
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { isolate: false } })\n",
      )
      .write('src/a.ts', 'export const a = 1\n')
      .write(
        'test/a.test.ts',
        "import { expect, test } from 'vitest'\nimport { a } from '../src/a'\ntest('a', () => expect(a).toBe(1))\n",
      )
      .write('test/b.test.ts', PLAIN_TEST)
    expect(sandbox.cli(['run', '--full', '--isolate']).code).toBe(0)
    const actions = () =>
      Object.fromEntries(sandbox!.cli(['plan', '--isolate']).decisions.map((d) => [d.check.path, d.action]))
    expect(actions()).toEqual({ 'test/a.test.ts': 'skip', 'test/b.test.ts': 'skip' })
    sandbox.edit('src/a.ts', '1', '2')
    expect(actions()).toEqual({ 'test/a.test.ts': 'run', 'test/b.test.ts': 'skip' })
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

describe('failing open', () => {
  const PASSING = "import { expect, test } from 'vitest'\ntest('ok', () => expect(1).toBe(1))\n"
  const FAILING = "import { expect, test } from 'vitest'\ntest('broken', () => expect(1).toBe(2))\n"

  test('an internal error before the run falls back to running every test with the runner', () => {
    sandbox = new Sandbox('fail-open-before').write('test/a.test.ts', PASSING)
    const passing = sandbox.raw(['run'], { VEYRUM_FAULT: 'before-run' })
    expect(passing.output).toContain('running the tests with vitest directly, without Veyrum')
    expect(passing.code).toBe(0)
    sandbox.write('test/b.test.ts', FAILING)
    // The fallback keeps the runner's verdict: a failing test still fails the job.
    expect(sandbox.raw(['run'], { VEYRUM_FAULT: 'before-run' }).code).toBe(1)
  })

  test('with --strict an internal error fails instead of falling back', () => {
    sandbox = new Sandbox('fail-open-strict').write('test/a.test.ts', PASSING)
    const result = sandbox.raw(['run', '--strict'], { VEYRUM_FAULT: 'before-run' })
    expect(result.code).not.toBe(0)
    expect(result.output).not.toContain('without Veyrum')
  })

  test('a failure while recording keeps the verdict and leaves no evidence', () => {
    sandbox = new Sandbox('fail-open-record').write('test/a.test.ts', PASSING)
    const result = sandbox.raw(['run'], { VEYRUM_FAULT: 'record' })
    expect(result.code).toBe(0)
    expect(result.output).toContain('recording evidence failed')
    expect(sandbox.plan()['test/a.test.ts']?.reason).toBe('no-evidence')
  })

  test('an unusable evidence store is set aside and replaced', () => {
    sandbox = new Sandbox('fail-open-store').write('test/a.test.ts', PASSING)
    sandbox.write('.veyrum/store.sqlite', 'this is not a database')
    const result = sandbox.raw(['run', '--full'])
    expect(result.code).toBe(0)
    expect(result.output).toContain('could not be opened')
    expect(sandbox.actions()['test/a.test.ts']).toBe('skip')
  })
})

describe('code that runs before setup files', () => {
  test('a custom environment is captured, with the modules it loads', () => {
    sandbox = new Sandbox('custom-environment')
      .write('src/flag.ts', 'export const FLAG = 1\n')
      .write(
        'env/custom.ts',
        "import { FLAG } from '../src/flag'\nexport default { name: 'custom', viteEnvironment: 'ssr', setup() { (globalThis as any).FLAG = FLAG; return { teardown() {} } } }\n",
      )
      .write(
        'vitest.config.ts',
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { environment: './env/custom.ts' } })\n",
      )
      .write(
        'test/a.test.ts',
        "import { expect, test } from 'vitest'\ntest('flag', () => expect((globalThis as any).FLAG).toBe(1))\n",
      )
      // Another test imports the module directly, so it is not a shared input of the run: only
      // capturing the environment itself can put it in test/a's closure.
      .write(
        'test/b.test.ts',
        "import { expect, test } from 'vitest'\nimport { FLAG } from '../src/flag'\ntest('direct', () => expect(FLAG).toBeGreaterThan(0))\n",
      )
    sandbox.capture()
    expect(sandbox.actions()['test/a.test.ts']).toBe('skip')
    sandbox.edit('src/flag.ts', 'FLAG = 1', 'FLAG = 2')
    expect(sandbox.actions()['test/a.test.ts']).toBe('run')
  })

  test('a file a custom environment reads in its setup is captured', () => {
    sandbox = new Sandbox('custom-environment-read')
      .write('fixtures/flag.txt', '1')
      .write(
        'env/custom.ts',
        "import { readFileSync } from 'node:fs'\nexport default { name: 'custom', viteEnvironment: 'ssr', setup() { (globalThis as any).FLAG = readFileSync('fixtures/flag.txt', 'utf8'); return { teardown() {} } } }\n",
      )
      .write(
        'vitest.config.ts',
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { environment: './env/custom.ts' } })\n",
      )
      .write(
        'test/a.test.ts',
        "import { expect, test } from 'vitest'\ntest('flag', () => expect((globalThis as any).FLAG).toBeTruthy())\n",
      )
    sandbox.capture()
    expect(sandbox.actions()['test/a.test.ts']).toBe('skip')
    sandbox.edit('fixtures/flag.txt', '1', '2')
    expect(sandbox.actions()['test/a.test.ts']).toBe('run')
  })

  test('a snapshot serializer is captured, with the modules it loads', () => {
    sandbox = new Sandbox('serializer')
      .write('src/label.ts', "export const LABEL = 'v1'\n")
      .write(
        'test/serializer.ts',
        "import { LABEL } from '../src/label'\nexport default { test: (v: unknown) => typeof v === 'number', serialize: (v: number) => LABEL + ':' + v }\n",
      )
      .write(
        'vitest.config.ts',
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { snapshotSerializers: ['./test/serializer.ts'] } })\n",
      )
      .write(
        'test/a.test.ts',
        "import { expect, test } from 'vitest'\ntest('snap', () => expect(1).toMatchInlineSnapshot())\n",
      )
      .write(
        'test/b.test.ts',
        "import { expect, test } from 'vitest'\nimport { LABEL } from '../src/label'\ntest('direct', () => expect(LABEL).toBeTruthy())\n",
      )
    sandbox.capture()
    sandbox.capture({ CI: 'true' })
    expect(sandbox.actions({ CI: 'true' })['test/a.test.ts']).toBe('skip')
    sandbox.edit('src/label.ts', "'v1'", "'v2'")
    expect(sandbox.actions({ CI: 'true' })['test/a.test.ts']).toBe('run')
  })

  test('a file a snapshot serializer reads while it loads is captured', () => {
    sandbox = new Sandbox('serializer-read')
      .write('fixtures/prefix.txt', 'v1')
      .write(
        'test/serializer.ts',
        "import { readFileSync } from 'node:fs'\nconst PREFIX = readFileSync('fixtures/prefix.txt', 'utf8')\nexport default { test: (v: unknown) => typeof v === 'number', serialize: (v: number) => PREFIX + ':' + v }\n",
      )
      .write(
        'vitest.config.ts',
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { snapshotSerializers: ['./test/serializer.ts'] } })\n",
      )
      .write(
        'test/a.test.ts',
        "import { expect, test } from 'vitest'\ntest('snap', () => expect(1).toMatchInlineSnapshot())\n",
      )
    sandbox.capture()
    sandbox.capture({ CI: 'true' })
    expect(sandbox.actions({ CI: 'true' })['test/a.test.ts']).toBe('skip')
    sandbox.edit('fixtures/prefix.txt', 'v1', 'v2')
    expect(sandbox.actions({ CI: 'true' })['test/a.test.ts']).toBe('run')
  })
})
