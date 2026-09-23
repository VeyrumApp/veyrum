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
      'function String(x: unknown) { return `wrapped:${x}` }\nexport function describeIt',
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
