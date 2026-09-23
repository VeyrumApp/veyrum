import type { Decision, EvidenceRecord, RunResult } from '@veyrum/core'
import { describe, expect, test } from 'vitest'
import { markdownSummary } from '../src/summary.ts'

const decision = (
  path: string,
  action: 'run' | 'skip',
  reason: Decision['reason'],
  durationMs: number,
): Decision => ({
  check: { path, project: '' },
  action,
  reason,
  recordId: action === 'skip' ? 'rec' : null,
  details: [],
  closureSize: 0,
  flagsRelied: [],
  durationMs,
})

const result = (decisions: Decision[], extra: Partial<RunResult> = {}): RunResult => ({
  runId: 'run',
  runtimeKey: 'key',
  decisions,
  records: [],
  ran: [],
  verifications: [],
  ok: true,
  timings: { planMs: 1200, runMs: 65_000, recordMs: 300 },
  ...extra,
})

describe('markdown summary', () => {
  const decisions = [
    decision('test/a.test.ts', 'skip', 'reused', 3000),
    decision('test/b.test.ts', 'skip', 'reused', 6000),
    decision('test/c.test.ts', 'run', 'inputs-changed', 1000),
  ]

  test('an affected run states what ran, what was reused and the share of test time', () => {
    const text = markdownSummary(result(decisions), { mode: 'affected', audit: false })
    expect(text).toContain(
      'ran **1**, reused evidence for **2**, covering **90%** of recorded test time (9.0s)',
    )
    expect(text).toContain('| code or inputs it used changed | 1 |')
    expect(text).toContain('Plan 1.2s, run 1m 5s, record 300ms.')
  })

  test('shadow mode reports what would have been reused and names every escape', () => {
    const text = markdownSummary(
      result(decisions, {
        verifications: [
          { check: { path: 'test/a.test.ts', project: '' }, recordId: 'rec', kind: 'audit', outcome: 'pass' },
          {
            check: { path: 'test/b.test.ts', project: 'unit' },
            recordId: 'rec',
            kind: 'audit',
            outcome: 'fail',
          },
        ],
        records: [{ check: 'test/b.test.ts', verdict: 'fail' } as EvidenceRecord],
      }),
      { mode: 'full', audit: true },
    )
    expect(text).toContain(
      'Shadow mode: every test file ran. Veyrum would have reused evidence for **2 of 3**',
    )
    expect(text).toContain(
      '2 reuse decisions were checked by running the files anyway; **1** would have been wrong.',
    )
    expect(text).toContain('- Escape: `test/b.test.ts` (unit) was reusable but fails.')
    expect(text).toContain('Failing test files (1):')
  })
})
