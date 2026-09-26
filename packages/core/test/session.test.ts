import { describe, expect, test } from 'vitest'
import { checkKey, inShard, parseShard, selectExecution, selectFiles } from '../src/session.ts'
import { Store } from '../src/store.ts'
import type { Decision } from '../src/types.ts'

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

describe('capture skips churn', () => {
  const check = { path: 'test/a.test.ts', project: '' }
  const churn: Decision = {
    check,
    action: 'run',
    reason: 'inputs-changed',
    recordId: 'r',
    details: ['environment variable X changed'],
    closureSize: 1,
    flagsRelied: [],
    durationMs: 1,
    churn: true,
  }
  const captured = (store: Store, decision: Decision): boolean =>
    selectExecution([check], [decision], { mode: 'affected', store }, 'seed').capture.has(checkKey(check))

  test('after three plans of churn a check runs without capture, probed every fifth plan', () => {
    const store = Store.open(':memory:')
    const seen = Array.from({ length: 11 }, () => captured(store, churn))
    // Plans 1-3 capture; from the fourth, only every fifth (streaks 5 and 10) is a probe.
    expect(seen).toEqual([true, true, true, false, true, false, false, false, false, true, false])
  })

  test('reuse or a change to the code makes a check worth recording again', () => {
    const store = Store.open(':memory:')
    for (let i = 0; i < 4; i++) captured(store, churn)
    expect(store.churnStreak(check)).toBe(4)
    expect(captured(store, { ...churn, churn: undefined, details: ['src/a.ts: add changed'] })).toBe(true)
    expect(store.churnStreak(check)).toBe(0)
    for (let i = 0; i < 4; i++) captured(store, churn)
    selectExecution(
      [check],
      [{ ...churn, action: 'skip', reason: 'reused', churn: undefined }],
      { mode: 'affected', store },
      's',
    )
    expect(store.churnStreak(check)).toBe(0)
  })

  test('a check with no evidence yet keeps its streak and is captured', () => {
    const store = Store.open(':memory:')
    for (let i = 0; i < 4; i++) captured(store, churn)
    expect(captured(store, { ...churn, reason: 'no-evidence', churn: undefined })).toBe(true)
    expect(store.churnStreak(check)).toBe(4)
  })
})
