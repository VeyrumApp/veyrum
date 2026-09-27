import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { checkKey, inShard, noteOverhead, parseShard, selectExecution, selectFiles } from '../src/session.ts'
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
  /** The schedules below are for this policy, not the defaults (which simulation tunes). */
  const policy = {
    churnStreak: 3,
    blockedStreak: 3,
    minReuse: 0.05,
    overheadWeight: 1,
    reuseWeight: 0.3,
    probeEvery: 10,
    probeBackoff: 1,
    probeMax: 10,
  }
  const captured = (store: Store, decision: Decision, capturePolicy = policy): boolean =>
    selectExecution([check], [decision], { mode: 'affected', store, capturePolicy }, 'seed').capture.has(
      checkKey(check),
    )

  test('after three plans of churn a check runs without capture, recorded on every tenth such run', () => {
    const store = Store.open(':memory:')
    const seen = Array.from({ length: 13 }, () => captured(store, churn))
    expect(seen).toEqual([true, true, true, ...Array<boolean>(9).fill(false), true])
  })

  test('a check invalidated by code changes on every plan stops being recorded once reuse is rare', () => {
    const store = Store.open(':memory:')
    const code: Decision = { ...churn, churn: undefined, details: ['src/a.ts: add changed'] }
    const seen = Array.from({ length: 18 }, () => captured(store, code))
    // Reuse decays by 0.7 per plan: below 0.05 after nine; the eighteenth is a probe.
    expect(seen).toEqual([...Array<boolean>(8).fill(true), ...Array<boolean>(9).fill(false), true])
    // Reuse makes it worth recording again.
    selectExecution(
      [check],
      [{ ...churn, action: 'skip', reason: 'reused', churn: undefined }],
      { mode: 'affected', store },
      's',
    )
    expect(captured(store, code)).toBe(true)
  })

  test('the higher the measured capture overhead, the more reuse recording must buy', () => {
    const code: Decision = { ...churn, churn: undefined, details: ['src/a.ts: add changed'] }
    // At 33% overhead recording pays only above a reuse rate of 0.33 / 1.33: reuse decays by 0.7 per
    // plan, below that after four.
    const costly = Store.open(':memory:')
    costly.setOverhead(0.33)
    const t = true
    const f = false
    expect(Array.from({ length: 14 }, () => captured(costly, code))).toEqual([
      t,
      t,
      t,
      ...Array<boolean>(9).fill(f),
      t,
      f,
    ])
    // An overhead given to the run takes precedence over the store's.
    const given = Store.open(':memory:')
    given.setOverhead(0.33)
    const seen = Array.from(
      { length: 5 },
      () =>
        selectExecution(
          [check],
          [code],
          { mode: 'affected', store: given, capturePolicy: policy, overhead: 0 },
          's',
        ).capture.size === 1,
    )
    expect(seen).toEqual([t, t, t, t, t])
  })

  test('each run folds its measured overhead into the estimate, which merged stores average', () => {
    const store = Store.open(':memory:')
    expect(store.overhead()).toBeUndefined()
    // Capture work of 10% of test time, and recording of 5% of the run.
    noteOverhead(store, { captureMs: 100, testMs: 1000 }, 50, 1000)
    expect(store.overhead()).toBeCloseTo(0.15)
    noteOverhead(store, { captureMs: 300, testMs: 1000 }, 50, 1000)
    expect(store.overhead()).toBeCloseTo(0.15 * 0.7 + 0.35 * 0.3)
    // A run that measured nothing leaves it.
    noteOverhead(store, { captureMs: 0, testMs: 0 }, 50, 1000)
    expect(store.overhead()).toBeCloseTo(0.21)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-overhead-'))
    try {
      const other = Store.open(path.join(dir, 'other.sqlite'))
      other.setOverhead(0.41)
      other.close()
      store.merge(path.join(dir, 'other.sqlite'))
      expect(store.overhead()).toBeCloseTo(0.31)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a change to the code resets the churn streak; reuse resets it too', () => {
    const store = Store.open(':memory:')
    for (let i = 0; i < 4; i++) captured(store, churn)
    expect(store.captureValue(check).streak).toBe(4)
    expect(captured(store, { ...churn, churn: undefined, details: ['src/a.ts: add changed'] })).toBe(true)
    expect(store.captureValue(check).streak).toBe(0)
    for (let i = 0; i < 2; i++) captured(store, churn)
    selectExecution(
      [check],
      [{ ...churn, action: 'skip', reason: 'reused', churn: undefined }],
      { mode: 'affected', store },
      's',
    )
    expect(store.captureValue(check).streak).toBe(0)
  })

  test('probes back off while they find nothing reusable', () => {
    const store = Store.open(':memory:')
    const backoff = { ...policy, probeEvery: 2, probeBackoff: 2, probeMax: 8 }
    const seen = Array.from({ length: 21 }, () => captured(store, churn, backoff))
    // Three churn plans, then probes after 2, 4 and 8 runs without capture.
    const t = true
    const f = false
    expect(seen).toEqual([t, t, t, f, t, f, f, f, t, f, f, f, f, f, f, f, t, f, f, f, f])
  })

  test('runs without capture say nothing about reuse: only recorded evidence moves the average', () => {
    const store = Store.open(':memory:')
    const code: Decision = { ...churn, churn: undefined, details: ['src/a.ts: add changed'] }
    for (let i = 0; i < 9; i++) captured(store, code)
    const low = store.captureValue(check).reuse
    expect(captured(store, code)).toBe(false)
    expect(store.captureValue(check).reuse).toBe(low)
  })

  test('a check with no evidence yet keeps its history and is captured', () => {
    const store = Store.open(':memory:')
    for (let i = 0; i < 4; i++) captured(store, churn)
    expect(captured(store, { ...churn, reason: 'no-evidence', churn: undefined })).toBe(true)
    expect(store.captureValue(check).streak).toBe(4)
  })
})
