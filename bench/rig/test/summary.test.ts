import { expect, test } from 'vitest'
import type { BaselineScore, CommitResult, MutantResult } from '../src/replay.ts'
import { renderSummary } from '../src/summary.ts'

const score = (selectedMs: number, escapes: string[] = []): BaselineScore => ({
  selected: [],
  selectedMs,
  escapes,
  missedFailing: [],
})

const commit = (
  index: number,
  veyrumMs: number,
  flips: string[],
  veyrumEscapes: string[] = [],
): CommitResult => ({
  kind: 'commit',
  index,
  sha: `c${index}`,
  parent: null,
  changed: [],
  testFiles: 4,
  totalMs: 100,
  outcomes: {},
  flips,
  flaky: [],
  baselines: { veyrum: score(veyrumMs, veyrumEscapes), 'file-coverage': score(100) },
  veyrumPlanMs: 1,
  capture: { runMs: 0, recordMs: 0, wallMs: 120 },
  plainWallMs: index === 1 ? 100 : null,
})

const mutant = (killed: string[], veyrumEscapes: string[]): MutantResult => ({
  kind: 'mutant',
  sha: 'c1',
  mutant: { file: 'src/a.ts', line: 1, kind: 'negate' },
  pool: 'changed',
  killed,
  timedOut: false,
  baselines: { veyrum: { selected: 1, selectedMs: 10, escapes: veyrumEscapes } },
})

test('pools killed mutants and mainline flips into one escape bound', () => {
  const summary = renderSummary([
    {
      name: 'a',
      runner: 'vitest',
      lines: [commit(1, 10, ['t1.test.ts']), commit(2, 30, []), mutant(['t1.test.ts'], []), mutant([], [])],
    },
    {
      name: 'b',
      runner: 'jest',
      lines: [
        commit(1, 50, ['t2.test.ts'], ['t2.test.ts']),
        mutant(['t2.test.ts'], ['t2.test.ts']),
        { kind: 'broken', index: 2, sha: 'c2', error: 'install failed' },
      ],
    },
  ])
  // Repository a: time shares 10% and 30%, one killed mutant (the survivor drops out), one flip.
  expect(summary).toContain(
    '| a | vitest | 2 | 20.0% / 20.0% | 100.0% / 100.0% | - / - | 1 + 1 | 0 | 0 | 20.0% |',
  )
  // Repository b: the mutant escape and the commit escape both count; one commit was unreplayable.
  expect(summary).toContain(
    '| b | jest | 1 (1) | 50.0% / 50.0% | 100.0% / 100.0% | - / - | 1 + 1 | 2 | 0 | 20.0% |',
  )
  expect(summary).toContain('2 of 4 killed mutants and mainline flips')
})
