import {
  type CheckRef,
  type ClosureEntry,
  CurrentState,
  listRepoFiles,
  plan,
  type RunInfo,
  type Store,
  stem,
} from '@veyrum/core'

export interface SelectionContext {
  readonly repo: string
  readonly store: Store
  /** Every test file at the commit being planned. */
  readonly checks: readonly CheckRef[]
  /** Repository paths changed since the evidence was recorded. */
  readonly changed: readonly string[]
  /** Lockfiles, tracked by the coverage baseline like Datadog's "tracked files". */
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
  })
  return new Set(decisions.filter((d) => d.action === 'run').map((d) => d.check.path))
}

/**
 * Datadog Test Impact Analysis, emulated at its strongest: skip a test file when a prior passing
 * run covered exactly the same source and dependency file contents, unless a tracked file
 * (configuration or lockfile) changed. Like Datadog, it does not track fixtures, directory
 * listings or environment variables.
 */
export function selectFileCoverage(ctx: SelectionContext): Set<string> {
  const state = new CurrentState(ctx.repo, ctx.store)
  const trackedChanged = new Map<string, boolean>()
  const lockfileChanged = ctx.changed.some((f) => ctx.lockfiles.includes(f))
  const tracked = (run: RunInfo): boolean => {
    let changed = trackedChanged.get(run.id)
    if (changed === undefined) {
      changed = lockfileChanged || run.shared.some((e) => e.k === 'file' && state.fileDigest(e.p) !== e.h)
      trackedChanged.set(run.id, changed)
    }
    return changed
  }
  const covered = (entry: ClosureEntry): boolean => {
    if (entry.k === 'mod') return state.fileDigest(entry.p) === entry.src
    if (entry.k === 'dep') return state.fileDigest(entry.p) === entry.h
    return true
  }
  const selected = new Set<string>()
  for (const check of ctx.checks) {
    let skip = false
    for (const record of ctx.store.recordsFor(check, 20)) {
      if (record.verdict !== 'pass') break
      const run = ctx.store.getRun(record.runId)
      if (!run || tracked(run)) continue
      if (record.closure.every(covered)) {
        skip = true
        break
      }
    }
    if (!skip) selected.add(check.path)
  }
  return selected
}
