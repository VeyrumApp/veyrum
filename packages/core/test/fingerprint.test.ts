import { describe, expect, test } from 'vitest'
import { fingerprintModule, OPAQUE_UNIT, TOP_UNIT } from '../src/index.ts'

const units = (code: string, root?: string) => {
  const m = fingerprintModule(code, root ? { root } : {})
  return Object.fromEntries([...m.units.values()].map((u) => [u.path, u.fp]))
}

describe('unit identity', () => {
  test('names units by declaration, binding, property, method and call site', () => {
    const code = `
      function add(a, b) { return a + b }
      const mul = (a, b) => a * b
      const o = { m() { return 1 }, get g() { return 2 }, p: () => 3 }
      class C { meth() {} static s() {} #priv() {} field = () => 4 }
      test("adds numbers", () => { add(1, 2) })
      export default function () {}
    `
    expect(Object.keys(units(code)).sort()).toEqual(
      [
        TOP_UNIT,
        '@top/fn:add#0',
        '@top/v:mul#0',
        '@top/p:m#0',
        '@top/p:get g#0',
        '@top/p:p#0',
        '@top/m:meth#0',
        '@top/m:static s#0',
        '@top/m:#priv#0',
        '@top/f:field#0',
        '@top/c:test("adds numbers")#0',
        '@top/default#0',
      ].sort(),
    )
  })

  test('disambiguates same-named siblings with ordinals', () => {
    const code = 'test("x", () => 1); test("x", () => 2)'
    expect(Object.keys(units(code))).toContain('@top/c:test("x")#1')
  })

  test('nests paths under the enclosing unit', () => {
    expect(Object.keys(units('function outer() { const inner = () => 1; return inner }'))).toContain(
      '@top/fn:outer#0/v:inner#0',
    )
  })
})

describe('fingerprint stability', () => {
  test('ignores comments, whitespace and quote style', () => {
    const a = units(`function f(a) { return a + "x" }`)
    const b = units(`// comment\nfunction f(a) {\n  /* inner */ return a + 'x'\n}`)
    expect(b).toEqual(a)
  })

  test('replaces the repository root inside string literals', () => {
    const a = units(`const p = "/home/a/repo/src/x.ts"`, '/home/a/repo')
    const b = units(`const p = "/tmp/other/src/x.ts"`, '/tmp/other')
    expect(a).toEqual(b)
  })

  test('normalizes Vite SSR import aliases to their specifier', () => {
    const a = units(
      `const __vite_ssr_import_0__ = await __vite_ssr_import__("/src/a.ts");\nfunction f() { return __vite_ssr_import_0__.x }`,
    )
    const b = units(
      `const __vite_ssr_import_0__ = await __vite_ssr_import__("/src/z.ts");\nconst __vite_ssr_import_1__ = await __vite_ssr_import__("/src/a.ts");\nfunction f() { return __vite_ssr_import_1__.x }`,
    )
    expect(b['@top/fn:f#0']).toBe(a['@top/fn:f#0'])
    expect(b[TOP_UNIT]).not.toBe(a[TOP_UNIT])
  })
})

describe('fingerprint sensitivity', () => {
  const base = units('function f(a) { return a + 1 }\nfunction g() { return 2 }')

  test('a body edit changes only that unit', () => {
    const next = units('function f(a) { return a + 2 }\nfunction g() { return 2 }')
    expect(next['@top/fn:f#0']).not.toBe(base['@top/fn:f#0'])
    expect(next['@top/fn:g#0']).toBe(base['@top/fn:g#0'])
    expect(next[TOP_UNIT]).toBe(base[TOP_UNIT])
  })

  test('an arity change of a function that escapes is visible to the enclosing unit', () => {
    const a = units('export function f(a) { return a + 1 }')
    const b = units('export function f(a, b) { return a + 1 }')
    expect(b[TOP_UNIT]).not.toBe(a[TOP_UNIT])
  })

  test('a default parameter changes fn.length and so the enclosing unit', () => {
    const a = units('function f(a, b) {}\nexport default f')
    const b = units('function f(a, b = 1) {}\nexport default f')
    expect(b[TOP_UNIT]).not.toBe(a[TOP_UNIT])
  })

  test('async-ness and generator-ness are part of the signature', () => {
    const a = units('const f = () => 1\nexports.f = f')
    expect(units('const f = async () => 1\nexports.f = f')[TOP_UNIT]).not.toBe(a[TOP_UNIT])
    expect(units('function* g() {}\nuse(g)')[TOP_UNIT]).not.toBe(units('function g() {}\nuse(g)')[TOP_UNIT])
  })

  test('a module constant change invalidates the top level', () => {
    expect(units('export const LIMIT = 10')[TOP_UNIT]).not.toBe(units('export const LIMIT = 5')[TOP_UNIT])
  })

  test('a class field initializer change invalidates the enclosing unit', () => {
    const a = units('class C { x = 1; m() {} }')
    const b = units('class C { x = 2; m() {} }')
    expect(b[TOP_UNIT]).not.toBe(a[TOP_UNIT])
    expect(b['@top/m:m#0']).toBe(a['@top/m:m#0'])
  })

  test('adding a method changes the class (enclosing) unit', () => {
    expect(units('class B extends A { m() {} }')[TOP_UNIT]).not.toBe(units('class B extends A {}')[TOP_UNIT])
  })

  test('string, number, regex and bigint literal values are distinguished', () => {
    expect(units('f("a")')[TOP_UNIT]).not.toBe(units('f("b")')[TOP_UNIT])
    expect(units('f(1)')[TOP_UNIT]).not.toBe(units('f(2)')[TOP_UNIT])
    expect(units('f(/a/g)')[TOP_UNIT]).not.toBe(units('f(/a/i)')[TOP_UNIT])
    expect(units('f(1n)')[TOP_UNIT]).not.toBe(units('f(2n)')[TOP_UNIT])
    expect(units('f(1n)')[TOP_UNIT]).not.toBe(units('f(1)')[TOP_UNIT])
  })

  test('template raw text is kept (String.raw observes it)', () => {
    expect(units('String.raw`a\\n`')[TOP_UNIT]).not.toBe(units('String.raw`a\\x0a`')[TOP_UNIT])
  })

  test('CommonJS with a top-level return is fingerprinted, not opaque', () => {
    const m = fingerprintModule(
      '"use strict";\nif (typeof x === "undefined") return;\nexports.f = function f() { return 1 }',
    )
    expect(m.opaque).toBe(false)
    expect([...m.units.keys()]).toContain('@top/fn:f#0')
  })

  test('unparseable code becomes one opaque unit', () => {
    const m = fingerprintModule('function (')
    expect(m.opaque).toBe(true)
    expect([...m.units.keys()]).toEqual([OPAQUE_UNIT])
    expect(m.locate(0, 3)).toBe(OPAQUE_UNIT)
  })
})

