import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox } from '../../../test/support/sandbox.ts'
import { TRACED_PLATFORMS } from '../../capture/src/trace.ts'

/**
 * End-to-end soundness scenarios for the Jest adapter, through the real CLI and a real Jest 30.
 * Each scenario records evidence, changes something, and asserts which files the plan runs.
 */

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

const jest = (name: string, workers = 1, modules: readonly string[] = []): Sandbox => {
  sandbox = new Sandbox(name, { runner: 'jest', workers, modules })
  return sandbox
}

const MATH =
  'function add(a, b) { return a + b }\nfunction mul(a, b) { return a * b }\nmodule.exports = { add, mul }\n'
const ADD_TEST = "const { add } = require('../src/math')\ntest('adds', () => expect(add(1, 2)).toBe(3))\n"
const MUL_TEST = "const { mul } = require('../src/math')\ntest('muls', () => expect(mul(2, 3)).toBe(6))\n"
const PLAIN_TEST = "test('plain', () => expect(1).toBe(1))\n"

describe('code', () => {
  for (const workers of [1, 2]) {
    test(`an edit invalidates only the files that executed the changed function (${workers === 1 ? 'in band' : 'workers'})`, () => {
      const s = jest(`units-${workers}`, workers)
        .write('src/math.js', MATH)
        .write('test/add.test.js', ADD_TEST)
        .write('test/mul.test.js', MUL_TEST)
      s.capture()
      expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'skip' })
      s.write('src/math.js', `// formatting only\n${MATH.replace('return a + b', 'return (a + b)')}`)
      expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'skip' })
      s.edit('src/math.js', 'return a * b', 'return a * b * 1')
      expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'run' })
      expect(s.plan()['test/mul.test.js']?.details).toEqual(['src/math.js: mul changed'])
    })
  }

  test('a setup file runs before every test file and is an input of each', () => {
    const s = jest('setup-files')
      .write(
        'jest.config.js',
        "module.exports = { testEnvironment: 'node', setupFiles: ['<rootDir>/setup.js'] }\n",
      )
      .write('setup.js', 'globalThis.LIMIT = 10\n')
      .write('test/a.test.js', "test('limit', () => expect(globalThis.LIMIT).toBe(10))\n")
      .write('test/b.test.js', PLAIN_TEST)
    s.capture()
    s.write('setup.js', 'globalThis.LIMIT = 11\n')
    expect(s.actions()).toEqual({ 'test/a.test.js': 'run', 'test/b.test.js': 'run' })
  })

  test('a module mocked with a factory is not an input; an automocked one is', () => {
    const s = jest('mocks')
      .write('src/a.js', 'module.exports = { f: () => 1 }\n')
      .write('src/b.js', 'module.exports = { g: () => 2 }\n')
      .write(
        'test/factory.test.js',
        "jest.mock('../src/a', () => ({ f: () => 5 }))\nconst { f } = require('../src/a')\ntest('factory', () => expect(f()).toBe(5))\n",
      )
      .write(
        'test/auto.test.js',
        "jest.mock('../src/b')\nconst { g } = require('../src/b')\ntest('auto', () => expect(g()).toBeUndefined())\n",
      )
    s.capture()
    s.write('src/a.js', 'module.exports = { f: () => 1, h: () => 3 }\n')
    s.write('src/b.js', 'module.exports = { g: () => 2, h: () => 3 }\n')
    expect(s.actions()).toEqual({ 'test/auto.test.js': 'run', 'test/factory.test.js': 'skip' })
  })

  test('code that reads function source compares raw source', () => {
    const s = jest('source-observed')
      .write('src/f.js', 'function f() { return 1 }\nmodule.exports = { f }\n')
      .write(
        'test/source.test.js',
        "const { f } = require('../src/f')\ntest('source', () => expect(f.toString()).toContain('return 1'))\n",
      )
    s.capture()
    s.write('src/f.js', 'function f() {\n  return 1\n}\nmodule.exports = { f }\n')
    expect(s.actions()['test/source.test.js']).toBe('run')
  })

  test('a function an earlier file made hot is still recorded for a later file that calls it once', () => {
    // One worker runs both files in turn. The large file sorts first (Jest runs bigger files
    // first), and makes hot() hot enough for V8 to optimize it.
    const s = jest('hot-function')
      .write(
        'src/lib.js',
        'function hot(x) { return x * 2 + 1 }\nfunction other(x) { return x - 1 }\nmodule.exports = { hot, other }\n',
      )
      .write(
        'test/a.test.js',
        `${'// padding\n'.repeat(400)}const { hot } = require('../src/lib')\ntest('loop', () => { let x = 0; for (let i = 0; i < 2e6; i++) x += hot(i); expect(x).toBeGreaterThan(0) })\n`,
      )
      .write(
        'test/b.test.js',
        "const { hot } = require('../src/lib')\ntest('once', () => expect(hot(1)).toBe(3))\n",
      )
      .write(
        'test/c.test.js',
        "const { other } = require('../src/lib')\ntest('other', () => expect(other(1)).toBe(0))\n",
      )
    s.capture()
    s.edit('src/lib.js', 'x * 2 + 1', 'x * 2 + 2')
    expect(s.actions()).toEqual({
      'test/a.test.js': 'run',
      'test/b.test.js': 'run',
      'test/c.test.js': 'skip',
    })
  })

  for (const workers of [1, 2]) {
    test(`a file that picks its environment in a docblock is captured, and the environment is an input (${workers === 1 ? 'in band' : 'workers'})`, () => {
      const s = jest(`docblock-environment-${workers}`, workers, ['jest-environment-node'])
        .write('src/math.js', MATH)
        .write(
          'env/custom.js',
          "const { TestEnvironment } = require('jest-environment-node')\nmodule.exports = class extends TestEnvironment { constructor(...a) { super(...a); this.global.MARK = 'custom' } }\n",
        )
        .write(
          'test/custom.test.js',
          `/** @jest-environment ./env/custom.js */\n${ADD_TEST}test('env', () => expect(globalThis.MARK).toBe('custom'))\n`,
        )
        .write('test/node.test.js', `/** @jest-environment node */\n${MUL_TEST}`)
      s.capture()
      expect(s.actions()).toEqual({ 'test/custom.test.js': 'skip', 'test/node.test.js': 'skip' })
      s.edit('src/math.js', 'return a * b', 'return a * b * 1')
      expect(s.actions()).toEqual({ 'test/custom.test.js': 'skip', 'test/node.test.js': 'run' })
      s.edit('env/custom.js', "'custom'", "'custom' + ''")
      expect(s.actions()['test/custom.test.js']).toBe('run')
    })
  }

  for (const workers of [1, 2]) {
    test(`a configured custom environment is an input (${workers === 1 ? 'in band' : 'workers'})`, () => {
      const s = jest(`configured-environment-${workers}`, workers, ['jest-environment-node'])
        .write('jest.config.js', "module.exports = { testEnvironment: '<rootDir>/env/custom.js' }\n")
        .write(
          'env/custom.js',
          "const { TestEnvironment } = require('jest-environment-node')\nmodule.exports = class extends TestEnvironment { constructor(...a) { super(...a); this.global.MARK = 'custom' } }\n",
        )
        .write('test/a.test.js', "test('env', () => expect(globalThis.MARK).toBe('custom'))\n")
        .write('test/b.test.js', PLAIN_TEST)
      s.capture()
      expect(s.actions()).toEqual({ 'test/a.test.js': 'skip', 'test/b.test.js': 'skip' })
      s.edit('env/custom.js', "'custom'", "'custom' + ''")
      expect(s.actions()).toEqual({ 'test/a.test.js': 'run', 'test/b.test.js': 'run' })
    })
  }

  test('a dependency change invalidates only the files that loaded it', () => {
    const s = jest('dependency')
      .write(
        'node_modules/tiny-dep/package.json',
        '{"name":"tiny-dep","version":"1.0.0","main":"index.js"}\n',
      )
      .write('node_modules/tiny-dep/index.js', 'module.exports = () => 1\n')
      .write(
        'test/dep.test.js',
        "const dep = require('tiny-dep')\ntest('dep', () => expect(dep()).toBe(1))\n",
      )
      .write('test/plain.test.js', PLAIN_TEST)
    s.capture()
    s.write('node_modules/tiny-dep/index.js', 'module.exports = () => 2\n')
    expect(s.actions()).toEqual({ 'test/dep.test.js': 'run', 'test/plain.test.js': 'skip' })
  })
})

