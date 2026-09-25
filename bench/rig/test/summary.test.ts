import { expect, test } from 'vitest'
import type { BaselineScore, CommitResult, MutantResult } from '../src/replay.ts'
import { hermeticShares } from '../src/report.ts'
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
  divergent: string[] = [],
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
  divergent,
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
        commit(1, 50, ['t2.test.ts'], ['t2.test.ts'], ['t3.test.ts']),
        mutant(['t2.test.ts'], ['t2.test.ts']),
        { kind: 'broken', index: 2, sha: 'c2', error: 'install failed' },
      ],
    },
  ])
  // Repository a: time shares 10% and 30%, one killed mutant (the survivor drops out), one flip.
  expect(summary).toContain(
    '| a | vitest | 2 | 20.0% / 20.0% | 100.0% / 100.0% | 20.0% / 100.0% | - / - | 1 + 1 | 0 | 0 | 0 | 20.0% |',
  )
  // Repository b: the mutant escape and the commit escape both count; one commit was unreplayable;
  // capture changed one verdict.
  expect(summary).toContain(
    '| b | jest | 1 (1) | 50.0% / 50.0% | 100.0% / 100.0% | 50.0% / 100.0% | - / - | 1 + 1 | 2 | 0 | 1 | 20.0% |',
  )
  expect(summary).toContain('2 of 4 killed mutants and mainline flips')
})

test('hermetic shares leave out files that used channels Veyrum cannot observe', () => {
  // net.test.ts (60 ms) talks to the internet: Veyrum must run it, file-coverage skipped it.
  const c: CommitResult = {
    ...commit(1, 70, []),
    outcomes: { 'net.test.ts': ['pass', 60], 'a.test.ts': ['pass', 10], 'b.test.ts': ['pass', 30] },
    baselines: {
      veyrum: { ...score(70), selected: ['net.test.ts', 'a.test.ts'] },
      'file-coverage': { ...score(40), selected: ['a.test.ts', 'b.test.ts'] },
    },
    veyrumUnobservable: ['net.test.ts'],
  }
  expect(hermeticShares([c], 'veyrum')).toEqual([0.25])
  expect(hermeticShares([c], 'file-coverage')).toEqual([1])
})
