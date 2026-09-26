import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox } from '../../../test/support/sandbox.ts'

/** Non-code inputs: files, directories, environment, dependencies and configuration. */

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

const PLAIN_TEST = "import { expect, test } from 'vitest'\ntest('plain', () => expect(1).toBe(1))\n"

describe('files and directories', () => {
  test('a fixture read by a test is an input; unrelated fixtures are not', () => {
    sandbox = new Sandbox('fixture')
      .write('fixtures/data.json', '{"n": 1}\n')
      .write('fixtures/other.json', '{"n": 2}\n')
      .write(
        'test/fixture.test.ts',
        "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('reads', () => expect(JSON.parse(fs.readFileSync('fixtures/data.json', 'utf8')).n).toBe(1))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    sandbox.write('fixtures/other.json', '{"n": 3}\n')
    expect(sandbox.actions()).toEqual({ 'test/fixture.test.ts': 'skip', 'test/plain.test.ts': 'skip' })
    sandbox.write('fixtures/data.json', '{"n": 1, "extra": true}\n')
    expect(sandbox.actions()).toEqual({ 'test/fixture.test.ts': 'run', 'test/plain.test.ts': 'skip' })
  })

  test('a fixture read through fs/promises is an input', () => {
    sandbox = new Sandbox('fixture-promises')
      .write('fixtures/data.txt', 'hello\n')
      .write(
        'test/async.test.ts',
        "import { readFile } from 'node:fs/promises'\nimport { expect, test } from 'vitest'\ntest('reads', async () => expect(await readFile('fixtures/data.txt', 'utf8')).toContain('hello'))\n",
      )
    sandbox.capture()
    sandbox.write('fixtures/data.txt', 'hello world\n')
    expect(sandbox.actions()['test/async.test.ts']).toBe('run')
  })

  test('a directory listing is an input', () => {
    sandbox = new Sandbox('listing')
      .write('fixtures/cases/a.txt', 'a')
      .write(
        'test/cases.test.ts',
        "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('cases', () => expect(fs.readdirSync('fixtures/cases').length).toBeGreaterThan(0))\n",
      )
    sandbox.capture()
    expect(sandbox.actions()['test/cases.test.ts']).toBe('skip')
    sandbox.write('fixtures/cases/b.txt', 'b')
    expect(sandbox.actions()['test/cases.test.ts']).toBe('run')
  })

  test('an existence check is an input', () => {
    sandbox = new Sandbox('exists').write(
      'test/exists.test.ts',
      "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('exists', () => expect(fs.existsSync('fixtures/optional.txt')).toBe(false))\n",
    )
    sandbox.capture()
    sandbox.write('fixtures/optional.txt', 'now here')
    expect(sandbox.actions()['test/exists.test.ts']).toBe('run')
  })

  test('files a test writes and then reads are not inputs', () => {
    sandbox = new Sandbox('own-writes').write(
      'test/writes.test.ts',
      "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('roundtrip', () => {\n  fs.mkdirSync('out', { recursive: true })\n  fs.writeFileSync('out/result.txt', String(Date.now()))\n  expect(fs.readFileSync('out/result.txt', 'utf8').length).toBeGreaterThan(0)\n})\n",
    )
    sandbox.capture()
    expect(sandbox.actions()['test/writes.test.ts']).toBe('skip')
  })

  test('what global setup, a test and its child processes create are not inputs of a listing', () => {
    sandbox = new Sandbox('run-products')
      .write(
        'setup/global.ts',
        "import fs from 'node:fs'\nexport default () => {\n  fs.mkdirSync('test/.cache', { recursive: true })\n  fs.writeFileSync('test/.cache/state.json', '{}')\n}\n",
      )
      .write(
        'test/listing.test.ts',
        "import { execFileSync } from 'node:child_process'\nimport fs from 'node:fs'\nimport { afterAll, expect, test } from 'vitest'\nafterAll(() => fs.rmSync('test/__out__', { recursive: true, force: true }))\ntest('lists', () => {\n  fs.mkdirSync('test/__out__', { recursive: true })\n  execFileSync(process.execPath, ['-e', \"require('fs').writeFileSync('test/__out__/o.json', '1')\"])\n  expect(fs.readFileSync('test/__out__/o.json', 'utf8')).toBe('1')\n  expect(fs.readdirSync('test')).toContain('listing.test.ts')\n})\n",
      )
      .edit('vitest.config.ts', 'test: {}', "test: { globalSetup: ['setup/global.ts'] }")
    sandbox.capture()
    // A fresh checkout: global setup's cache is not there yet.
    sandbox.remove('test/.cache')
    expect(sandbox.actions()['test/listing.test.ts']).toBe('skip')
    sandbox.write('test/.cache/state.json', '{}')
    expect(sandbox.actions()['test/listing.test.ts']).toBe('skip')
    sandbox.write('test/new.txt', 'new')
    expect(sandbox.actions()['test/listing.test.ts']).toBe('run')
  })

  test("another test's output in a shared fixture is not an input of a listing; a new file is", () => {
    sandbox = new Sandbox('sibling-products')
      .write('fixtures/app/index.txt', 'app')
      .write(
        'test/build.test.ts',
        "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('builds', () => {\n  fs.mkdirSync('fixtures/app/out', { recursive: true })\n  fs.writeFileSync('fixtures/app/out/bundle.txt', 'built')\n  expect(fs.readFileSync('fixtures/app/index.txt', 'utf8')).toBe('app')\n})\n",
      )
      .write(
        'test/list.test.ts',
        "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('lists', async () => {\n  // Waits for the build, as a test that races another one sees it or not.\n  for (let i = 0; i < 100 && !fs.readdirSync('fixtures/app').includes('out'); i++) await new Promise((r) => setTimeout(r, 50))\n  expect(fs.readdirSync('fixtures/app')).toContain('index.txt')\n})\n",
      )
    sandbox.capture()
    // A fresh checkout: the build output is not there.
    sandbox.remove('fixtures/app/out')
    expect(sandbox.actions()).toEqual({ 'test/build.test.ts': 'skip', 'test/list.test.ts': 'skip' })
    sandbox.write('fixtures/app/other.txt', 'new')
    expect(sandbox.actions()['test/list.test.ts']).toBe('run')
  })

  test('a repository inside the OS temporary directory still records its fixture reads', () => {
    sandbox = new Sandbox('in-tmp', { base: fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-')) })
      .write('fixtures/data.json', '{"n": 1}\n')
      .write(
        'test/fixture.test.ts',
        "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('reads', () => expect(fs.readFileSync('fixtures/data.json', 'utf8')).toContain('1'))\n",
      )
    sandbox.capture()
    sandbox.write('fixtures/data.json', '{"n": 2, "was": 1}\n')
    expect(sandbox.actions()['test/fixture.test.ts']).toBe('run')
  })

  test('a snapshot file is an input', () => {
    sandbox = new Sandbox('snapshot')
      .write(
        'test/snap.test.ts',
        "import { expect, test } from 'vitest'\ntest('snap', () => expect({ a: 1 }).toMatchSnapshot())\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    // The first run writes the snapshot, so it is not evidence; the second run is.
    sandbox.capture()
    expect(sandbox.actions()['test/snap.test.ts']).toBe('run')
    sandbox.capture()
    expect(sandbox.actions()).toEqual({ 'test/plain.test.ts': 'skip', 'test/snap.test.ts': 'skip' })
    sandbox.edit('test/__snapshots__/snap.test.ts.snap', '"a": 1', '"a": 2')
    expect(sandbox.actions()).toEqual({ 'test/plain.test.ts': 'skip', 'test/snap.test.ts': 'run' })
  })
})

describe('environment', () => {
  test('an environment variable read by a test is an input', () => {
    sandbox = new Sandbox('env')
      .write(
        'test/flag.test.ts',
        "import { expect, test } from 'vitest'\ntest('flag', () => expect(['on', 'off']).toContain(process.env.VEY_FEATURE_FLAG))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture({ VEY_FEATURE_FLAG: 'on' })
    expect(sandbox.actions({ VEY_FEATURE_FLAG: 'on' })).toEqual({
      'test/flag.test.ts': 'skip',
      'test/plain.test.ts': 'skip',
    })
    expect(sandbox.actions({ VEY_FEATURE_FLAG: 'off' })).toEqual({
      'test/flag.test.ts': 'run',
      'test/plain.test.ts': 'skip',
    })
    expect(sandbox.actions({})).toEqual({ 'test/flag.test.ts': 'run', 'test/plain.test.ts': 'skip' })
  })

  test('an unset variable that becomes set invalidates', () => {
    sandbox = new Sandbox('env-unset').write(
      'test/unset.test.ts',
      "import { expect, test } from 'vitest'\ntest('unset', () => expect(process.env.VEY_OPTIONAL ?? 'default').toBe('default'))\n",
    )
    sandbox.capture()
    expect(sandbox.actions()['test/unset.test.ts']).toBe('skip')
    expect(sandbox.actions({ VEY_OPTIONAL: 'set' })['test/unset.test.ts']).toBe('run')
  })

  test('a variable the runner sets differently per test environment does not invalidate', () => {
    // Vitest sets SSR to "1" in server environments and to "" in DOM environments.
    sandbox = new Sandbox('env-injected-varying', { modules: ['happy-dom'] })
      .write(
        'test/server.test.ts',
        "import { expect, test } from 'vitest'\ntest('ssr', () => expect(process.env.SSR).toBe('1'))\n",
      )
      .write(
        'test/dom.test.ts',
        "// @vitest-environment happy-dom\nimport { expect, test } from 'vitest'\ntest('dom', () => expect(process.env.SSR).toBe(''))\n",
      )
    sandbox.capture()
    expect(sandbox.actions()).toEqual({ 'test/dom.test.ts': 'skip', 'test/server.test.ts': 'skip' })
  })

  test('enumerating the environment is recorded but does not block reuse', () => {
    sandbox = new Sandbox('env-enum').write(
      'test/enum.test.ts',
      "import { expect, test } from 'vitest'\ntest('enum', () => expect(Object.keys(process.env).length).toBeGreaterThan(0))\n",
    )
    sandbox.capture()
    const decision = sandbox.plan()['test/enum.test.ts']
    expect(decision?.action).toBe('skip')
    expect(decision?.flagsRelied).toContain('env-enumerated')
  })

  test('drawing random numbers is flagged but does not block reuse', () => {
    sandbox = new Sandbox('random')
      .write(
        'test/random.test.ts',
        "import { randomUUID } from 'node:crypto'\nimport { expect, test } from 'vitest'\ntest('random', () => {\n  expect(Math.random()).toBeLessThan(1)\n  expect(randomUUID()).toHaveLength(36)\n})\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    const plan = sandbox.plan()
    expect(plan['test/random.test.ts']?.action).toBe('skip')
    expect(plan['test/random.test.ts']?.flagsRelied).toContain('random')
    expect(plan['test/plain.test.ts']?.flagsRelied ?? []).not.toContain('random')
  })
})

describe('dependencies and configuration', () => {
  function manifest(fields: Record<string, unknown>): string {
    return JSON.stringify({ name: 'manifest', private: true, type: 'module', ...fields }, null, 2)
  }

  test('a version range or script in package.json is not an input of the run; other fields are', () => {
    sandbox = new Sandbox('manifest')
      .write(
        'package.json',
        manifest({ scripts: { lint: 'eslint .' }, devDependencies: { eslint: '^10.8.0' } }),
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    sandbox.write(
      'package.json',
      manifest({ scripts: { lint: 'eslint . --fix' }, devDependencies: { eslint: '^10.10.0' } }),
    )
    expect(sandbox.actions()['test/plain.test.ts']).toBe('skip')
    sandbox.write(
      'package.json',
      manifest({
        scripts: { lint: 'eslint . --fix' },
        devDependencies: { eslint: '^10.10.0', prettier: '^3.0.0' },
      }),
    )
    expect(sandbox.actions()['test/plain.test.ts']).toBe('run')
    sandbox.capture()
    sandbox.write(
      'package.json',
      manifest({
        scripts: { lint: 'eslint . --fix' },
        devDependencies: { eslint: '^10.10.0', prettier: '^3.0.0' },
        imports: { '#src/*': './src/*' },
      }),
    )
    expect(sandbox.actions()['test/plain.test.ts']).toBe('run')
  })

  test('a test that imports package.json depends on all of it', () => {
    sandbox = new Sandbox('manifest-import')
      .write('package.json', manifest({ devDependencies: { eslint: '^10.8.0' } }))
      .write(
        'test/manifest.test.ts',
        "import { expect, test } from 'vitest'\nimport pkg from '../package.json'\ntest('deps', () => expect(Object.values(pkg.devDependencies)).toContain('^10.8.0'))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    sandbox.write('package.json', manifest({ devDependencies: { eslint: '^10.10.0' } }))
    expect(sandbox.actions()).toEqual({ 'test/manifest.test.ts': 'run', 'test/plain.test.ts': 'skip' })
  })

  test('a new configuration file only affects the files below its directory', () => {
    sandbox = new Sandbox('config-scope')
      .write('src/lib/value.js', 'export const value = 1\n')
      .write(
        'test/value.test.ts',
        "import { expect, test } from 'vitest'\nimport { value } from '../src/lib/value.js'\ntest('value', () => expect(value).toBe(1))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    // Nothing under tools/ is an input of either test.
    sandbox.write('tools/tsconfig.json', '{ "compilerOptions": { "strict": true } }\n')
    expect(sandbox.actions()).toEqual({ 'test/plain.test.ts': 'skip', 'test/value.test.ts': 'skip' })
    // A manifest next to a module the test executes can change how that module loads.
    sandbox.write('src/lib/package.json', '{ "type": "commonjs" }\n')
    expect(sandbox.actions()).toEqual({ 'test/plain.test.ts': 'skip', 'test/value.test.ts': 'run' })
  })

  function depProject(name: string): Sandbox {
    sandbox = new Sandbox(name)
      .write(
        'node_modules/fake-dep/package.json',
        JSON.stringify({ name: 'fake-dep', version: '1.0.0', type: 'module', main: 'index.js' }),
      )
      .write('node_modules/fake-dep/index.js', 'export function answer() {\n  return 42\n}\n')
      .write('src/use.ts', "import { answer } from 'fake-dep'\nexport const value = answer()\n")
      .write(
        'test/dep.test.ts',
        "import { expect, test } from 'vitest'\nimport { value } from '../src/use'\ntest('dep', () => expect(value).toBe(42))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    return sandbox
  }

  test('a dependency file change reruns only the tests that loaded it', () => {
    const sb = depProject('dep-file')
    sb.edit('node_modules/fake-dep/index.js', 'return 42', 'return 43')
    expect(sb.actions()).toEqual({ 'test/dep.test.ts': 'run', 'test/plain.test.ts': 'skip' })
  })

  test('a dependency manifest change reruns the tests that loaded it', () => {
    const sb = depProject('dep-manifest')
    sb.edit('node_modules/fake-dep/package.json', '"1.0.0"', '"1.0.1"')
    expect(sb.actions()).toEqual({ 'test/dep.test.ts': 'run', 'test/plain.test.ts': 'skip' })
  })

  test('the project package.json is an input of every module below it', () => {
    sandbox = new Sandbox('manifest').write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    sandbox.edit('package.json', '"private": true', '"private": true,\n  "imports": { "#x": "./x.js" }')
    expect(sandbox.actions()['test/plain.test.ts']).toBe('run')
  })

  test('a module the test generated and imported is not an input', () => {
    sandbox = new Sandbox('generated-by-tests')
      .write(
        'test/generate.test.ts',
        "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('generate', async () => {\n  fs.mkdirSync('out', { recursive: true })\n  fs.writeFileSync('out/site.mjs', 'export const built = 1\\n')\n  const site = await import('../out/site.mjs')\n  expect(site.built).toBe(1)\n})\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    // A fresh checkout does not have the generated module.
    sandbox.remove('out/site.mjs')
    expect(sandbox.plan()['test/generate.test.ts']?.details).toEqual([])
    expect(sandbox.actions()).toEqual({ 'test/generate.test.ts': 'skip', 'test/plain.test.ts': 'skip' })
  })

  test("a project's global setup and what it reads are inputs of that project's files only", () => {
    sandbox = new Sandbox('project-global-setup')
      .write(
        'vitest.config.ts',
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { projects: [\n  { test: { name: 'a', include: ['a/**/*.test.ts'], globalSetup: ['a/setup.ts'] } },\n  { test: { name: 'b', include: ['b/**/*.test.ts'] } },\n] } })\n",
      )
      .write(
        'a/setup.ts',
        "import fs from 'node:fs'\nimport { suffix } from './helper.ts'\nexport default () => {\n  process.env.SEED = fs.readFileSync('fixtures/seed.txt', 'utf8') + suffix\n}\n",
      )
      .write('a/helper.ts', "export const suffix = '!'\n")
      .write('fixtures/seed.txt', 'seed')
      .write('a/a.test.ts', PLAIN_TEST)
      .write('b/b.test.ts', PLAIN_TEST)
    sandbox.capture()
    expect(sandbox.actions()).toEqual({ 'a/a.test.ts': 'skip', 'b/b.test.ts': 'skip' })
    sandbox.write('fixtures/seed.txt', 'seed 2')
    expect(sandbox.actions()).toEqual({ 'a/a.test.ts': 'run', 'b/b.test.ts': 'skip' })
    sandbox.write('fixtures/seed.txt', 'seed')
    sandbox.write('a/helper.ts', "export const suffix = '?'\n")
    expect(sandbox.actions()).toEqual({ 'a/a.test.ts': 'run', 'b/b.test.ts': 'skip' })
  })

  test('a test file that ran without capture is not an input of the others', () => {
    sandbox = new Sandbox('uncaptured-test-file')
      .write('test/a.test.ts', PLAIN_TEST)
      .write('test/b.test.ts', "import { expect, test } from 'vitest'\ntest('b', () => expect(2).toBe(2))\n")
    sandbox.capture()
    // A full run records only where evidence is stale: a runs captured, b runs without capture.
    sandbox.write('test/a.test.ts', `${PLAIN_TEST}test('more', () => expect(3).toBe(3))\n`)
    sandbox.capture()
    sandbox.write(
      'test/b.test.ts',
      "import { expect, test } from 'vitest'\ntest('b', () => expect(4).toBe(4))\n",
    )
    expect(sandbox.actions()).toEqual({ 'test/a.test.ts': 'skip', 'test/b.test.ts': 'run' })
  })

  test('a test whose inputs change on their own stops being recorded; one whose code changes does not', () => {
    sandbox = new Sandbox('churn')
      .write('src/value.ts', 'export const value = 0\n')
      .write(
        'test/env.test.ts',
        "import { expect, test } from 'vitest'\ntest('env', () => expect(process.env.CHURN_VALUE).toBeDefined())\n",
      )
      .write(
        'test/code.test.ts',
        "import { expect, test } from 'vitest'\nimport { value } from '../src/value.ts'\ntest('code', () => expect(value).toBeGreaterThanOrEqual(0))\n",
      )
    const recorded: Record<string, boolean>[] = []
    for (let i = 0; i < 6; i++) {
      // Each run sees a new value (a build number, a timestamp) and new code.
      sandbox.write('src/value.ts', `export const value = ${i}\n`)
      const result = sandbox.capture({ CHURN_VALUE: String(i) })
      recorded.push(Object.fromEntries(result.outcomes.map((o) => [o.check.path, o.captured])))
    }
    // The first run records both. After two plans in a row found the environment test's evidence
    // invalidated by the environment alone, it runs without recording; the sixth run is a probe.
    expect(recorded.map((r) => r['test/env.test.ts'])).toEqual([true, true, true, false, false, true])
    expect(recorded.map((r) => r['test/code.test.ts'])).toEqual([true, true, true, true, true, true])
    expect(sandbox.cli(['run', '--full'], { CHURN_VALUE: '9' }).output).toContain('ran without recording')
  })

  test('a test file that declares always-run is never reused', () => {
    sandbox = new Sandbox('always-run')
      .write('test/declared.test.ts', `// veyrum: always-run\n${PLAIN_TEST}`)
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    const plan = sandbox.plan()
    expect(plan['test/declared.test.ts']?.action).toBe('run')
    expect(plan['test/declared.test.ts']?.details.join(' ')).toContain(
      'always-run (declared in the test file)',
    )
    expect(plan['test/plain.test.ts']?.action).toBe('skip')
  })

  test('a Vitest config change reruns everything', () => {
    sandbox = new Sandbox('config').write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    sandbox.edit('vitest.config.ts', 'test: {}', 'test: { testTimeout: 7000 }')
    const decision = sandbox.plan()['test/plain.test.ts']
    expect(decision?.action).toBe('run')
    expect(decision?.details.join(' ')).toContain('vitest.config.ts')
  })

  test('a new or changed tsconfig reruns everything', () => {
    sandbox = new Sandbox('tsconfig').write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    sandbox.write('tsconfig.json', '{ "compilerOptions": { "target": "es2022" } }\n')
    expect(sandbox.actions()['test/plain.test.ts']).toBe('run')
    sandbox.capture()
    expect(sandbox.actions()['test/plain.test.ts']).toBe('skip')
    sandbox.edit('tsconfig.json', 'es2022', 'es2020')
    expect(sandbox.actions()['test/plain.test.ts']).toBe('run')
  })
})
