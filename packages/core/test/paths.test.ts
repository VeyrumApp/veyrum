import path from 'node:path'
import { expect, test } from 'vitest'
import { pathAliases, unalias } from '../src/paths.ts'

const sep = path.sep
const abs = (...parts: string[]): string => path.resolve(sep, ...parts)

test('a directory reached by another spelling is rewritten to its canonical one', () => {
  // A short 8.3 name on Windows, or a symbolic link elsewhere.
  const real: Record<string, string> = { [abs('RUNNER~1', 'Temp')]: abs('runneradmin', 'Temp') }
  const aliases = pathAliases([abs('RUNNER~1', 'Temp'), abs('plain')], (p) => real[p] ?? p)
  expect(aliases).toEqual([[abs('RUNNER~1', 'Temp') + sep, abs('runneradmin', 'Temp') + sep]])
  expect(unalias(abs('RUNNER~1', 'Temp', 'repo', 'a.txt'), aliases)).toBe(
    abs('runneradmin', 'Temp', 'repo', 'a.txt'),
  )
  expect(unalias(abs('RUNNER~1', 'Temp'), aliases)).toBe(abs('runneradmin', 'Temp'))
  // A sibling that only shares a prefix of the name is left alone.
  expect(unalias(abs('RUNNER~1', 'Temporary', 'a.txt'), aliases)).toBe(abs('RUNNER~1', 'Temporary', 'a.txt'))
  expect(unalias(abs('plain', 'a.txt'), aliases)).toBe(abs('plain', 'a.txt'))
})

test('a directory that cannot be resolved has no alias', () => {
  expect(
    pathAliases([abs('gone')], () => {
      throw new Error('ENOENT')
    }),
  ).toEqual([])
})
