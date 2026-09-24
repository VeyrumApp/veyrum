import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox } from '../../../test/support/sandbox.ts'

/**
 * End-to-end scenarios for the node:test adapter, through the real CLI and `node --test`. Each
 * records evidence, changes something, and asserts which files the plan runs.
 */

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

const project = (name: string): Sandbox => {
  sandbox = new Sandbox(name, { runner: 'node-test' })
  return sandbox
}

const MATH = 'export function add(a, b) { return a + b }\nexport function mul(a, b) { return a * b }\n'
const ADD_TEST =
  "import test from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/math.js'\ntest('adds', () => assert.equal(add(1, 2), 3))\n"
const MUL_TEST =
  "import test from 'node:test'\nimport assert from 'node:assert'\nimport { mul } from '../src/math.js'\ntest('muls', () => assert.equal(mul(2, 3), 6))\n"

describe('code', () => {
  test('an edit invalidates only the files that executed the changed function', () => {
    const s = project('node-units')
      .write('src/math.js', MATH)
      .write('test/add.test.js', ADD_TEST)
      .write('test/mul.test.js', MUL_TEST)
    expect(s.capture().code).toBe(0)
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'skip' })
    s.write('src/math.js', `// formatting only\n${MATH.replace('return a + b', 'return (a + b)')}`)
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'skip' })
    s.edit('src/math.js', 'return a * b', 'return a * b * 1')
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'run' })
    expect(s.plan()['test/mul.test.js']?.details).toEqual(['src/math.js: mul changed'])
  })

  test('CommonJS: an edit invalidates only the files that executed the changed function', () => {
    const s = project('node-cjs')
      .write(
        'package.json',
        JSON.stringify({ name: 'node-cjs', private: true, scripts: { test: 'node --test' } }),
      )
      .write(
        'src/math.js',
        'function add(a, b) { return a + b }\nfunction mul(a, b) { return a * b }\nmodule.exports = { add, mul }\n',
      )
      .write(
        'test/add.test.js',
        "const test = require('node:test')\nconst assert = require('node:assert')\nconst { add } = require('../src/math')\ntest('adds', () => assert.equal(add(1, 2), 3))\n",
      )
      .write(
        'test/mul.test.js',
        "const test = require('node:test')\nconst assert = require('node:assert')\nconst { mul } = require('../src/math')\ntest('muls', () => assert.equal(mul(2, 3), 6))\n",
      )
    s.capture()
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'skip' })
    s.edit('src/math.js', 'return a * b', 'return b * a')
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/mul.test.js': 'run' })
  })

  test('a failing file is never reused', () => {
    const s = project('node-failing')
      .write(
        'test/fail.test.js',
        "import test from 'node:test'\nimport assert from 'node:assert'\ntest('fails', () => assert.equal(1, 2))\n",
      )
      .write('test/pass.test.js', ADD_TEST)
      .write('src/math.js', MATH)
    expect(s.cli(['run', '--full']).code).not.toBe(0)
    expect(s.actions()).toEqual({ 'test/fail.test.js': 'run', 'test/pass.test.js': 'skip' })
  })
})

describe('inputs', () => {
  test('a fixture a test reads and a JSON module it imports are inputs', () => {
    const s = project('node-inputs')
      .write('fixtures/x.txt', 'a')
      .write('fixtures/data.json', '{"n": 1}\n')
      .write('fixtures/other.txt', 'o')
      .write(
        'test/read.test.js',
        "import test from 'node:test'\nimport assert from 'node:assert'\nimport fs from 'node:fs'\ntest('reads', () => assert.match(fs.readFileSync('fixtures/x.txt', 'utf8'), /^[ab]$/))\n",
      )
      .write(
        'test/json.test.js',
        "import test from 'node:test'\nimport assert from 'node:assert'\nimport data from '../fixtures/data.json' with { type: 'json' }\ntest('json', () => assert.ok(data.n > 0))\n",
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

  test("the planner's own reads of a changed input are no runner input", () => {
    const s = project('node-planner-reads')
      .write('fixtures/x.txt', 'a')
      .write(
        'test/read.test.js',
        "import test from 'node:test'\nimport assert from 'node:assert'\nimport fs from 'node:fs'\ntest('reads', () => assert.match(fs.readFileSync('fixtures/x.txt', 'utf8'), /^[abc]$/))\n",
      )
      .write('test/add.test.js', ADD_TEST)
      .write('src/math.js', MATH)
    s.capture()
    // The run plans first, reading the changed fixture to compare it: that read is not the runner's.
    s.write('fixtures/x.txt', 'b')
    expect(s.cli(['run']).code).toBe(0)
    s.write('fixtures/x.txt', 'c')
    expect(s.actions()).toEqual({ 'test/add.test.js': 'skip', 'test/read.test.js': 'run' })
  })

  test('an environment variable a test reads is an input', () => {
    const s = project('node-env').write(
      'test/env.test.js',
      "import test from 'node:test'\nimport assert from 'node:assert'\ntest('env', () => assert.ok(process.env.GREETING !== 'boom'))\n",
    )
    s.capture({ GREETING: 'hi' })
    expect(s.actions({ GREETING: 'hi' })['test/env.test.js']).toBe('skip')
    expect(s.actions({ GREETING: 'bye' })['test/env.test.js']).toBe('run')
  })
})
