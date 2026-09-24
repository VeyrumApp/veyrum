import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ProjectConfigs, parseJsonc } from '../src/index.ts'

let root: string
let outside: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-tsconfig-')))
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-tsconfig-outside-')))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

function write(rel: string, content: string, base = root): void {
  const file = path.join(base, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function link(rel: string, target: string): void {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.symlinkSync(target, file, 'junction')
}

const repoFiles = (): string[] =>
  fs
    .readdirSync(root, { recursive: true })
    .map((f) => String(f).split(path.sep).join('/'))
    .filter((f) => !f.includes('node_modules'))
    .sort()

const configs = (): ProjectConfigs => new ProjectConfigs(root, fs, repoFiles())

describe('parseJsonc', () => {
  test('accepts comments and trailing commas outside strings', () => {
    expect(
      parseJsonc(
        '﻿// head\n{\n  /* a */ "a": "x,}//y", // tail\n  "b": [1, 2,],\n  "c": { "d": 1, /* c */ },\n}\n',
      ),
    ).toEqual({ a: 'x,}//y', b: [1, 2], c: { d: 1 } })
    expect(parseJsonc('{ "a": "quote \\" // not a comment" }')).toEqual({ a: 'quote " // not a comment' })
  })

  test('rejects what JSON with comments does not allow', () => {
    expect(() => parseJsonc('{ "a": ')).toThrow()
    expect(() => parseJsonc('{ a: 1 }')).toThrow()
    expect(() => parseJsonc('{ "a": 1 /* open')).toThrow()
  })
})

describe('ProjectConfigs', () => {
  test('a discovered configuration governs its directory, and a base the configurations extending it', () => {
    write('packages/a/tsconfig.json', '{ "extends": "../../configs/base" }')
    write('packages/b/tsconfig.json', '{ "extends": ["../../configs/base.json", "./tsconfig.paths.json"] }')
    write('packages/b/tsconfig.paths.json', '{}')
    write('configs/base.json', '{ "extends": "./strict.json" }')
    write('configs/strict.json', '{}')
    write('configs/unused.json', '{}')
    const graph = configs()
    expect(graph.scope('packages/a/tsconfig.json')).toEqual(['packages/a'])
    expect(graph.scope('configs/strict.json')).toEqual(['packages/a', 'packages/b'])
    expect(graph.scope('packages/b/tsconfig.paths.json')).toEqual(['packages/b'])
    expect(graph.scope('configs/unused.json')).toEqual([])
    // A removed configuration keeps the edges that name it.
    expect(graph.scope('configs/removed.json')).toEqual([])
    // `configs/base` would take precedence over `configs/base.json` if it appeared.
    expect(graph.related(['packages/a/tsconfig.json'])).toEqual([
      'configs/base',
      'configs/base.json',
      'configs/strict.json',
      'packages/a/tsconfig.json',
    ])
  })

  test('only tsconfig.json and jsconfig.json are discovered, and one at the root governs everything', () => {
    write('a/tsconfig.app.json', '{}')
    write('b/jsconfig.json', '{}')
    write('tsconfig.json', '{}')
    const graph = configs()
    expect(graph.scope('a/tsconfig.app.json')).toEqual([])
    expect(graph.scope('b/jsconfig.json')).toEqual(['b'])
    expect(graph.scope('tsconfig.json')).toBeNull()
  })

  test('a referenced project governs the directory of the configuration referencing it', () => {
    write(
      'app/tsconfig.json',
      '{ "files": [], "references": [{ "path": "./tsconfig.lib.json" }, { "path": "../shared" }] }',
    )
    write('app/tsconfig.lib.json', '{ "include": ["lib"] }')
    write('shared/tsconfig.json', '{ "include": ["../app/lib"] }')
    const graph = configs()
    expect(graph.scope('app/tsconfig.lib.json')).toEqual(['app'])
    expect(graph.scope('shared/tsconfig.json')).toEqual(['app', 'shared'])
  })

  test('a configuration whose edges are unknown may extend any other', () => {
    write('a/tsconfig.json', '{}')
    write('broken/tsconfig.json', '{ "extends": ')
    write('odd/tsconfig.json', '{ "extends": 42 }')
    const graph = configs()
    expect(graph.parses('broken/tsconfig.json')).toBe(false)
    expect(graph.scope('a/tsconfig.json')).toEqual(['a', 'broken', 'odd'])
  })

  test('a package base is every path it could be found at, as its manifest maps the specifier', () => {
    write('node/package.json', '{ "name": "@tsconfig/node" }', outside)
    write('node/tsconfig.json', '{}', outside)
    link('node_modules/@tsconfig/node', path.join(outside, 'node'))
    write('tsconfig/package.json', '{ "name": "@acme/tsconfig", "exports": { "./base": "./base.json" } }')
    write('tsconfig/base.json', '{}')
    link('node_modules/@acme/tsconfig', path.join(root, 'tsconfig'))
    write('installed/tsconfig.json', '{ "extends": "@tsconfig/node" }')
    write('linked/tsconfig.json', '{ "extends": "@acme/tsconfig/base" }')
    const graph = configs()
    // Found through the link: a change to the workspace file is a change to this path.
    expect(graph.scope('node_modules/@acme/tsconfig/base.json')).toEqual(['linked'])
    expect(graph.scope('node_modules/@acme/tsconfig/package.json')).toEqual(['linked'])
    expect(graph.scope('node_modules/@tsconfig/node/tsconfig.json')).toEqual([
      'installed',
      'node_modules/@tsconfig/node',
    ])
    // A nearer install would take precedence: those paths are inputs too, while absent.
    expect(graph.related(['installed/tsconfig.json'])).toEqual([
      'installed/node_modules/@tsconfig/node/package.json',
      'installed/node_modules/@tsconfig/node/tsconfig.json',
      'installed/tsconfig.json',
      'node_modules/@tsconfig/node/package.json',
      'node_modules/@tsconfig/node/tsconfig.json',
    ])
  })

  test('a package that is not found, or maps the specifier in a way not modeled, may reach any', () => {
    write('a/tsconfig.json', '{}')
    write('missing/tsconfig.json', '{ "extends": "not-installed/base.json" }')
    write('node_modules/odd/package.json', '{ "exports": { "./base": { "node": 5 } } }')
    write('odd/tsconfig.json', '{ "extends": "odd/base" }')
    write('node_modules/star/package.json', '{ "exports": { "./configs/*": "./dist/*.json" } }')
    write('star/tsconfig.json', '{ "extends": "star/configs/strict" }')
    const graph = configs()
    expect(graph.scope('a/tsconfig.json')).toEqual(['a', 'missing', 'odd'])
    expect(graph.scope('node_modules/star/dist/strict.json')).toEqual(['missing', 'odd', 'star'])
  })
})