describe('coverage', () => {
  const coverageHits = (s: Sandbox, file: string): Record<number, number> => {
    const report = JSON.parse(s.read('coverage/coverage-final.json')) as Record<
      string,
      { statementMap: Record<string, { start: { line: number } }>; s: Record<string, number> }
    >
    const entry = Object.entries(report).find(([f]) => f.endsWith(file))?.[1]
    if (!entry) throw new Error(`${file} is not in the coverage report`)
    const hits: Record<number, number> = {}
    for (const [id, loc] of Object.entries(entry.statementMap)) hits[loc.start.line] = entry.s[id] ?? 0
    return hits
  }

  for (const workers of [1, 2]) {
    test(`v8 coverage and capture share the profiler (${workers === 1 ? 'in band' : 'workers'})`, () => {
      const s = jest(`coverage-v8-${workers}`, workers)
        .write(
          'jest.config.js',
          "module.exports = { testEnvironment: 'node', coverageProvider: 'v8', coverageReporters: ['json'], collectCoverageFrom: ['src/**'] }\n",
        )
        .write(
          'src/math.js',
          'function add(a, b) {\n  return a + b\n}\nfunction mul(a, b) {\n  return a * b\n}\nmodule.exports = { add, mul }\n',
        )
        .write('test/add.test.js', ADD_TEST)
        .write('test/mul.test.js', MUL_TEST)
      expect(s.cli(['run', '--full', '--coverage']).code).toBe(0)
      expect(coverageHits(s, 'src/math.js')).toMatchObject({ 2: 1, 5: 1 })
      const reused = { 'test/add.test.js': 'skip', 'test/mul.test.js': 'skip' }
      expect(s.actions()).toEqual(reused)
      // mul's file is captured again, add's runs without capture: coverage still sees both.
      s.edit('src/math.js', 'return a * b', 'return a * b * 1')
      expect(s.actions()).toEqual({ ...reused, 'test/mul.test.js': 'run' })
      const second = s.cli(['run', '--full', '--coverage'])
      expect(second.outcomes.filter((o) => o.captured).map((o) => o.check.path)).toEqual(['test/mul.test.js'])
      expect(coverageHits(s, 'src/math.js')).toMatchObject({ 2: 1, 5: 1 })
      expect(s.actions()).toEqual(reused)
      s.edit('src/math.js', 'return a + b', 'return a + b + 0')
      expect(s.actions()).toEqual({ ...reused, 'test/add.test.js': 'run' })
    })
  }

  test("Jest's default (Babel) coverage is refused with a reason", () => {
    const s = jest('coverage-babel').write('test/plain.test.js', PLAIN_TEST)
    const result = s.raw(['run', '--full', '--coverage'])
    expect(result.code).toBe(2)
    expect(result.output).toContain("only with Jest's v8 provider (this project uses babel)")
  })
})

