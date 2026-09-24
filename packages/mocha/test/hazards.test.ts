import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox } from '../../../test/support/sandbox.ts'

/**
 * End-to-end scenarios for the Mocha adapter, through the real CLI and the project's Mocha. Each
 * records evidence, changes something, and asserts which files the plan runs.
 */

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

const project = (name: string): Sandbox => {
  sandbox = new Sandbox(name, { runner: 'mocha', workers: 2 })
  return sandbox
}

const MATH = 'export function add(a, b) { return a + b }\nexport function mul(a, b) { return a * b }\n'
const ADD_TEST =
  "import assert from 'node:assert'\nimport { add } from '../src/math.js'\nit('adds', () => assert.equal(add(1, 2), 3))\n"
const MUL_TEST =
  "import assert from 'node:assert'\nimport { mul } from '../src/math.js'\nit('muls', () => assert.equal(mul(2, 3), 6))\n"

describe('code', () => {
  test('an edit invalidates only the files that executed the changed function', () => {
    const s = project('mocha-units')
      .write('src/math.js', MATH)
      .write('test/add.test.js', ADD_TEST)
      .write('test/mul.test.js', MUL_TEST)
    const first = s.capture()
    expect(first.outcomes.map((o) => [o.check.path, o.verdict, o.captured])).toEqual([
      ['test/add.test.js', 'pass', true],
      ['test/mul.test.js', 'pass', true],
    ])
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'skip' })
    s.write('src/math.js', `// formatting only\n${MATH.replace('return a + b', 'return (a + b)')}`)
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'skip' })
    s.edit('src/math.js', 'return a * b', 'return a * b * 1')
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'run' })
    expect(s.plan()['test/mul.test.js']?.details).toEqual(['src/math.js: mul changed'])
  })

  test('CommonJS: an edit invalidates only the files that executed the changed function', () => {
    const s = project('mocha-cjs')
      .write('package.json', JSON.stringify({ name: 'mocha-cjs', private: true }))
      .write(
        'src/math.js',
        'function add(a, b) { return a + b }\nfunction mul(a, b) { return a * b }\nmodule.exports = { add, mul }\n',
      )
      .write(
        'test/add.test.js',
        "const assert = require('node:assert')\nconst { add } = require('../src/math')\nit('adds', () => assert.equal(add(1, 2), 3))\n",
      )
      .write(
        'test/mul.test.js',
        "const assert = require('node:assert')\nconst { mul } = require('../src/math')\nconst data = require('../fixtures/data.json')\nit('muls', () => assert.equal(mul(2, data.n), 6))\n",
      )
      .write('fixtures/data.json', '{"n": 3}\n')
    s.capture()
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'skip' })
    s.edit('src/math.js', 'return a * b', 'return b * a')
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'run' })
    s.capture()
    s.write('fixtures/data.json', '{"n": 3 }\n')
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'run' })
  })

  test("a module's source a test reads itself is an input, whole", () => {
    const s = project('mocha-source')
      .write('src/math.js', MATH)
      .write(
        'test/source.test.js',
        "import assert from 'node:assert'\nimport fs from 'node:fs'\nimport { add } from '../src/math.js'\nit('reads', () => { assert.equal(add(1, 2), 3); assert.ok(fs.readFileSync('src/math.js', 'utf8').length > 0) })\n",
      )
      .write('test/add.test.js', ADD_TEST)
    s.capture()
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/source.test.js': 'skip' })
    s.write('src/math.js', `// a comment\n${MATH}`)
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/source.test.js': 'run' })
  })

  test('a failing file is never reused', () => {
    const s = project('mocha-failing')
      .write('test/fail.test.js', "import assert from 'node:assert'\nit('fails', () => assert.equal(1, 2))\n")
      .write('test/pass.test.js', ADD_TEST)
      .write('src/math.js', MATH)
    const result = s.cli(['run', '--full'])
    expect(result.code).not.toBe(0)
    expect(Object.fromEntries(result.outcomes.map((o) => [o.check.path, o.verdict]))).toEqual({
      'test/fail.test.js': 'fail',
      'test/pass.test.js': 'pass',
    })
    expect(s.actions()).toEqual({ 'test/fail.test.js': 'run', 'test/pass.test.js': 'skip' })
  })
})

