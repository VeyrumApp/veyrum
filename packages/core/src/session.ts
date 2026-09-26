import { createHash } from 'node:crypto'
import { digest } from './hash.ts'
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

/** One of `count` parallel jobs splitting a run's test files; `index` counts from 1. */
export interface Shard {
  readonly index: number
  readonly count: number
}

/** Parses `<index>/<count>`, as Jest and Vitest take it. */
export function parseShard(text: string): Shard {
  const match = /^(\d+)\/(\d+)$/.exec(text.trim())
  const index = Number(match?.[1])
  const count = Number(match?.[2])
  if (!match || count < 1 || index < 1 || index > count)
    throw new Error(`Invalid shard "${text}" (expected <index>/<count>, for example 2/4)`)
  return { index, count }
}

/**
 * Whether a test file belongs to a shard. The split depends on the file's path alone, never on the
 * evidence store, so shards that restored different stores still cover every file exactly once, and
 * a file that several projects run lands in one shard with all of them.
 */
export function inShard(repoPath: string, shard: Shard | undefined): boolean {
  if (!shard || shard.count === 1) return true
  const bucket = createHash('sha256').update(repoPath).digest().readUInt32BE(0) % shard.count
  return bucket === shard.index - 1
}

/**
 * The project's configuration cannot run under Veyrum as asked. Unlike Veyrum's own failures, which
 * fall back to running the tests with the project's runner, this is reported to the user.
 */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError'
}

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
  /** Plan and run only this shard's test files (see inShard). */
  readonly shard?: Shard
  /**
   * Collect the project's coverage (true) or not (false); by default as its configuration says.
   * Only V8 coverage can run alongside capture (see ConfigurationError).
   */
  readonly coverage?: boolean
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
   * Record evidence for every file that runs. By default a file whose evidence is still valid
   * runs without capture: its existing record already describes this execution.
   */
  readonly recordAll?: boolean
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

/** How a file that ran ended, whether or not its evidence was recorded. */
export interface CheckOutcomeSummary {
  readonly check: CheckRef
  readonly verdict: 'pass' | 'fail'
  readonly durationMs: number
  /** Whether evidence was captured for this execution. */
  readonly captured: boolean
  /** On failure, the first failing test and its first error message. */
  readonly failure?: string
}

export interface RunResult {
  readonly runId: string
  /** Key of the runtime this run planned and recorded against (Node, platform, runner versions). */
  readonly runtimeKey: string
  readonly decisions: readonly Decision[]
  readonly records: readonly EvidenceRecord[]
  readonly ran: readonly CheckRef[]
  /** Every file that ran, with its verdict. */
  readonly outcomes: readonly CheckOutcomeSummary[]
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

/**
 * Whether the mode needs a plan. A full run plans to audit, and to find the files whose evidence is
 * still valid, which run without capture; only one that records everything can skip planning.
 */
export function needsPlan(options: Pick<RunOptions, 'mode' | 'audit' | 'recordAll'>): boolean {
  return options.mode !== 'full' || options.audit === true || options.recordAll !== true
}

export interface Execution {
  /** Keys (checkKey) of the checks to execute. */
  readonly toRun: ReadonlySet<string>
  /**
   * Keys of the checks to execute with capture: those without valid evidence. The others run
   * plain, because their existing record already describes the execution.
   */
  readonly capture: ReadonlySet<string>
  /** Reuse decisions that are executed anyway, keyed by checkKey. */
  readonly verified: ReadonlyMap<string, { readonly decision: Decision; readonly kind: Verification['kind'] }>
  /** Keys of checks that run without capture because recording them would not pay off (churn). */
  readonly uncapturedChurn: ReadonlySet<string>
}

/**
 * Chooses what to execute: every check in a full run, the checks that must run otherwise, plus the
 * reuse decisions to verify (all of them in an audit, a sample seeded by `seed` as canaries).
 */
/**
 * Churn: after this many plans in a row found a check's evidence unusable for a reason that recurs
 * on its own, it runs without capture, since recording it again would not make it reusable. It is
 * still captured on every PROBE_EVERY-th such plan, so it recovers once the cause goes away.
 */
export const CHURN_STREAK = 3
export const PROBE_EVERY = 5

export function selectExecution(
  checks: readonly CheckRef[],
  decisions: readonly Decision[],
  options: Pick<RunOptions, 'mode' | 'audit' | 'canary' | 'recordAll'> & { readonly store?: Store },
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
  const capture = new Set(toRun)
  const uncapturedChurn = new Set<string>()
  if (!options.recordAll) for (const d of reusable) capture.delete(checkKey(d.check))
  const store = options.store
  if (store) {
    store.transaction(() => {
      for (const d of decisions) {
        const before = store.churnStreak(d.check)
        // Reused, or run for a change to its code: the check is worth recording again.
        const after = d.action === 'skip' ? 0 : d.churn ? before + 1 : d.reason === 'no-evidence' ? before : 0
        if (after !== before) store.setChurnStreak(d.check, after)
        const key = checkKey(d.check)
        if (
          !options.recordAll &&
          d.churn &&
          before >= CHURN_STREAK &&
          after % PROBE_EVERY !== 0 &&
          !verified.has(key)
        ) {
          capture.delete(key)
          uncapturedChurn.add(key)
        }
      }
    })
  }
  return { toRun, capture, verified, uncapturedChurn }
}

/** Pairs verified decisions with the outcomes of their executions and stores them. */
export function recordVerifications(
  store: Store,
  runId: string,
  execution: Execution,
  outcomes: readonly CheckOutcomeSummary[],
): Verification[] {
  const byCheck = new Map(outcomes.map((o) => [checkKey(o.check), o]))
  const out: Verification[] = []
  for (const [key, { decision, kind }] of execution.verified) {
    const outcome = byCheck.get(key)
    if (!outcome || !decision.recordId) continue
    out.push({ check: decision.check, recordId: decision.recordId, kind, outcome: outcome.verdict })
  }
  if (out.length > 0) {
    store.transaction(() => {
      for (const v of out) store.putVerification(runId, v.check, v.recordId, v.kind, v.outcome)
    })
  }
  return out
}

/**
 * A file that ran without capture because its evidence was valid, and failed, leaves a failing
 * record with that evidence's inputs, so no later plan reuses the passing record behind it.
 */
export function recordUncapturedFailures(
  store: Store,
  runId: string,
  revision: string | null,
  decisions: readonly Decision[],
  outcomes: readonly CheckOutcomeSummary[],
): EvidenceRecord[] {
  const recordIds = new Map(decisions.map((d) => [checkKey(d.check), d.recordId]))
  const out: EvidenceRecord[] = []
  for (const o of outcomes) {
    if (o.captured || o.verdict !== 'fail') continue
    const id = recordIds.get(checkKey(o.check))
    const valid = id ? store.getRecord(id) : undefined
    if (!valid) continue
    out.push({
      ...valid,
      id: digest(`${runId}\u0000${o.check.project}\u0000${o.check.path}`),
      verdict: 'fail',
      reusable: false,
      tests: [],
      durationMs: o.durationMs,
      createdAt: new Date().toISOString(),
      revision,
    })
  }
  if (out.length > 0)
    store.transaction(() => {
      for (const r of out) store.putRecord(r)
    })
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

/** The test files a run covers: those named (if any) that belong to its shard (if any). */
export function selectFiles<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  options: Pick<RunOptions, 'only' | 'shard'>,
): T[] {
  const wanted = options.only ? new Set(options.only) : null
  return items.filter((item) => {
    const p = pathOf(item)
    return (!wanted || wanted.has(p)) && inShard(p, options.shard)
  })
}
