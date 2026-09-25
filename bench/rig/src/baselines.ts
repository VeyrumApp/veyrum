import {
  type CheckRef,
  type EvidenceRecord,
  listRepoFiles,
  plan,
  type RunInfo,
  type Store,
  stem,
} from '@veyrum/core'
import { childEnv, exec } from './exec.ts'

export interface SelectionContext {
  readonly repo: string
  readonly store: Store
  /** Every test file at the commit being planned. */
  readonly checks: readonly CheckRef[]
  /** Paths (relative to the test root) changed since the evidence was recorded. */
  readonly changed: readonly string[]
  /** Whether a lockfile changed. */
  readonly lockfileChanged: boolean
  /** Lockfiles, relative to the test root (Datadog-style tracked files). */
  readonly lockfiles: readonly string[]
}

const DOC_LIKE = /\.(md|mdx|txt|png|jpe?g|gif|svg|ico|webp)$|(^|\/)(LICENSE|CHANGELOG[^/]*|\.github\/.*)$/i
const CODE_LIKE = /\.[cm]?[jt]sx?$|\.vue$|\.svelte$/
const TEST_SUFFIX = /\.(test|spec)$/

/**
 * Naive changed-file selection, as hand-written CI scripts do it: changed test files, test files
 * whose name matches a changed source file, and everything when a non-code file changes.
 */
export function selectNaive(ctx: SelectionContext): Set<string> {
  const tests = ctx.checks.map((c) => c.path)
  const testSet = new Set(tests)
  const selected = new Set<string>()
  const byStem = new Map<string, string[]>()
  for (const t of tests) {
    const base = stem(t.slice(t.lastIndexOf('/') + 1)).replace(TEST_SUFFIX, '')
    const list = byStem.get(base)
    if (list) list.push(t)
    else byStem.set(base, [t])
  }
  for (const f of ctx.changed) {
    if (testSet.has(f)) {
      selected.add(f)
      continue
    }
    if (DOC_LIKE.test(f)) continue
    if (!CODE_LIKE.test(f)) return new Set(tests)
    const base = stem(f.slice(f.lastIndexOf('/') + 1))
    for (const t of byStem.get(base) ?? []) selected.add(t)
  }
  return selected
}

/**
 * Closure identity with whole-file comparison of modules (Veyrum without unit fingerprints).
 * Isolates how much of Veyrum's reduction comes from function-level precision.
 */
export async function selectFileClosure(ctx: SelectionContext, runtimeKey: string): Promise<Set<string>> {
  const decisions = await plan({
    root: ctx.repo,
    store: ctx.store,
    checks: ctx.checks,
    runtimeKey,
    files: listRepoFiles(ctx.repo),
    // The environment the recorded runs had: the rig starts every run with it.
    env: childEnv(),
  })
  return new Set(decisions.filter((d) => d.action === 'run').map((d) => d.check.path))
}

/**
 * Datadog Test Impact Analysis, as documented and as its open-source tracer (dd-trace-js) collects
 * coverage: a test file is skipped when Datadog has a passing run of it at an earlier commit and none
 * of the files it covered were modified between that commit and now. Covered files are repository
 * files the test executed (the tracer excludes node_modules). Tracked files force a full run: the
 * lockfiles, any package.json (Datadog's own example) and the runner's configuration files, as a
 * reasonably configured project would declare them. Fixtures, directory listings and environment
 * variables are not tracked, as Datadog documents.
 *
 * Datadog never skips on the default branch; the replay treats each commit like a pull request
 * against its parent, which is how a selection rule is compared.
 */
export interface CoverageOptions {
  /** Compare against this commit instead of the working tree (rescoring a finished replay). */
  readonly against?: string
  /** Files also counted as modified (a mutant applied on top of `against`). */
  readonly alsoChanged?: readonly string[]
  /** Which recorded runs Datadog would have had (rescoring: only earlier commits). */
  readonly eligible?: (record: EvidenceRecord) => boolean
}

export function selectFileCoverage(ctx: SelectionContext, options: CoverageOptions = {}): Set<string> {
  const diffs = new Map<string, Set<string> | null>()
  /** Files modified between a commit and now (the working tree holds any applied mutant). */
  const changedSince = (revision: string): Set<string> | null => {
    let files = diffs.get(revision)
    if (files === undefined) {
      const range = options.against ? [revision, options.against] : [revision]
      const r = exec('git', ['diff', '--name-only', '--relative', ...range], { cwd: ctx.repo })
      files = r.code === 0 ? new Set(r.stdout.split('\n').filter(Boolean)) : null
      if (files) for (const f of options.alsoChanged ?? []) files.add(f)
      diffs.set(revision, files)
    }
    return files
  }
  const tracked = (changed: ReadonlySet<string>, run: RunInfo): boolean => {
    for (const f of changed) if (ctx.lockfiles.includes(f) || /(^|\/)package\.json$/.test(f)) return true
    return run.shared.some((e) => e.k === 'file' && !e.p.includes('node_modules/') && changed.has(e.p))
  }
  const selected = new Set<string>()
  for (const check of ctx.checks) {
    let skip = false
    for (const record of ctx.store.recordsFor(check, options.eligible ? 200 : 20)) {
      if (options.eligible && !options.eligible(record)) continue
      // A failing run is never a basis, and the latest failure means the file runs.
      if (record.verdict !== 'pass') break
      if (!record.revision) continue
      const changed = changedSince(record.revision)
      const run = ctx.store.getRun(record.runId)
      if (!changed || !run || tracked(changed, run)) continue
      const covered = record.closure.flatMap((e) =>
        e.k === 'mod' && !e.p.includes('node_modules/') ? [e.p] : [],
      )
      if (covered.every((p) => !changed.has(p))) {
        skip = true
        break
      }
    }
    if (!skip) selected.add(check.path)
  }
  return selected
}