describe('inputs', () => {
  test('a JSON module required by a test is an input', () => {
    const s = jest('json-module')
      .write('fixtures/data.json', '{"n": 1}\n')
      .write(
        'test/json.test.js',
        "const data = require('../fixtures/data.json')\ntest('json', () => expect(data.n).toBe(1))\n",
      )
      .write('test/plain.test.js', PLAIN_TEST)
    s.capture()
    s.write('fixtures/data.json', '{"n": 1, "m": 2}\n')
    expect(s.actions()).toEqual({ 'test/json.test.js': 'run', 'test/plain.test.js': 'skip' })
  })

  test('files, listings and existence checks made by a test are inputs', () => {
    const s = jest('fs-inputs')
      .write('fixtures/a.txt', 'a')
      .write('fixtures/cases/one.txt', '1')
      .write(
        'test/read.test.js',
        "const fs = require('fs')\ntest('read', () => expect(fs.readFileSync(__dirname + '/../fixtures/a.txt', 'utf8')).toBe('a'))\n",
      )
      .write(
        'test/list.test.js',
        "const fs = require('fs')\ntest('list', () => expect(fs.readdirSync(__dirname + '/../fixtures/cases').length).toBeGreaterThan(0))\n",
      )
      .write(
        'test/exists.test.js',
        "const fs = require('fs')\ntest('exists', () => expect(fs.existsSync(__dirname + '/../fixtures/optional.txt')).toBe(false))\n",
      )
    s.capture()
    s.write('fixtures/a.txt', 'b')
    s.write('fixtures/cases/two.txt', '2')
    s.write('fixtures/optional.txt', 'now here')
    expect(s.actions()).toEqual({
      'test/exists.test.js': 'run',
      'test/list.test.js': 'run',
      'test/read.test.js': 'run',
    })
  })

  test('environment variables read by a test are inputs', () => {
    const s = jest('env')
      .write('test/env.test.js', "test('env', () => expect(process.env.FEATURE ?? 'off').toBe('off'))\n")
      .write('test/plain.test.js', PLAIN_TEST)
    s.capture()
    expect(s.actions({ FEATURE: 'off' })).toEqual({ 'test/env.test.js': 'run', 'test/plain.test.js': 'skip' })
    expect(s.actions()).toEqual({ 'test/env.test.js': 'skip', 'test/plain.test.js': 'skip' })
  })

  test('a snapshot file is an input, and a pass that wrote a snapshot is not evidence', () => {
    const s = jest('snapshot').write(
      'test/snap.test.js',
      "test('snap', () => expect({ a: 1 }).toMatchSnapshot())\n",
    )
    s.capture()
    expect(s.plan()['test/snap.test.js']?.reason).toBe('not-reusable')
    // Jest reads CI (it decides whether snapshots may be written), so plans use the same value.
    s.capture({ CI: 'true' })
    expect(s.actions({ CI: 'true' })['test/snap.test.js']).toBe('skip')
    s.edit('test/__snapshots__/snap.test.js.snap', '"a": 1', '"a": 2')
    expect(s.actions({ CI: 'true' })['test/snap.test.js']).toBe('run')
  })

  test('a version range in package.json is not an input; other fields are', () => {
    const manifest = (fields: Record<string, unknown>) =>
      JSON.stringify({ name: 'manifest', private: true, ...fields }, null, 2)
    const s = jest('manifest')
      .write('package.json', manifest({ devDependencies: { eslint: '^10.8.0' } }))
      .write('test/plain.test.js', PLAIN_TEST)
    s.capture()
    s.write('package.json', manifest({ devDependencies: { eslint: '^10.10.0' } }))
    expect(s.actions()['test/plain.test.js']).toBe('skip')
    s.write(
      'package.json',
      manifest({ devDependencies: { eslint: '^10.10.0' }, imports: { '#src/*': './src/*' } }),
    )
    expect(s.actions()['test/plain.test.js']).toBe('run')
  })

  test("a package's own name is an input only when it has exports", () => {
    const manifest = (fields: Record<string, unknown>) =>
      JSON.stringify({ private: true, ...fields }, null, 2)
    const s = jest('manifest-name')
      .write('package.json', manifest({ name: 'before' }))
      .write('test/plain.test.js', PLAIN_TEST)
    s.capture()
    s.write('package.json', manifest({ name: 'after' }))
    expect(s.actions()['test/plain.test.js']).toBe('skip')
    s.write('package.json', manifest({ name: 'after', exports: './index.js' }))
    s.capture()
    s.write('package.json', manifest({ name: 'renamed', exports: './index.js' }))
    expect(s.actions()['test/plain.test.js']).toBe('run')
  })

  for (const workers of [1, 2]) {
    test(`a bare import Jest resolves to a repository package by name depends on that name (${workers === 1 ? 'in band' : 'workers'})`, () => {
      const helper = (name: string) => JSON.stringify({ name, main: 'index.js' }, null, 2)
      const HASTE_TEST = "const helper = require('helper')\ntest('haste', () => expect(helper).toBe(7))\n"
      const s = jest(`haste-package-${workers}`, workers)
        .write('packages/helper/package.json', helper('helper'))
        .write('packages/helper/index.js', 'module.exports = 7\n')
        .write('packages/other/package.json', helper('other'))
        .write('packages/other/index.js', 'module.exports = 8\n')
        // Two files resolving the same name: in one worker, the second is served from Jest's cache.
        .write('test/haste-a.test.js', HASTE_TEST)
        .write('test/haste-b.test.js', HASTE_TEST)
        .write(
          'test/optional.test.js',
          "let ghost = null\ntry { ghost = require('ghost') } catch {}\ntest('optional', () => expect(ghost).toBe(null))\n",
        )
        .write('test/plain.test.js', PLAIN_TEST)
      s.capture()
      expect(Object.values(s.actions())).toEqual(['skip', 'skip', 'skip', 'skip'])
      // Renaming a package nothing looked up changes nothing.
      s.write('packages/other/package.json', helper('other-renamed'))
      expect(Object.values(s.actions())).toEqual(['skip', 'skip', 'skip', 'skip'])
      // A package taking a name a test looked up and did not find.
      s.write('packages/other/package.json', helper('ghost'))
      expect(s.actions()).toEqual({
        'test/haste-a.test.js': 'skip',
        'test/haste-b.test.js': 'skip',
        'test/optional.test.js': 'run',
        'test/plain.test.js': 'skip',
      })
      s.write('packages/other/package.json', helper('other'))
      // The package a test resolved by name giving up that name.
      s.write('packages/helper/package.json', helper('helper-renamed'))
      expect(s.actions()).toEqual({
        'test/haste-a.test.js': 'run',
        'test/haste-b.test.js': 'run',
        'test/optional.test.js': 'skip',
        'test/plain.test.js': 'skip',
      })
    })
  }

  test('a test that requires package.json depends on all of it', () => {
    const manifest = (range: string) =>
      JSON.stringify({ name: 'manifest', private: true, devDependencies: { eslint: range } }, null, 2)
    const s = jest('manifest-require')
      .write('package.json', manifest('^10.8.0'))
      .write(
        'test/manifest.test.js',
        "const pkg = require('../package.json')\ntest('range', () => expect(pkg.devDependencies.eslint).toMatch(/^\\^10/))\n",
      )
      .write('test/plain.test.js', PLAIN_TEST)
    s.capture()
    s.write('package.json', manifest('^10.10.0'))
    expect(s.actions()).toEqual({ 'test/manifest.test.js': 'run', 'test/plain.test.js': 'skip' })
  })

  test('transformer configuration is a shared input', () => {
    const s = jest('babel-config')
      .write('babel.config.js', 'module.exports = { plugins: [] }\n')
      .write('test/a.test.js', PLAIN_TEST)
    s.capture()
    s.write('babel.config.js', 'module.exports = { plugins: [], comments: false }\n')
    expect(s.plan()['test/a.test.js']?.reason).toBe('shared-inputs-changed')
  })

  test('a new manual mock may apply without any code change', () => {
    const s = jest('manual-mock')
      .write(
        'node_modules/tiny-dep/package.json',
        '{"name":"tiny-dep","version":"1.0.0","main":"index.js"}\n',
      )
      .write('node_modules/tiny-dep/index.js', 'module.exports = () => 1\n')
      .write(
        'test/dep.test.js',
        "const dep = require('tiny-dep')\ntest('dep', () => expect(dep()).toBe(1))\n",
      )
    s.capture()
    s.write('__mocks__/tiny-dep.js', 'module.exports = () => 2\n')
    expect(s.actions()['test/dep.test.js']).toBe('run')
  })

  test('global setup is a shared input', () => {
    const s = jest('global-setup')
      .write(
        'jest.config.js',
        "module.exports = { testEnvironment: 'node', globalSetup: '<rootDir>/global.js' }\n",
      )
      .write('global.js', 'module.exports = async () => { process.env.FROM_GLOBAL = "1" }\n')
      .write('test/a.test.js', PLAIN_TEST)
    s.capture()
    s.write('global.js', 'module.exports = async () => { process.env.FROM_GLOBAL = "2" }\n')
    expect(s.plan()['test/a.test.js']?.reason).toBe('shared-inputs-changed')
  })
})

