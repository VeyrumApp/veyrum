import type { Policy } from './policy.ts'
import type { Store } from './store.ts'
import type { CheckRef, Decision, EvidenceRecord } from './types.ts'

/** Runner-independent pieces of a Veyrum run: what to execute, and how reuse is verified. */

export type RunMode =
  /** Run every test file and record evidence. */
  | 'full'
  /** Skip test files whose evidence is still valid; run and record the rest. */
  | 'affected'
  /** Only compute decisions; run nothing. */
  | 'plan'

/** Options every runner adapter accepts. */
export interface RunOptions {
  readonly root: string
  readonly store: Store
  readonly mode: RunMode
  readonly revision?: string | null
  readonly policy?: Policy
  /** Print the runner's default reporter output. */
  readonly printTests?: boolean
  /** Restrict to these repository-relative test files (others are neither planned nor run). */
  readonly only?: readonly string[]
  /** Keep worker payloads and module code after the run (for debugging). */
  readonly keepScratch?: boolean
  /**
   * With mode 'full': also plan, then report any file the plan would have reused that fails.
   * This is the audit that measures the real escape rate.
   */
  readonly audit?: boolean
  /** With mode 'affected': also run this fraction of reusable files as canaries (0 to 1). */
  readonly canary?: number
  /**
   * Fail on Veyrum's own errors instead of degrading. By default a failure while recording evidence
   * leaves the test results standing and only loses that run's evidence.
   */
  readonly strict?: boolean
}

/** A reused (or would-be reused) file that was executed anyway to check the decision. */
export interface Verification {
  readonly check: CheckRef
  readonly recordId: string
  readonly kind: 'audit' | 'canary'
  readonly outcome: 'pass' | 'fail'
}

export interface RunResult {
  readonly runId: string
  /** Key of the runtime this run planned and recorded against (Node, platform, runner versions). */
  readonly runtimeKey: string
  readonly decisions: readonly Decision[]
  readonly records: readonly EvidenceRecord[]
  readonly ran: readonly CheckRef[]
  /** Reuse decisions that were checked by running the file anyway (audit or canary). */
  readonly verifications: readonly Verification[]
  readonly ok: boolean
  readonly timings: {
    readonly planMs: number
    readonly runMs: number
    readonly recordMs: number
    readonly totalMs: number
  }
}

export function checkKey(check: CheckRef): string {
  return `${check.project}\u0000${check.path}`
}

/** Decisions for a full run without an audit: everything runs, nothing is planned. */
export function forcedDecisions(checks: readonly CheckRef[]): Decision[] {
  return checks.map((check) => ({
    check,
    action: 'run',
    reason: 'forced',
    recordId: null,
    details: ['full run requested'],
    closureSize: 0,
    flagsRelied: [],
    durationMs: 0,
  }))
}

/** Whether the mode needs a plan (a full run needs one only to audit it). */
export function needsPlan(options: Pick<RunOptions, 'mode' | 'audit'>): boolean {
  return options.mode !== 'full' || options.audit === true
}

export interface Execution {
  /** Keys (checkKey) of the checks to execute. */
  readonly toRun: ReadonlySet<string>
  /** Reuse decisions that are executed anyway, keyed by checkKey. */
  readonly verified: ReadonlyMap<string, { readonly decision: Decision; readonly kind: Verification['kind'] }>
}

/**
 * Chooses what to execute: every check in a full run, the checks that must run otherwise, plus the
 * reuse decisions to verify (all of them in an audit, a sample seeded by `seed` as canaries).
 */
export function selectExecution(
  checks: readonly CheckRef[],
  decisions: readonly Decision[],
  options: Pick<RunOptions, 'mode' | 'audit' | 'canary'>,
  seed: string,
): Execution {
  const toRun = new Set(decisions.filter((d) => d.action === 'run').map((d) => checkKey(d.check)))
  const verified = new Map<string, { decision: Decision; kind: Verification['kind'] }>()
  const reusable = decisions.filter((d) => d.action === 'skip')
  if (options.mode === 'full' && options.audit) {
    for (const d of reusable) verified.set(checkKey(d.check), { decision: d, kind: 'audit' })
  } else if (options.mode === 'affected' && options.canary && options.canary > 0) {
    const count = Math.min(reusable.length, Math.ceil(reusable.length * Math.min(1, options.canary)))
    const random = seededRandom(seed)
    const pool = [...reusable]
    for (let i = 0; i < count; i++) {
      const [d] = pool.splice(Math.floor(random() * pool.length), 1)
      if (d) verified.set(checkKey(d.check), { decision: d, kind: 'canary' })
    }
  }
  for (const key of verified.keys()) toRun.add(key)
  if (options.mode === 'full') for (const c of checks) toRun.add(checkKey(c))
  return { toRun, verified }
}

/** Pairs verified decisions with the records of their executions and stores them. */
export function recordVerifications(
  store: Store,
  runId: string,
  execution: Execution,
  records: readonly EvidenceRecord[],
): Verification[] {
  const byCheck = new Map(records.map((r) => [checkKey({ path: r.check, project: r.project }), r]))
  const out: Verification[] = []
  for (const [key, { decision, kind }] of execution.verified) {
    const rec = byCheck.get(key)
    if (!rec || !decision.recordId) continue
    out.push({ check: decision.check, recordId: decision.recordId, kind, outcome: rec.verdict })
  }
  if (out.length > 0) {
    store.transaction(() => {
      for (const v of out) store.putVerification(runId, v.check, v.recordId, v.kind, v.outcome)
    })
  }
  return out
}

/**
 * Records a run's evidence. Recording happens after the tests ran, so its failure must not change
 * their verdict: unless strict, the error is reported and the run simply leaves no evidence.
 */
export function recordEvidence(
  strict: boolean | undefined,
  record: () => { readonly records: readonly EvidenceRecord[]; readonly verifications: Verification[] },
): {
  readonly records: readonly EvidenceRecord[]
  readonly verifications: Verification[]
  readonly recorded: boolean
} {
  try {
    // Fault injection for the fail-open tests.
    if (process.env.VEYRUM_FAULT === 'record') throw new Error('injected fault while recording')
    return { ...record(), recorded: true }
  } catch (error) {
    if (strict) throw error
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `veyrum: recording evidence failed, so nothing from this run will be reused (the test results stand): ${message}\n`,
    )
    return { records: [], verifications: [], recorded: false }
  }
}

/** Small deterministic PRNG (mulberry32), seeded from a string. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
