import { type CapturePolicy, type CheckRef, type Decision, Store, selectExecution } from '@veyrum/core'
import type { CommitResult, ResultLine } from './replay.ts'

/**
 * Replays a finished replay's Veyrum decisions through the capture policy (selectExecution) to
 * cost it without running anything: seconds instead of hours. Each file that runs costs its
 * recorded duration, plus the corpus's median capture overhead when it is captured. A file that runs
 * without capture keeps stale evidence, so where the replay reused it, it runs instead until the
 * policy records it again: the reuse the policy gives up is counted.
 */
export interface CaptureCost {
  readonly commits: number
  /** Mean share of test time Veyrum ran, as replayed (every run file captured). */
  readonly runShare: number
  /** Mean cost against running everything, every run file captured (before the policy). */
  readonly netAlways: number
  /** Mean cost against running everything under the policy. */
  readonly netPolicy: number
  /** Share of all test time that ran uncaptured under the policy. */
  readonly uncapturedShare: number
  /** Share of all test time that ran only because the policy had left evidence stale. */
  readonly lostReuseShare: number
  readonly overhead: number
}

export function simulateCapture(lines: readonly ResultLine[], capturePolicy?: CapturePolicy): CaptureCost {
  const commits = lines
    .filter((l): l is CommitResult => l.kind === 'commit')
    .sort((a, b) => a.index - b.index)
  const pairs = commits
    .filter((c) => c.plainWallMs !== null)
    .map((c) => c.capture.wallMs / c.plainWallMs! - 1)
  const overhead = Math.max(0, median(pairs))
  const store = Store.open(':memory:')
  const seen = new Set<string>()
  const stale = new Set<string>()
  const churned = new Set<string>()
  const runShares: number[] = []
  const always: number[] = []
  const policy: number[] = []
  let uncapturedMs = 0
  let lostMs = 0
  let totalMs = 0
  for (const c of commits) {
    // Each shard begins with a warm-up commit and a store of its own. What the policy learned about
    // each file carries over, as in CI, where one store lives across the whole history.
    if (c.baselines === null) {
      for (const f of Object.keys(c.outcomes)) seen.add(f)
      continue
    }
    const ran = new Set(c.baselines.veyrum?.selected ?? [])
    for (const details of [c.veyrumReasons?.['blocked-flag'], c.veyrumReasons?.['not-reusable']])
      for (const d of details?.details ?? []) churned.add(d.slice(0, d.indexOf(': ')))
    const files = Object.keys(c.outcomes)
    const checks: CheckRef[] = files.map((path) => ({ path, project: '' }))
    const decisions: Decision[] = checks.map((check) => {
      const run = ran.has(check.path) || stale.has(check.path)
      return {
        check,
        action: run ? 'run' : 'skip',
        reason: !run ? 'reused' : seen.has(check.path) ? 'inputs-changed' : 'no-evidence',
        recordId: null,
        details: [],
        closureSize: 0,
        flagsRelied: [],
        durationMs: c.outcomes[check.path]?.[1] ?? 0,
        ...(run && churned.has(check.path) ? { churn: true } : {}),
      }
    })
    const execution = selectExecution(
      checks,
      decisions,
      { mode: 'affected', store, ...(capturePolicy ? { capturePolicy } : {}) },
      c.sha,
    )
    const ms = (f: string): number => c.outcomes[f]?.[1] ?? 0
    const total = files.reduce((n, f) => n + ms(f), 0)
    let replayed = 0
    let withPolicy = 0
    for (const d of decisions) {
      if (d.action !== 'run') continue
      const f = d.check.path
      const captured = execution.capture.has(`${d.check.project}\u0000${f}`)
      if (ran.has(f)) replayed += ms(f)
      else lostMs += ms(f)
      withPolicy += ms(f) * (1 + (captured ? overhead : 0))
      if (!captured) uncapturedMs += ms(f)
      if (captured) stale.delete(f)
      else stale.add(f)
    }
    for (const f of files) seen.add(f)
    totalMs += total
    runShares.push(replayed / Math.max(1, total))
    always.push((replayed * (1 + overhead)) / Math.max(1, total))
    policy.push(withPolicy / Math.max(1, total))
  }
  store.close()
  const mean = (v: readonly number[]): number =>
    v.length === 0 ? Number.NaN : v.reduce((a, b) => a + b, 0) / v.length
  return {
    commits: runShares.length,
    runShare: mean(runShares),
    netAlways: mean(always),
    netPolicy: mean(policy),
    uncapturedShare: uncapturedMs / Math.max(1, totalMs),
    lostReuseShare: lostMs / Math.max(1, totalMs),
    overhead,
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