describe('incremental capture', () => {
  for (const workers of [1, 2]) {
    test(`a full run records evidence only for files whose evidence is stale (${workers === 1 ? 'in band' : 'workers'})`, () => {
      const s = jest(`incremental-${workers}`, workers)
        .write('src/math.js', MATH)
        .write('test/add.test.js', ADD_TEST)
        .write('test/mul.test.js', MUL_TEST)
      const captured = (r: { outcomes: readonly { check: { path: string }; captured: boolean }[] }) =>
        Object.fromEntries(r.outcomes.map((o) => [o.check.path, o.captured]))
      expect(captured(s.capture())).toEqual({ 'test/add.test.js': true, 'test/mul.test.js': true })
      expect(captured(s.capture())).toEqual({ 'test/add.test.js': false, 'test/mul.test.js': false })
      s.edit('src/math.js', 'return a * b', 'return a * b * 1')
      expect(captured(s.capture())).toEqual({ 'test/add.test.js': false, 'test/mul.test.js': true })
      expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'skip' })
      // Precision survives a run where capture stopped and started again in the same worker.
      s.edit('src/math.js', 'return a + b', 'return a + b + 0')
      expect(s.actions()).toEqual({ 'test/add.test.js': 'run', 'test/mul.test.js': 'skip' })
    })
  }
})

