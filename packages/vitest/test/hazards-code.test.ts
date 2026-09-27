import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox } from '../../../test/support/sandbox.ts'

/** Code-level hazards: which edits to executed code must and must not invalidate evidence. */

const MATH = `export const LIMIT = 10
export function add(a: number, b: number): number {
  return a + b
}
export function mul(a: number, b: number): number {
  return a * b
}
export const handlers = { one: (x: number) => x, two: (x: number) => x * 2 }
`

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

function mathProject(name: string): Sandbox {
  sandbox = new Sandbox(name)
    .write('src/math.ts', MATH)
    .write(
      'test/add.test.ts',
      "import { expect, test } from 'vitest'\nimport { add } from '../src/math'\ntest('add', () => expect(add(1, 2)).toBe(3))\n",
    )
    .write(
      'test/mul.test.ts',
      "import { expect, test } from 'vitest'\nimport { mul } from '../src/math'\ntest('mul', () => expect(mul(2, 3)).toBe(6))\n",
    )
    .write(
      'test/limit.test.ts',
      "import { expect, test } from 'vitest'\nimport { LIMIT } from '../src/math'\ntest('limit', () => expect(LIMIT).toBe(10))\n",
    )
  sandbox.capture()
  return sandbox
}

describe('code edits', () => {
  test('a repository module Node loads itself is compared by the functions the test ran', () => {
    // Required through Node's own loader, as an externalized workspace package's build is.
    sandbox = new Sandbox('native-module')
      .write(
        'lib/helper.cjs',
        'exports.used = function used() { return 1 }\nexports.unused = function unused() { return 2 }\n',
      )
      .write(
        'test/native.test.ts',
        "import { createRequire } from 'node:module'\nimport { expect, test } from 'vitest'\nconst { used } = createRequire(import.meta.url)('../lib/helper.cjs')\ntest('native', () => expect(used()).toBe(1))\n",
      )
    sandbox.capture()
    sandbox.edit('lib/helper.cjs', 'return 2', 'return 3')
    expect(sandbox.actions()['test/native.test.ts']).toBe('skip')
    sandbox.edit('lib/helper.cjs', 'return 1', 'return 1 + 0')
    const decision = sandbox.plan()['test/native.test.ts']
    expect(decision?.action).toBe('run')
    expect(decision?.details.join(' ')).toContain('lib/helper.cjs: used')
  })

  test('a natively loaded module an earlier file left state in is compared whole', () => {
    // If a worker kept Node's module cache from one file to the next, b would read what a computed.
    sandbox = new Sandbox('native-state')
      .edit('vitest.config.ts', 'test: {}', 'test: { fileParallelism: false }')
      .write(
        'lib/cache.cjs',
        'let cached\nexports.compute = function compute() { return 1 }\nexports.get = function get() { if (cached === undefined) cached = exports.compute(); return cached }\n',
      )
      .write(
        'test/a.test.ts',
        "import { createRequire } from 'node:module'\nimport { expect, test } from 'vitest'\nconst { get } = createRequire(import.meta.url)('../lib/cache.cjs')\n// Longer than b, so the sequencer runs it first.\ntest('fills the cache', () => {\n  expect(get()).toBe(1)\n  expect(get()).toBe(1)\n  expect(get()).toBe(1)\n})\n",
      )
      .write(
        'test/b.test.ts',
        "import { createRequire } from 'node:module'\nimport { expect, test } from 'vitest'\nconst { get } = createRequire(import.meta.url)('../lib/cache.cjs')\ntest('reads it', () => expect(get()).toBe(1))\n",
      )
    sandbox.capture()
    sandbox.edit('lib/cache.cjs', 'return 1 }', 'return 2 }')
    expect(sandbox.actions()).toEqual({ 'test/a.test.ts': 'run', 'test/b.test.ts': 'run' })
  })

  test('a module the main process and a test both load natively stays an input of the test', () => {
    // A project's global setup runs one function of the module; the test process loads it too.
    sandbox = new Sandbox('native-main')
      .write(
        'vitest.config.ts',
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { projects: [{ test: { name: 'unit', include: ['test/**/*.test.ts'], globalSetup: ['setup/global.ts'] } }] } })\n",
      )
      .write(
        'lib/shared.cjs',
        'exports.seed = function seed() { return 1 }\nexports.twice = function twice(n) { return n * 2 }\n',
      )
      .write(
        'setup/global.ts',
        "import { createRequire } from 'node:module'\nexport default function setup({ provide }) {\n  provide('seed', createRequire(import.meta.url)('../lib/shared.cjs').seed())\n}\n",
      )
      .write(
        'test/uses.test.ts',
        "import { createRequire } from 'node:module'\nimport { expect, inject, test } from 'vitest'\nconst { twice } = createRequire(import.meta.url)('../lib/shared.cjs')\ntest('uses', () => expect(twice(inject('seed'))).toBe(2))\n",
      )
    sandbox.capture()
    sandbox.edit('lib/shared.cjs', 'return 1 }', 'return 2 }')
    expect(sandbox.actions()['test/uses.test.ts']).toBe('run')
  })

  test('code the main process loads from outside the project is an input', () => {
    // The project is a directory of a monorepo whose own packages build its toolchain, as Vitest's
    // tests are: the runner loads a package's build through Node's loader, from outside the root.
    const mono = fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-mono-'))
    try {
      const plugin = path.join(mono, 'packages', 'plugin', 'index.cjs')
      fs.mkdirSync(path.dirname(plugin), { recursive: true })
      fs.writeFileSync(
        plugin,
        "exports.plugin = () => ({ name: 'value', transform: (code) => code.replace('__VALUE__', '1') })\n",
      )
      fs.mkdirSync(path.join(mono, 'apps'))
      sandbox = new Sandbox('outside-root', { base: path.join(mono, 'apps') })
        .write(
          'vitest.config.ts',
          `import { createRequire } from 'node:module'\nimport { defineConfig } from 'vitest/config'\nconst { plugin } = createRequire(import.meta.url)(${JSON.stringify(plugin)})\nexport default defineConfig({ plugins: [plugin()], test: {} })\n`,
        )
        .write(
          'test/value.test.ts',
          "import { expect, test } from 'vitest'\ntest('value', () => expect('__VALUE__').toBe('1'))\n",
        )
      sandbox.capture()
      expect(sandbox.actions()['test/value.test.ts']).toBe('skip')
      fs.writeFileSync(plugin, fs.readFileSync(plugin, 'utf8').replace("'1'", "'2'"))
      expect(sandbox.actions()['test/value.test.ts']).toBe('run')
    } finally {
      sandbox?.dispose()
      sandbox = undefined
      fs.rmSync(mono, { recursive: true, force: true })
    }
  })

  test('a runner the repository builds and links is an input, including code loaded before recording', () => {
    // A monorepo testing its own runner links the build into node_modules: its files change with
    // every edit while its manifest does not. The main process loads most of it before recording.
    const mono = fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-mono-'))
    try {
      const installed = fs.realpathSync(
        path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
      )
      const built = path.join(mono, 'packages', 'vitest')
      fs.cpSync(installed, built, { recursive: true })
      // Its dependencies, where the workspace install would have put them.
      fs.rmSync(path.join(built, 'node_modules'), { recursive: true, force: true })
      fs.symlinkSync(path.dirname(installed), path.join(built, 'node_modules'), 'junction')
      fs.mkdirSync(path.join(mono, 'apps'))
      sandbox = new Sandbox('linked-runner', { base: path.join(mono, 'apps') })
      fs.rmSync(path.join(sandbox.dir, 'node_modules', 'vitest'))
      fs.symlinkSync(built, path.join(sandbox.dir, 'node_modules', 'vitest'), 'junction')
      sandbox.write(
        'test/plain.test.ts',
        "import { expect, test } from 'vitest'\ntest('plain', () => expect(1).toBe(1))\n",
      )
      sandbox.capture()
      expect(sandbox.actions()['test/plain.test.ts']).toBe('skip')
      // The Node API's entry, which the adapter imports before recording starts.
      const entry = path.join(built, 'dist', 'node.js')
      fs.appendFileSync(entry, '\n// rebuilt\n')
      const decision = sandbox.plan()['test/plain.test.ts']
      expect(decision?.action).toBe('run')
      expect(decision?.details.join(' ')).toContain('packages/vitest/dist/node.js')
    } finally {
      sandbox?.dispose()
      sandbox = undefined
      fs.rmSync(mono, { recursive: true, force: true })
    }
  })

  test('nothing changed: every test file is reused', () => {
    const sb = mathProject('unchanged')
    expect(sb.actions()).toEqual({
      'test/add.test.ts': 'skip',
      'test/limit.test.ts': 'skip',
      'test/mul.test.ts': 'skip',
    })
  })

  test('a function body edit reruns only the test files that executed it', () => {
    const sb = mathProject('body-edit')
    sb.edit('src/math.ts', 'return a * b', 'return b * a')
    const plan = sb.plan()
    expect(plan['test/mul.test.ts']?.action).toBe('run')
    expect(plan['test/mul.test.ts']?.details.join(' ')).toContain('mul')
    expect(plan['test/add.test.ts']?.action).toBe('skip')
    expect(plan['test/limit.test.ts']?.action).toBe('skip')
  })

  test('changing a private helper reruns only the files that executed it', () => {
    sandbox = new Sandbox('private-helper')
      .write(
        'src/eq.ts',
        'function compareArrays(a: unknown[], b: unknown[]) { return a.length === b.length }\n' +
          'export function equal(a: unknown, b: unknown) { return Array.isArray(a) && Array.isArray(b) ? compareArrays(a, b) : a === b }\n' +
          'export function same(a: unknown, b: unknown) { return Object.is(a, b) }\n',
      )
      .write(
        'test/equal.test.ts',
        "import { expect, test } from 'vitest'\nimport { equal } from '../src/eq'\ntest('arrays', () => expect(equal([1], [2])).toBe(true))\n",
      )
      .write(
        'test/same.test.ts',
        "import { expect, test } from 'vitest'\nimport { same } from '../src/eq'\ntest('same', () => expect(same(1, 1)).toBe(true))\n",
      )
    sandbox.capture()
    // A new parameter on the private helper, and a new private helper: only callers are affected.
    sandbox.edit(
      'src/eq.ts',
      'function compareArrays(a: unknown[], b: unknown[]) {',
      'function compareArrays(a: unknown[], b: unknown[], depth = 0) {',
    )
    sandbox.edit('src/eq.ts', 'export function same', 'function unused() { return 0 }\nexport function same')
    expect(sandbox.actions()).toEqual({ 'test/equal.test.ts': 'run', 'test/same.test.ts': 'skip' })
  })

  test('a new module binding that captures a global name reruns the files using that name', () => {
    sandbox = new Sandbox('captured-global')
      .write(
        'src/util.ts',
        'export function describeIt() { return String(JSON.stringify({ a: 1 })) }\nexport function other() { return 2 }\n',
      )
      .write(
        'test/describe.test.ts',
        "import { expect, test } from 'vitest'\nimport { describeIt } from '../src/util'\ntest('d', () => expect(describeIt()).toBe('{\"a\":1}'))\n",
      )
      .write(
        'test/other.test.ts',
        "import { expect, test } from 'vitest'\nimport { other } from '../src/util'\ntest('o', () => expect(other()).toBe(2))\n",
      )
    sandbox.capture()
    // `String` now resolves to a module function instead of the global.
    sandbox.edit(
      'src/util.ts',
      'export function describeIt',
      'function String(x: unknown) { return "wrapped:" + x }\nexport function describeIt',
    )
    expect(sandbox.actions()).toEqual({ 'test/describe.test.ts': 'run', 'test/other.test.ts': 'skip' })
  })

  test('comments and formatting never invalidate', () => {
    const sb = mathProject('formatting')
    sb.edit(
      'src/math.ts',
      'export function add(a: number, b: number): number {\n  return a + b\n}',
      '/** Adds. */\nexport function add(a: number,   b: number): number { return a + b /* sum */ }',
    )
    expect(Object.values(sb.actions())).toEqual(['skip', 'skip', 'skip'])
  })

  test('a module-level constant change reruns every importer', () => {
    const sb = mathProject('constant')
    sb.edit('src/math.ts', 'LIMIT = 10', 'LIMIT = 11')
    expect(Object.values(sb.actions())).toEqual(['run', 'run', 'run'])
  })

  test('an arity change of an unexecuted function is visible (fn.length)', () => {
    const sb = mathProject('arity')
    sb.edit('src/math.ts', 'two: (x: number) => x * 2', 'two: (x: number, y: number) => x * y')
    expect(Object.values(sb.actions())).toEqual(['run', 'run', 'run'])
  })

  test('type-only changes are erased by the transform and reused', () => {
    const sb = mathProject('types')
    sb.edit(
      'src/math.ts',
      'export function add(a: number, b: number): number',
      'export function add(a: number, b: number): number | never',
    )
    sb.write('src/math.ts', `export interface Shape { readonly sides: number }\n${sb.read('src/math.ts')}`)
    expect(Object.values(sb.actions())).toEqual(['skip', 'skip', 'skip'])
  })

  test('adding an unexecuted export reruns importers (conservative top-level rule)', () => {
    const sb = mathProject('new-export')
    sb.write('src/math.ts', `${MATH}export function sub(a: number, b: number): number {\n  return a - b\n}\n`)
    expect(Object.values(sb.actions())).toEqual(['run', 'run', 'run'])
  })

  test('a removed module reruns its importers', () => {
    const sb = mathProject('removed')
    sb.remove('src/math.ts')
    expect(Object.values(sb.actions())).toEqual(['run', 'run', 'run'])
  })

  test('a new test file has no evidence and runs', () => {
    const sb = mathProject('new-test')
    sb.write('test/new.test.ts', "import { test } from 'vitest'\ntest('new', () => {})\n")
    const actions = sb.actions()
    expect(actions['test/new.test.ts']).toBe('run')
    expect(actions['test/add.test.ts']).toBe('skip')
  })

  test('reverting a change reuses the older evidence (content-addressed, any history)', () => {
    const sb = mathProject('revert')
    sb.edit('src/math.ts', 'return a + b', 'return b + a')
    const affected = sb.cli(['run'])
    expect(affected.code).toBe(0)
    expect(affected.decisions.find((d) => d.check.path === 'test/add.test.ts')?.action).toBe('run')
    sb.edit('src/math.ts', 'return b + a', 'return a + b')
    expect(sb.actions()['test/add.test.ts']).toBe('skip')
  })

  test('an affected run records new evidence, so the next plan reuses it', () => {
    const sb = mathProject('affected')
    sb.edit('src/math.ts', 'return a * b', 'return b * a')
    const affected = sb.cli(['run'])
    expect(affected.code).toBe(0)
    expect(Object.values(sb.actions())).toEqual(['skip', 'skip', 'skip'])
  })

  test('a test that observes source text compares raw source', () => {
    sandbox = new Sandbox('to-string')
      .write('src/math.ts', MATH)
      .write(
        'test/source.test.ts',
        "import { expect, test } from 'vitest'\nimport { add } from '../src/math'\ntest('source', () => expect(add.toString()).toContain('return'))\n",
      )
    sandbox.capture()
    sandbox.edit('src/math.ts', 'return a + b', 'return a + b // sum')
    const plan = sandbox.plan()
    expect(plan['test/source.test.ts']?.action).toBe('run')
  })

  test('only the module whose function source a test read is compared by raw source', () => {
    sandbox = new Sandbox('to-string-scoped')
      .write('src/math.ts', MATH)
      .write('src/other.ts', 'export function twice(n: number): number {\n  return n * 2\n}\n')
      .write(
        'test/source.test.ts',
        "import { expect, test } from 'vitest'\nimport { add } from '../src/math'\nimport { twice } from '../src/other'\ntest('source', () => {\n  expect(add.toString()).toContain('return')\n  expect(twice(2)).toBe(4)\n})\n",
      )
    sandbox.capture()
    // A comment in the other module changes no unit it executed.
    sandbox.edit('src/other.ts', 'return n * 2', 'return n * 2 // double')
    expect(sandbox.actions()['test/source.test.ts']).toBe('skip')
    sandbox.edit('src/math.ts', 'return a + b', 'return a + b // sum')
    expect(sandbox.plan()['test/source.test.ts']?.details).toEqual([
      'src/math.ts changed (raw source compared because the test observes source text or positions)',
    ])
  })
})