describe('inputs', () => {
  test('a fixture a test reads and a JSON module it imports are inputs', () => {
    const s = project('mocha-inputs')
      .write('fixtures/x.txt', 'a')
      .write('fixtures/data.json', '{"n": 1}\n')
      .write('fixtures/other.txt', 'o')
      .write(
        'test/read.test.js',
        "import assert from 'node:assert'\nimport fs from 'node:fs'\nit('reads', () => assert.match(fs.readFileSync('fixtures/x.txt', 'utf8'), /^[ab]$/))\n",
      )
      .write(
        'test/json.test.js',
        "import assert from 'node:assert'\nimport data from '../fixtures/data.json' with { type: 'json' }\nit('json', () => assert.ok(data.n > 0))\n",
      )
    s.capture()
    expect(s.actions()).toEqual({ 'test/json.test.js': 'skip', 'test/read.test.js': 'skip' })
    s.write('fixtures/other.txt', 'p')
    expect(s.actions()).toEqual({ 'test/json.test.js': 'skip', 'test/read.test.js': 'skip' })
    s.write('fixtures/x.txt', 'b')
    expect(s.actions()).toEqual({ 'test/json.test.js': 'skip', 'test/read.test.js': 'run' })
    s.write('fixtures/data.json', '{"n": 2}\n')
    expect(s.actions()['test/json.test.js']).toBe('run')
  })

  test('an environment variable a test reads is an input', () => {
    const s = project('mocha-env').write(
      'test/env.test.js',
      "import assert from 'node:assert'\nit('env', () => assert.ok(process.env.GREETING !== 'boom'))\n",
    )
    s.capture({ GREETING: 'hi' })
    expect(s.actions({ GREETING: 'hi' })['test/env.test.js']).toBe('skip')
    expect(s.actions({ GREETING: 'bye' })['test/env.test.js']).toBe('run')
  })
})

describe('configuration', () => {
  test("a change to Mocha's configuration reruns every file", () => {
    const s = project('mocha-config')
      .write('src/math.js', MATH)
      .write('test/add.test.js', ADD_TEST)
      .write('test/mul.test.js', MUL_TEST)
    s.capture()
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'skip' })
    s.write('.mocharc.json', `${JSON.stringify({ spec: ['test/**/*.test.js'], timeout: 5000 }, null, 2)}\n`)
    expect(s.actions()).toEqual({ 'test/add.test.js': 'run', 'test/mul.test.js': 'run' })
  })

  test('a file Mocha requires before the tests is an input, and runs in each file process', () => {
    const s = project('mocha-require')
      .write(
        '.mocharc.json',
        `${JSON.stringify({ spec: ['test/**/*.test.js'], require: ['./test/hooks.js'] }, null, 2)}\n`,
      )
      .write(
        'test/hooks.js',
        "export const mochaHooks = { beforeAll() { globalThis.ready = 'yes' } }\nexport function mochaGlobalSetup() { globalThis.setUp = (globalThis.setUp ?? 0) + 1 }\n",
      )
      .write('src/math.js', MATH)
      .write(
        'test/add.test.js',
        "import assert from 'node:assert'\nimport { add } from '../src/math.js'\nit('adds', () => { assert.equal(globalThis.ready, 'yes'); assert.equal(globalThis.setUp, 1); assert.equal(add(1, 2), 3) })\n",
      )
      .write('test/mul.test.js', MUL_TEST)
    s.capture()
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'skip' })
    s.edit('test/hooks.js', "globalThis.ready = 'yes'", "globalThis.ready = 'yes'; globalThis.extra = 1")
    expect(s.actions()).toEqual({ 'test/add.test.js': 'run', 'test/mul.test.js': 'run' })
  })

  test('a file named on the command line runs alone, whatever spec the configuration sets', () => {
    const s = project('mocha-only')
      .write('src/math.js', MATH)
      .write('test/fail.test.js', "import assert from 'node:assert'\nit('fails', () => assert.fail('ran'))\n")
      .write('test/mul.test.js', MUL_TEST)
    // The failing file would fail the run if Mocha loaded it along with the named one.
    const result = s.cli(['run', '--full', 'test/mul.test.js'])
    expect(result.code).toBe(0)
    expect(result.outcomes.map((o) => [o.check.path, o.verdict])).toEqual([['test/mul.test.js', 'pass']])
    expect(s.actions()).toEqual({ 'test/fail.test.js': 'run', 'test/mul.test.js': 'skip' })
  })
})