describe('private functions and bindings', () => {
  const helper = (params: string, extra = '') =>
    `function helper(${params}) { return 1 }\n${extra}export function api(x) { return helper(x) }`

  test("a private helper's signature does not reach the top level", () => {
    const a = units(helper('a'))
    const b = units(helper('a, b'))
    expect(b[TOP_UNIT]).toBe(a[TOP_UNIT])
    expect(b['@top/fn:api#0']).toBe(a['@top/fn:api#0'])
    expect(b['@top/fn:helper#0']).not.toBe(a['@top/fn:helper#0'])
  })

  test('adding a private helper changes only the units that mention its name', () => {
    const a = units(helper('a'))
    const b = units(helper('a', 'function other() { return 2 }\n'))
    expect(b[TOP_UNIT]).toBe(a[TOP_UNIT])
    expect(b['@top/fn:api#0']).toBe(a['@top/fn:api#0'])
  })

  test('a new module binding changes units that mentioned the name as a global', () => {
    const a = units('export function api() { return format(1) }')
    const b = units('function format(x) { return x }\nexport function api() { return format(1) }')
    expect(b['@top/fn:api#0']).not.toBe(a['@top/fn:api#0'])
  })

  test('a function used as a value, with new, as a tag or exported escapes', () => {
    for (const use of [
      'register(helper)',
      'new helper()',
      'helper`x`',
      'export { helper }',
      'typeof helper',
    ]) {
      const a = units(`function helper(a) {}\n${use}`)
      const b = units(`function helper(a, b) {}\n${use}`)
      expect(b[TOP_UNIT], use).not.toBe(a[TOP_UNIT])
    }
  })

  test('eval makes every function escape', () => {
    const a = units('function helper(a) {}\neval("helper.length")')
    const b = units('function helper(a, b) {}\neval("helper.length")')
    expect(b[TOP_UNIT]).not.toBe(a[TOP_UNIT])
  })

  test('a same-named declaration in a nested block stays in the top level', () => {
    const a = units('function helper() {}\nhelper()\n{ const helper = 1; use(helper) }')
    const b = units('function helper() {}\nhelper()\n{ const helper = 2; use(helper) }')
    expect(b[TOP_UNIT]).not.toBe(a[TOP_UNIT])
  })

  test("Vite's imported names are left out for repository modules, kept for dependencies", () => {
    const ssr = (spec: string, names: string) =>
      units(
        `const __vite_ssr_import_0__ = await __vite_ssr_import__(${JSON.stringify(spec)}, {importedNames:[${names}]})`,
      )[TOP_UNIT]
    expect(ssr('/src/general.ts', '"isMap"')).toBe(ssr('/src/general.ts', '"isMap","isSet"'))
    expect(ssr('/node_modules/pkg/index.js', '"a"')).not.toBe(ssr('/node_modules/pkg/index.js', '"a","b"'))
    expect(ssr('/src/general.ts', '"a"')).not.toBe(ssr('/src/other.ts', '"a"'))
  })
})

describe('locating V8 ranges', () => {
  // Offsets as V8 reports them: methods and getters start at their name, arrows at their parameters.
  const code =
    "const s = 'héllo 🎉'; function f(){ return 1 }\nconst o = { m() { return 2 }, get g() { return 3 } }\nclass C { x = 1; meth(a, b = 2) { return a } static s() {} }\nconst a = b => c => b + c"
  const m = fingerprintModule(code)

  test('matches functions by end offset with UTF-16 positions', () => {
    expect(m.locate(22, 46)).toBe('@top/fn:f#0')
    expect(m.locate(59, 75)).toBe('@top/p:m#0')
    expect(m.locate(77, 97)).toBe('@top/p:get g#0')
    expect(m.locate(117, 144)).toBe('@top/m:meth#0')
    expect(m.locate(152, 158)).toBe('@top/m:static s#0')
  })

  test('breaks end-offset ties between nested arrows by nearest start', () => {
    expect(m.locate(171, 186)).toBe('@top/v:a#0')
    expect(m.locate(176, 186)).toBe('@top/v:a#0/anon#0')
  })

  test('attributes synthetic initializers to the enclosing unit', () => {
    expect(m.locate(110, 115)).toBe(TOP_UNIT)
  })
})