describe('module loading', () => {
  test('dynamic imports record only the modules actually loaded', () => {
    sandbox = new Sandbox('dynamic-import')
      .write('src/plugins/a.ts', 'export const name = "a"\n')
      .write('src/plugins/b.ts', 'export const name = "b"\n')
      .write(
        'test/plugin.test.ts',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source code with its own template literal
        "import { expect, test } from 'vitest'\nconst which = 'a'\ntest('plugin', async () => {\n  const mod = await import(`../src/plugins/${which}.ts`)\n  expect(mod.name).toBe('a')\n})\n",
      )
    sandbox.capture()
    sandbox.edit('src/plugins/b.ts', '"b"', '"bb"')
    expect(sandbox.actions()['test/plugin.test.ts']).toBe('skip')
    sandbox.edit('src/plugins/a.ts', 'export const name = "a"', 'export const name = "a" as const')
    expect(sandbox.actions()['test/plugin.test.ts']).toBe('skip')
    sandbox.edit('src/plugins/a.ts', '"a"', '"A"')
    expect(sandbox.actions()['test/plugin.test.ts']).toBe('run')
  })

  test('a module replaced by a vi.mock factory is not an input; the factory is', () => {
    sandbox = new Sandbox('mock-factory')
      .write('src/dep.ts', 'export function value(): number {\n  return 1\n}\n')
      .write(
        'src/use.ts',
        "import { value } from './dep'\nexport function twice(): number {\n  return value() * 2\n}\n",
      )
      .write(
        'test/mocked.test.ts',
        "import { expect, test, vi } from 'vitest'\nimport { twice } from '../src/use'\nvi.mock('../src/dep', () => ({ value: () => 5 }))\ntest('mocked', () => expect(twice()).toBe(10))\n",
      )
    sandbox.capture()
    sandbox.edit('src/dep.ts', 'return 1', 'return 2')
    expect(sandbox.actions()['test/mocked.test.ts']).toBe('skip')
    sandbox.edit('test/mocked.test.ts', 'value: () => 5', 'value: () => 6')
    expect(sandbox.actions()['test/mocked.test.ts']).toBe('run')
  })

  test('import.meta.glob modules are re-transformed so new matches are seen', () => {
    sandbox = new Sandbox('glob')
      .write('src/items/a.ts', 'export default 1\n')
      .write('src/items/b.ts', 'export default 2\n')
      .write(
        'src/registry.ts',
        "const items = import.meta.glob('./items/*.ts', { eager: true })\nexport const count = Object.keys(items).length\n",
      )
      .write(
        'test/registry.test.ts',
        "import { expect, test } from 'vitest'\nimport { count } from '../src/registry'\ntest('count', () => expect(count).toBe(2))\n",
      )
    sandbox.capture()
    expect(sandbox.actions()['test/registry.test.ts']).toBe('skip')
    sandbox.write('src/items/c.ts', 'export default 3\n')
    expect(sandbox.actions()['test/registry.test.ts']).toBe('run')
  })

  test('a module that only mentions import.meta.glob is reused unchanged', () => {
    sandbox = new Sandbox('glob-mention')
      .write(
        'src/meta.ts',
        'export function glob(): never {\n  throw new Error(\'"import.meta.glob" is replaced at build time\')\n}\n',
      )
      .write(
        'test/meta.test.ts',
        "import { expect, test } from 'vitest'\nimport { glob } from '../src/meta'\ntest('source', () => expect(glob.toString()).toContain('throw'))\n",
      )
    sandbox.capture()
    expect(sandbox.actions()['test/meta.test.ts']).toBe('skip')
  })

  test('a new file that would win module resolution invalidates importers', () => {
    sandbox = new Sandbox('shadow')
      .write('src/util.ts', 'export const kind = "ts"\n')
      .write(
        'test/util.test.ts',
        "import { expect, test } from 'vitest'\nimport { kind } from '../src/util'\ntest('kind', () => expect(kind).toBe('ts'))\n",
      )
    sandbox.capture()
    sandbox.write('src/util.js', 'export const kind = "js"\n')
    expect(sandbox.actions()['test/util.test.ts']).toBe('run')
  })
})
