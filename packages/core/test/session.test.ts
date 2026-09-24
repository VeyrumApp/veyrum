import { expect, test } from 'vitest'
import { inShard, parseShard, selectFiles } from '../src/session.ts'

test('shards are parsed as Jest and Vitest take them', () => {
  expect(parseShard('2/4')).toEqual({ index: 2, count: 4 })
  for (const bad of ['0/4', '5/4', '1/0', '1', 'a/b', '-1/2'])
    expect(() => parseShard(bad)).toThrow(/Invalid shard/)
})

test('every file belongs to exactly one shard, by its path alone', () => {
  const paths = Array.from({ length: 400 }, (_, i) => `test/file-${i}.test.ts`)
  const count = 4
  const sizes = Array.from(
    { length: count },
    (_, i) => paths.filter((p) => inShard(p, { index: i + 1, count })).length,
  )
  expect(sizes.reduce((a, b) => a + b, 0)).toBe(paths.length)
  for (const p of paths)
    expect(
      Array.from({ length: count }, (_, i) => inShard(p, { index: i + 1, count })).filter(Boolean),
    ).toHaveLength(1)
  // Roughly balanced.
  for (const size of sizes) expect(size).toBeGreaterThan(60)
})

test('named files and a shard both restrict what a run covers', () => {
  const paths = ['a.test.ts', 'b.test.ts', 'c.test.ts']
  expect(selectFiles(paths, (p) => p, {})).toEqual(paths)
  expect(selectFiles(paths, (p) => p, { only: ['b.test.ts'] })).toEqual(['b.test.ts'])
  const shard = { index: 1, count: 2 }
  expect(selectFiles(paths, (p) => p, { shard })).toEqual(paths.filter((p) => inShard(p, shard)))
})