describe('outcomes and channels', () => {
  test('a failing file always runs', () => {
    const s = jest('failing').write('test/fail.test.js', "test('fails', () => expect(1).toBe(2))\n")
    expect(s.cli(['run', '--full']).code).toBe(1)
    expect(s.actions()['test/fail.test.js']).toBe('run')
  })

  test('a pass that needed a retry is not evidence', () => {
    const s = jest('retry').write(
      'test/flaky.test.js',
      "jest.retryTimes(1)\nlet attempts = 0\ntest('flaky', () => { attempts++; expect(attempts).toBe(2) })\n",
    )
    s.capture()
    expect(s.plan()['test/flaky.test.js']?.reason).toBe('not-reusable')
  })

  test.runIf(TRACED_PLATFORMS.includes(`${process.platform}-${process.arch}`))(
    "a child process is traced: its reads are the test file's inputs",
    () => {
      const s = jest('spawn')
        .write('fixtures/x.txt', 'a')
        .write(
          'test/spawn.test.js',
          "const { execFileSync } = require('child_process')\ntest('spawn', () => expect(execFileSync(process.execPath, ['-e', 'process.stdout.write(require(\"fs\").readFileSync(\"fixtures/x.txt\", \"utf8\"))']).toString()).toBe('a'))\n",
        )
        .write('test/plain.test.js', PLAIN_TEST)
      s.capture()
      expect(s.actions()).toEqual({ 'test/plain.test.js': 'skip', 'test/spawn.test.js': 'skip' })
      s.write('fixtures/x.txt', 'b')
      expect(s.actions()).toEqual({ 'test/plain.test.js': 'skip', 'test/spawn.test.js': 'run' })
    },
  )
})

describe('failing open', () => {
  test('an internal error before the run falls back to running every test with Jest', () => {
    const s = jest('fail-open').write('test/a.test.js', PLAIN_TEST)
    const passing = s.raw(['run'], { VEYRUM_FAULT: 'before-run' })
    expect(passing.output).toContain('running the tests with jest directly, without Veyrum')
    expect(passing.code).toBe(0)
    s.write('test/b.test.js', "test('broken', () => expect(1).toBe(2))\n")
    expect(s.raw(['run'], { VEYRUM_FAULT: 'before-run' }).code).toBe(1)
  })
})
