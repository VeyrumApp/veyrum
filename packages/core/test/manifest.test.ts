import { describe, expect, test } from 'vitest'
import { hashManifest } from '../src/state.ts'

const hash = (value: unknown) => hashManifest(Buffer.from(JSON.stringify(value, null, 2)))

describe('manifest digests', () => {
  const base = {
    name: 'app',
    type: 'module',
    scripts: { test: 'vitest' },
    dependencies: { vue: '^3.5.0' },
    devDependencies: { eslint: '^10.8.0' },
  }

  test('version ranges and scripts are left out', () => {
    expect(hash({ ...base, scripts: { test: 'vitest run' }, devDependencies: { eslint: '^10.10.0' } })).toBe(
      hash(base),
    )
    expect(hash({ ...base, dependencies: { vue: '3.6.0' } })).toBe(hash(base))
  })

  test('install, publish and descriptive fields are left out', () => {
    expect(
      hash({
        ...base,
        engines: { node: '>=26' },
        packageManager: 'pnpm@12.0.0',
        private: true,
        description: 'changed',
        license: 'MIT',
        version: '9.9.9',
      }),
    ).toBe(hash(base))
  })

  test('the name is kept only when exports allow importing the package by it from inside', () => {
    expect(hash({ ...base, name: 'renamed' })).toBe(hash(base))
    const exported = { ...base, exports: './index.js' }
    expect(hash({ ...exported, name: 'renamed' })).not.toBe(hash(exported))
  })

  test('dependency names are kept', () => {
    expect(hash({ ...base, devDependencies: { eslint: '^10.8.0', prettier: '^3.0.0' } })).not.toBe(hash(base))
    expect(
      hash({ ...base, dependencies: {}, devDependencies: { eslint: '^10.8.0', vue: '^3.5.0' } }),
    ).not.toBe(hash(base))
  })

  test('every other field is kept', () => {
    expect(hash({ ...base, type: 'commonjs' })).not.toBe(hash(base))
    expect(hash({ ...base, imports: { '#x': './x.js' } })).not.toBe(hash(base))
    expect(hash({ ...base, version: '1.0.1' })).not.toBe(hash(base))
    expect(hash({ ...base, babel: { presets: ['env'] } })).not.toBe(hash(base))
  })

  test('formatting is ignored, but content that is not a JSON object is compared byte for byte', () => {
    expect(hashManifest(Buffer.from(JSON.stringify(base)))).toBe(hash(base))
    expect(hashManifest(Buffer.from('{ not json'))).not.toBe(hashManifest(Buffer.from('{ not json ')))
    expect(hashManifest(Buffer.from('[1]'))).not.toBe(hashManifest(Buffer.from('[1] ')))
  })
})
