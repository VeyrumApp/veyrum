import { describe, expect, test } from 'vitest'
import { shardCommits } from '../src/replay.ts'

const shas = Array.from({ length: 41 }, (_, i) => `c${i}`)

describe('replay shards', () => {
  test('without shards every commit is replayed', () => {
    expect(shardCommits(shas, undefined).map(([i]) => i)).toEqual(shas.map((_, i) => i))
  })

  test('shards cover every scored commit exactly once, each after its own warm-up', () => {
    const scored: number[] = []
    for (let index = 0; index < 4; index++) {
      const window = shardCommits(shas, { index, count: 4 })
      const [warmUp, ...rest] = window.map(([i]) => i)
      // The warm-up is the commit before the window; the first shard's is the range's own.
      expect(warmUp).toBe(rest[0]! - 1)
      scored.push(...rest)
    }
    expect(scored).toEqual(shas.slice(1).map((_, i) => i + 1))
  })

  test('uneven splits still cover the range', () => {
    const scored = [0, 1, 2].flatMap((index) =>
      shardCommits(shas.slice(0, 11), { index, count: 3 })
        .slice(1)
        .map(([i]) => i),
    )
    expect(scored).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})
