import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox } from '../../../test/support/sandbox.ts'
import { TRACED_PLATFORMS } from '../../capture/src/trace.ts'

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

describe('incremental capture', () => {
  const captured = (result: { outcomes: readonly { check: { path: string }; captured: boolean }[] }) =>
    Object.fromEntries(result.outcomes.map((o) => [o.check.path, o.captured]))

  test('a full run records evidence only for files whose evidence is stale', () => {
    sandbox = new Sandbox('incremental')
      .write('src/a.ts', 'export const a = 1\n')
      .write(
        'test/a.test.ts',
        "import { expect, test } from 'vitest'\nimport { a } from '../src/a'\ntest('a', () => expect(a).toBe(1))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    expect(captured(sandbox.capture())).toEqual({ 'test/a.test.ts': true, 'test/plain.test.ts': true })
    expect(captured(sandbox.capture())).toEqual({ 'test/a.test.ts': false, 'test/plain.test.ts': false })
    sandbox.edit('src/a.ts', '= 1', '= 1 + 0')
    expect(captured(sandbox.capture())).toEqual({ 'test/a.test.ts': true, 'test/plain.test.ts': false })
    expect(sandbox.actions()).toEqual({ 'test/a.test.ts': 'skip', 'test/plain.test.ts': 'skip' })
    expect(captured(sandbox.cli(['run', '--full', '--record-all']))).toEqual({
      'test/a.test.ts': true,
      'test/plain.test.ts': true,
    })
  })

  test('a file that fails while running without capture is not reused afterwards', () => {
    // A marker in the temporary directory, which Veyrum ignores: the second run fails.
    const marker = path.join(os.tmpdir(), `veyrum-marker-${process.pid}-${Date.now()}`)
    try {
      sandbox = new Sandbox('incremental-fail').write(
        'test/flip.test.ts',
        `import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('flip', () => {\n  const seen = fs.existsSync(${JSON.stringify(marker)})\n  fs.writeFileSync(${JSON.stringify(marker)}, '')\n  expect(seen).toBe(false)\n})\n`,
      )
      sandbox.capture()
      expect(sandbox.actions()['test/flip.test.ts']).toBe('skip')
      const second = sandbox.cli(['run', '--full'])
      expect(second.code).toBe(1)
      expect(captured(second)).toEqual({ 'test/flip.test.ts': false })
      expect(sandbox.plan()['test/flip.test.ts']?.reason).toBe('no-evidence')
    } finally {
      fs.rmSync(marker, { force: true })
    }
  })
})

describe('audit and canaries', () => {
  // A worker thread sharing the test's environment is not traced: an unobservable channel.
  const SPAWN_READ =
    "import { SHARE_ENV, Worker } from 'node:worker_threads'\nimport { expect, test } from 'vitest'\ntest('reads through a worker thread', async () => {\n  const text = await new Promise((resolve) => new Worker(\"require('worker_threads').parentPort.postMessage(require('fs').readFileSync('fixtures/x.txt', 'utf8'))\", { eval: true, env: SHARE_ENV }).on('message', resolve))\n  expect(text).toBe('a')\n})\n"

  test('the audit catches a reuse that an allowed unobservable channel made wrong', () => {
    sandbox = new Sandbox('audit')
      .write('fixtures/x.txt', 'a')
      .write('test/spawn-read.test.ts', SPAWN_READ)
      .write('test/plain.test.ts', PLAIN_TEST)
    expect(sandbox.cli(['run', '--full', '--allow', 'spawn']).code).toBe(0)
    // The worker thread's read is invisible, so with spawn allowed the change goes unnoticed...
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

describe('coverage', () => {
  const MATH_SOURCE =
    'export function add(a: number, b: number) {\n  return a + b\n}\n\nexport function mul(a: number, b: number) {\n  return a * b\n}\n'
  const coverageProject = (name: string, provider: string): Sandbox =>
    new Sandbox(name, { modules: ['@vitest/coverage-v8', '@vitest/coverage-istanbul'] })
      .write(
        'vitest.config.ts',
        `import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { coverage: { provider: '${provider}', reporter: ['json'], include: ['src/**'] } } })\n`,
      )
      .write('src/math.ts', MATH_SOURCE)
      .write(
        'test/add.test.ts',
        "import { expect, test } from 'vitest'\nimport { add } from '../src/math'\ntest('add', () => expect(add(1, 2)).toBe(3))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)

  /** Statement hit counts per line of src/math.ts in the project's own coverage report. */
  const lineHits = (s: Sandbox): Record<number, number> => {
    const report = JSON.parse(s.read('coverage/coverage-final.json')) as Record<
      string,
      { statementMap: Record<string, { start: { line: number } }>; s: Record<string, number> }
    >
    const file = Object.entries(report).find(([f]) => f.replaceAll('\\', '/').endsWith('src/math.ts'))?.[1]
    if (!file) throw new Error(`src/math.ts is not in the coverage report: ${Object.keys(report).join(', ')}`)
    const hits: Record<number, number> = {}
    for (const [id, loc] of Object.entries(file.statementMap)) hits[loc.start.line] = file.s[id] ?? 0
    return hits
  }

  for (const provider of ['v8', 'istanbul']) {
    test(`the project's ${provider} coverage and capture both see every execution; reuse stays per function`, () => {
      sandbox = coverageProject(`coverage-${provider}`, provider).write(
        'test/mul.test.ts',
        "import { expect, test } from 'vitest'\nimport { mul } from '../src/math'\ntest('mul', () => expect(mul(2, 3)).toBe(6))\n",
      )
      expect(sandbox.cli(['run', '--full', '--coverage']).code).toBe(0)
      expect(lineHits(sandbox)).toMatchObject({ 2: 1, 6: 1 })
      const reused = { 'test/add.test.ts': 'skip', 'test/mul.test.ts': 'skip', 'test/plain.test.ts': 'skip' }
      expect(sandbox.actions()).toEqual(reused)
      // mul's file is captured again, add's runs without capture: coverage still sees both.
      sandbox.edit('src/math.ts', 'return a * b', 'return a * b * 1')
      expect(sandbox.actions()).toEqual({ ...reused, 'test/mul.test.ts': 'run' })
      const second = sandbox.cli(['run', '--full', '--coverage'])
      expect(second.outcomes.filter((o) => o.captured).map((o) => o.check.path)).toEqual(['test/mul.test.ts'])
      expect(lineHits(sandbox)).toMatchObject({ 2: 1, 6: 1 })
      expect(sandbox.actions()).toEqual(reused)
      sandbox.edit('src/math.ts', 'return a + b', 'return a + b + 0')
      expect(sandbox.actions()).toEqual({ ...reused, 'test/add.test.ts': 'run' })
    })
  }

  test('coverage follows the project configuration unless overridden', () => {
    sandbox = coverageProject('coverage-config', 'v8')
    sandbox.edit('vitest.config.ts', "provider: 'v8'", "enabled: true, provider: 'v8'")
    expect(sandbox.cli(['run', '--full']).code).toBe(0)
    expect(lineHits(sandbox)[2]).toBeGreaterThan(0)
    sandbox.remove('coverage')
    expect(sandbox.cli(['run', '--full', '--no-coverage']).code).toBe(0)
    expect(fs.existsSync(path.join(sandbox.dir, 'coverage'))).toBe(false)
  })

  test('coverage from a custom provider is refused with a reason, not run without Veyrum', () => {
    sandbox = coverageProject('coverage-custom', 'custom')
    const result = sandbox.raw(['run', '--full', '--coverage'])
    expect(result.code).toBe(2)
    expect(result.output).toContain("only with Vitest's v8 or istanbul provider (this project uses custom)")
    expect(result.output).not.toContain('running the tests with vitest directly')
  })
})

describe("Veyrum's own reads", () => {
  // Planning hashes the inputs of every recorded file; those reads are not the run's inputs.
  test('are never inputs of the files that run', () => {
    sandbox = new Sandbox('own-reads')
      .write('fixtures/x.txt', 'a')
      .write('src/b.ts', 'export const b = () => 1\n')
      .write(
        'test/a.test.ts',
        "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('a', () => expect(fs.readFileSync('fixtures/x.txt', 'utf8')).toMatch(/^./))\n",
      )
      .write(
        'test/b.test.ts',
        "import { expect, test } from 'vitest'\nimport { b } from '../src/b'\ntest('b', () => expect(b()).toBeGreaterThan(0))\n",
      )
    sandbox.capture()
    // b reruns for its edit while the plan hashes a's changed fixture.
    sandbox.write('fixtures/x.txt', 'b')
    sandbox.edit('src/b.ts', '=> 1', '=> 2')
    expect(sandbox.cli(['run']).code).toBe(0)
    sandbox.write('fixtures/x.txt', 'c')
    expect(sandbox.actions()).toEqual({ 'test/a.test.ts': 'run', 'test/b.test.ts': 'skip' })
  })
})

describe('files whose tests are all skipped', () => {
  // Vitest runs no hook of such a file: its capture finishes when its worker stops.
  test('are reused, and what decided the skip is an input', () => {
    sandbox = new Sandbox('all-skipped')
      .write(
        'test/gated.test.ts',
        "import { describe, expect, it } from 'vitest'\ndescribe.skipIf(process.env.LIVE === undefined)('live', () => {\n  it('works', () => expect(1).toBe(1))\n})\n",
      )
      .write(
        'test/skipped.test.ts',
        "import { expect, it } from 'vitest'\nit.skip('later', () => expect(1).toBe(1))\n",
      )
    sandbox.capture()
    expect(sandbox.actions()).toEqual({ 'test/gated.test.ts': 'skip', 'test/skipped.test.ts': 'skip' })
    expect(sandbox.actions({ LIVE: '1' })).toEqual({
      'test/gated.test.ts': 'run',
      'test/skipped.test.ts': 'skip',
    })
  })
})

describe('the environment tests see', () => {
  test('is the one the vitest command gives them', () => {
    sandbox = new Sandbox('runner-env').write(
      'test/env.test.ts',
      "import { expect, test } from 'vitest'\ntest('env', () => {\n  expect(process.env.NODE_ENV).toBe('test')\n  expect(process.env.VITEST).toBe('true')\n  expect(process.env.TEST).toBe('true')\n})\n",
    )
    expect(sandbox.cli(['run', '--full']).code).toBe(0)
    // A project's own NODE_ENV stands.
    sandbox.edit('test/env.test.ts', "toBe('test')", "toBe('staging')")
    expect(sandbox.cli(['run', '--full'], { NODE_ENV: 'staging' }).code).toBe(0)
  })
})

describe('parallel jobs', () => {
  test('shards split the files, and their merged stores serve every shard', () => {
    sandbox = new Sandbox('shards').write(
      'src/value.ts',
      'export const value = () => 1\nexport const other = () => 2\n',
    )
    const files = Array.from({ length: 8 }, (_, i) => `test/t${i}.test.ts`)
    for (const [i, file] of files.entries())
      sandbox.write(
        file,
        i === 0
          ? "import { expect, test } from 'vitest'\nimport { value } from '../src/value'\ntest('value', () => expect(value()).toBe(1))\n"
          : PLAIN_TEST,
      )
    const stores = [1, 2, 3].map((i) => `.veyrum/shard-${i}.sqlite`)
    const ran = stores.map((store, i) =>
      sandbox!
        .cli(['run', '--full', '--shard', `${i + 1}/3`, '--store', store])
        .outcomes.map((o) => o.check.path),
    )
    // Every file ran in exactly one shard.
    expect(ran.flat().sort()).toEqual(files)
    expect(ran.every((paths) => paths.length < files.length)).toBe(true)

    const merged = sandbox.raw(['merge', ...stores])
    expect(merged.code).toBe(0)
    expect(Object.values(sandbox.actions()).every((a) => a === 'skip')).toBe(true)

    sandbox.edit('src/value.ts', '=> 1', '=> 1 + 0')
    const runs = [1, 2, 3].map((i) => sandbox!.cli(['run', '--shard', `${i}/3`]))
    expect(runs.flatMap((r) => r.outcomes.map((o) => o.check.path))).toEqual(['test/t0.test.ts'])
    expect(runs.flatMap((r) => r.decisions.map((d) => d.check.path)).sort()).toEqual(files)
  })

  test('an invalid shard is refused', () => {
    sandbox = new Sandbox('bad-shard').write('test/a.test.ts', PLAIN_TEST)
    const result = sandbox.raw(['run', '--shard', '4/3'])
    expect(result.code).toBe(2)
    expect(result.output).toContain('Invalid shard "4/3"')
  })
})

describe('the system temporary directory', () => {
  test('its listing is scratch space, not an input', () => {
    sandbox = new Sandbox('tmp-listing').write(
      'test/tmp.test.ts',
      "import fs from 'node:fs'\nimport os from 'node:os'\nimport { expect, test } from 'vitest'\ntest('tmp', () => expect(fs.readdirSync(os.tmpdir()).length).toBeGreaterThan(0))\n",
    )
    sandbox.capture()
    const unrelated = path.join(os.tmpdir(), `veyrum-unrelated-${process.pid}`)
    fs.writeFileSync(unrelated, '')
    try {
      expect(sandbox.actions()['test/tmp.test.ts']).toBe('skip')
    } finally {
      fs.rmSync(unrelated, { force: true })
    }
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

/** Where the native tracer is built (Linux and macOS); elsewhere, only Node programs are traced. */
const tracing = TRACED_PLATFORMS.includes(`${process.platform}-${process.arch}`)

describe.skipIf(tracing)('child processes where they cannot be traced', () => {
  test('a test that starts a child process is never reused', () => {
    sandbox = new Sandbox('child-untraced')
      .write(
        'test/child.test.ts',
        // Not a Node program: capture's own hooks trace those on every platform.
        "import { execSync } from 'node:child_process'\nimport { expect, test } from 'vitest'\ntest('child', () => expect(execSync('echo a').toString().trim()).toBe('a'))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    expect(sandbox.actions()).toEqual({ 'test/child.test.ts': 'run', 'test/plain.test.ts': 'skip' })
  })
})

describe.runIf(tracing)('child processes', () => {
  const spawnTest = (body: string): string =>
    `import { execFileSync, execSync } from 'node:child_process'\nimport { expect, test } from 'vitest'\ntest('child', () => {\n${body}\n})\n`

  test("a child process's reads are inputs of the file that started it", () => {
    sandbox = new Sandbox('child-read')
      .write('fixtures/x.txt', 'a')
      .write('fixtures/other.txt', 'o')
      .write(
        'test/child.test.ts',
        spawnTest("  expect(execFileSync('cat', ['fixtures/x.txt']).toString()).toBe('a')"),
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    expect(sandbox.actions()).toEqual({ 'test/child.test.ts': 'skip', 'test/plain.test.ts': 'skip' })
    sandbox.write('fixtures/other.txt', 'p')
    expect(sandbox.actions()).toEqual({ 'test/child.test.ts': 'skip', 'test/plain.test.ts': 'skip' })
    sandbox.write('fixtures/x.txt', 'b')
    expect(sandbox.actions()).toEqual({ 'test/child.test.ts': 'run', 'test/plain.test.ts': 'skip' })
    expect(sandbox.plan()['test/child.test.ts']?.details).toEqual(['fixtures/x.txt changed'])
  })

  test('promisify(exec) behaves as without Veyrum and is traced', () => {
    sandbox = new Sandbox('child-promisify')
      .write('fixtures/x.txt', 'a')
      .write(
        'test/child.test.ts',
        "import { exec } from 'node:child_process'\nimport { promisify } from 'node:util'\nimport { expect, test } from 'vitest'\ntest('child', async () => {\n  const { stdout, stderr } = await promisify(exec)('cat fixtures/x.txt')\n  expect([stdout, stderr]).toEqual(['a', ''])\n})\n",
      )
    sandbox.capture()
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
    sandbox.write('fixtures/x.txt', 'b')
    expect(sandbox.actions()['test/child.test.ts']).toBe('run')
  })

  test('a traced process that forks keeps its IPC channel undisturbed', () => {
    sandbox = new Sandbox('child-fork')
      .write('fixtures/x.txt', 'a')
      // Started without an IPC channel, the child's tracer log takes the lowest free descriptor,
      // where fork then puts the grandchild's IPC channel.
      .write(
        'fixtures/child.cjs',
        "const grandchild = require('child_process').fork('fixtures/grandchild.cjs')\ngrandchild.once('message', (m) => { process.stdout.write(m); grandchild.kill() })\n",
      )
      .write(
        'fixtures/grandchild.cjs',
        "process.send(require('fs').readFileSync('fixtures/x.txt', 'utf8'))\n",
      )
      .write(
        'test/child.test.ts',
        spawnTest("  expect(execFileSync(process.execPath, ['fixtures/child.cjs']).toString()).toBe('a')"),
      )
    sandbox.capture()
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
    sandbox.write('fixtures/x.txt', 'b')
    expect(sandbox.actions()['test/child.test.ts']).toBe('run')
  })

  test('programs a shell runs are traced too', () => {
    sandbox = new Sandbox('child-shell')
      .write('fixtures/x.txt', 'abc')
      .write(
        'test/child.test.ts',
        spawnTest("  expect(execSync('cat fixtures/x.txt | wc -c').toString().trim()).toBe('3')"),
      )
    sandbox.capture()
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
    sandbox.write('fixtures/x.txt', 'abcd')
    expect(sandbox.actions()['test/child.test.ts']).toBe('run')
  })

  test("a Node child process's module loads and status checks are inputs", () => {
    const script =
      "const fs = require('fs'); let flag = true; try { fs.statSync('fixtures/flag') } catch { flag = false }; process.stdout.write(String(flag) + require('./fixtures/mod.cjs'))"
    sandbox = new Sandbox('child-node')
      .write('fixtures/mod.cjs', 'module.exports = 42\n')
      .write(
        'test/child.test.ts',
        spawnTest(
          `  expect(execFileSync(process.execPath, ['-e', ${JSON.stringify(script)}]).toString()).toBe('false42')`,
        ),
      )
    sandbox.capture()
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
    sandbox.write('fixtures/flag', '')
    expect(sandbox.actions()['test/child.test.ts']).toBe('run')
    sandbox.remove('fixtures/flag')
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
    sandbox.write('fixtures/mod.cjs', 'module.exports = 43\n')
    expect(sandbox.actions()['test/child.test.ts']).toBe('run')
  })

  test('a variable the test sets for its child is not an input; one it passes on is', () => {
    sandbox = new Sandbox('child-env-set').write(
      'test/child.test.ts',
      spawnTest(
        "  expect(execSync('printf %s \"$STAMP$GREETING\"', { env: { PATH: process.env.PATH, GREETING: process.env.GREETING, STAMP: '1' } }).toString()).toBe('1hi')",
      ),
    )
    sandbox.capture({ GREETING: 'hi', STAMP: 'outer' })
    // STAMP comes from the test's code, whatever the environment holds.
    expect(sandbox.actions({ GREETING: 'hi', STAMP: 'other' })['test/child.test.ts']).toBe('skip')
    expect(sandbox.actions({ GREETING: 'bye', STAMP: 'outer' })['test/child.test.ts']).toBe('run')
  })

  test("the child process's environment is an input", () => {
    sandbox = new Sandbox('child-env').write(
      'test/child.test.ts',
      spawnTest("  expect(execSync('printf %s \"$GREETING\"').toString()).toBe('hi')"),
    )
    sandbox.capture({ GREETING: 'hi' })
    expect(sandbox.actions({ GREETING: 'hi' })['test/child.test.ts']).toBe('skip')
    expect(sandbox.actions({ GREETING: 'bye' })['test/child.test.ts']).toBe('run')
  })
})

describe('worker threads', () => {
  test('what a worker thread reads and loads is an input of the file that started it', () => {
    sandbox = new Sandbox('worker-read')
      .write('fixtures/x.txt', 'a')
      .write('fixtures/other.txt', 'o')
      .write(
        'fixtures/worker.cjs',
        "const { parentPort } = require('node:worker_threads')\nparentPort.postMessage(require('node:fs').readFileSync('fixtures/x.txt', 'utf8'))\n",
      )
      .write(
        'test/thread.test.ts',
        "import { Worker } from 'node:worker_threads'\nimport { expect, test } from 'vitest'\ntest('thread', async () => {\n  const w = new Worker('./fixtures/worker.cjs')\n  const text = await new Promise((r) => w.once('message', r))\n  await w.terminate()\n  expect(text).toMatch(/^[ab]$/)\n})\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    expect(sandbox.actions()).toEqual({ 'test/plain.test.ts': 'skip', 'test/thread.test.ts': 'skip' })
    sandbox.write('fixtures/other.txt', 'p')
    expect(sandbox.actions()['test/thread.test.ts']).toBe('skip')
    sandbox.write('fixtures/x.txt', 'b')
    expect(sandbox.plan()['test/thread.test.ts']?.details).toEqual(['fixtures/x.txt changed'])
    sandbox.capture()
    // The worker's own code is an input too.
    sandbox.edit('fixtures/worker.cjs', "'utf8'", "'utf-8'")
    expect(sandbox.actions()['test/thread.test.ts']).toBe('run')
  })
})

describe("Node programs traced with capture's own hooks", () => {
  // As on Windows, where no native tracer follows child processes.
  const JS_ONLY = { VEYRUM_NATIVE_TRACING: 'off' }
  const childTest = (body: string): string =>
    `import { execFileSync, execSync, fork } from 'node:child_process'\nimport { expect, test } from 'vitest'\ntest('child', async () => {\n${body}\n})\n`

  test('what a Node child, its forks and its Node children read and load are inputs', () => {
    sandbox = new Sandbox('node-child')
      .write('fixtures/x.txt', 'a')
      .write('fixtures/y.txt', 'b')
      .write('fixtures/z.txt', 'c')
      .write('fixtures/other.txt', 'o')
      .write('fixtures/lib.cjs', "module.exports = (f) => require('node:fs').readFileSync(f, 'utf8')\n")
      .write(
        'fixtures/child.cjs',
        "const read = require('./lib.cjs')\nconst { execFileSync } = require('node:child_process')\nprocess.stdout.write(read('fixtures/x.txt') + execFileSync(process.execPath, ['fixtures/grandchild.cjs']))\n",
      )
      .write(
        'fixtures/grandchild.cjs',
        "process.stdout.write(require('node:fs').readFileSync('fixtures/y.txt', 'utf8'))\n",
      )
      .write(
        'fixtures/forked.cjs',
        "process.send(require('node:fs').readFileSync('fixtures/z.txt', 'utf8'), () => process.exit(0))\n",
      )
      .write(
        'test/child.test.ts',
        childTest(
          "  expect(execFileSync(process.execPath, ['fixtures/child.cjs']).toString()).toMatch(/^..$/)\n  const child = fork('fixtures/forked.cjs')\n  expect(await new Promise((r) => child.once('message', r))).toMatch(/^.$/)",
        ),
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture(JS_ONLY)
    expect(sandbox.actions(JS_ONLY)).toEqual({ 'test/child.test.ts': 'skip', 'test/plain.test.ts': 'skip' })
    sandbox.write('fixtures/other.txt', 'p')
    expect(sandbox.actions(JS_ONLY)['test/child.test.ts']).toBe('skip')
    for (const [file, from, to] of [
      ['fixtures/x.txt', 'a', 'A'],
      ['fixtures/y.txt', 'b', 'B'],
      ['fixtures/z.txt', 'c', 'C'],
      ['fixtures/lib.cjs', "'utf8'", "'utf-8'"],
      ['fixtures/grandchild.cjs', "'utf8'", "'utf-8'"],
    ] as const) {
      sandbox.edit(file, from, to)
      expect(sandbox.actions(JS_ONLY)['test/child.test.ts'], file).toBe('run')
      sandbox.capture(JS_ONLY)
    }
  })

  // Windows does not run #! scripts.
  test.skipIf(process.platform === 'win32')('a script whose #! line runs this Node is traced too', () => {
    sandbox = new Sandbox('node-child-script')
      .write('fixtures/x.txt', 'a')
      .write(
        'fixtures/cli',
        `#!${process.execPath}\nimport fs from 'node:fs'\nprocess.stdout.write(fs.readFileSync('fixtures/x.txt', 'utf8'))\n`,
      )
      .write(
        'test/child.test.ts',
        childTest("  expect(execFileSync('./fixtures/cli').toString()).toMatch(/^.$/)"),
      )
    fs.chmodSync(path.join(sandbox.dir, 'fixtures/cli'), 0o755)
    sandbox.capture(JS_ONLY)
    expect(sandbox.actions(JS_ONLY)['test/child.test.ts']).toBe('skip')
    sandbox.write('fixtures/x.txt', 'b')
    expect(sandbox.plan(JS_ONLY)['test/child.test.ts']?.details).toEqual(['fixtures/x.txt changed'])
  })

  test('a program other than this Node blocks reuse', () => {
    sandbox = new Sandbox('node-child-other').write(
      'test/child.test.ts',
      childTest("  expect(execSync('echo hi').toString().trim()).toBe('hi')"),
    )
    sandbox.capture(JS_ONLY)
    expect(sandbox.plan(JS_ONLY)['test/child.test.ts']?.reason).toBe('blocked-flag')
  })
})

describe('unobservable channels', () => {
  test("a worker thread sharing the test's environment blocks reuse", () => {
    sandbox = new Sandbox('worker-thread').write(
      'test/thread.test.ts',
      "import { SHARE_ENV, Worker } from 'node:worker_threads'\nimport { expect, test } from 'vitest'\ntest('thread', async () => {\n  const w = new Worker('require(\"node:worker_threads\").parentPort.postMessage(42)', { eval: true, env: SHARE_ENV })\n  const n = await new Promise((r) => w.once('message', r))\n  await w.terminate()\n  expect(n).toBe(42)\n})\n",
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
    expect(plan['test/remote.test.ts']?.details).toEqual([
      'the check uses channels Veyrum does not observe: net-remote (203.0.113.1:9)',
    ])
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

  test('what a snapshot serializer runs while it loads, before coverage starts, is an input', () => {
    sandbox = new Sandbox('serializer-load')
      .write('src/prefix.ts', "export function prefix() {\n  return 'v1'\n}\n")
      .write(
        'test/serializer.ts',
        "import { prefix } from '../src/prefix'\nconst P = prefix()\nexport default { test: (v: unknown) => typeof v === 'number', serialize: (v: number) => P + ':' + v }\n",
      )
      .write(
        'vitest.config.ts',
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { snapshotSerializers: ['./test/serializer.ts'] } })\n",
      )
      .write(
        'test/a.test.ts',
        "import { expect, test } from 'vitest'\ntest('snap', () => expect(1).toMatchInlineSnapshot())\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    sandbox.capture({ CI: 'true' })
    expect(sandbox.actions({ CI: 'true' })['test/a.test.ts']).toBe('skip')
    sandbox.edit('src/prefix.ts', "'v1'", "'v2'")
    expect(sandbox.actions({ CI: 'true' })['test/a.test.ts']).toBe('run')
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
