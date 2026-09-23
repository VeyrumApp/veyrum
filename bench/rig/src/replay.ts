import fs from 'node:fs'
import path from 'node:path'
import { type CheckRef, digest, Store } from '@veyrum/core'
import { type SelectionContext, selectFileClosure, selectFileCoverage, selectNaive } from './baselines.ts'
import type { Corpus } from './corpus.ts'
import { exec, git } from './exec.ts'
import { applyMutant, type Mutant, mutationSites, rng } from './mutate.ts'
import { captureRun, type Outcomes, plainRun, veyrumPlan, vitestChanged } from './runners.ts'

export const BASELINES = [
  'all',
  'naive',
  'vitest-changed',
  'file-coverage',
  'file-closure',
  'veyrum',
] as const
export type BaselineName = (typeof BASELINES)[number]

export interface BaselineScore {
  /** Selected test files (null when the baseline could not produce a selection). */
  readonly selected: readonly string[] | null
  /** Recorded duration of the selected files at this commit. */
  readonly selectedMs: number
  /** Non-flaky outcome flips the baseline did not select. */
  readonly escapes: readonly string[]
  /** Files failing at this commit that the baseline did not select. */
  readonly missedFailing: readonly string[]
}

export interface CommitResult {
  readonly kind: 'commit'
  readonly index: number
  readonly sha: string
  readonly parent: string | null
  readonly changed: readonly string[]
  readonly testFiles: number
  readonly totalMs: number
  readonly outcomes: Readonly<Record<string, readonly [verdict: 'pass' | 'fail', ms: number]>>
  readonly flips: readonly string[]
  readonly flaky: readonly string[]
  readonly baselines: Partial<Record<BaselineName, BaselineScore>> | null
  readonly veyrumPlanMs: number | null
  readonly capture: { readonly runMs: number; readonly recordMs: number; readonly wallMs: number }
  /** Wall time of an uninstrumented full run, measured on sampled commits for overhead. */
  readonly plainWallMs: number | null
}

export interface MutantResult {
  readonly kind: 'mutant'
  readonly sha: string
  readonly mutant: Pick<Mutant, 'file' | 'line' | 'kind'>
  readonly pool: 'changed' | 'random'
  /** Test files that passed at the commit and fail with the mutant. */
  readonly killed: readonly string[]
  readonly timedOut: boolean
  readonly baselines: Partial<
    Record<
      BaselineName,
      { readonly selected: number; readonly selectedMs: number; readonly escapes: readonly string[] }
    >
  >
}

export type ResultLine = CommitResult | MutantResult

interface ReplayPaths {
  readonly work: string
  readonly repo: string
  readonly store: string
  readonly results: string
  readonly scratch: string
}

export function pathsFor(corpus: Corpus, benchRoot: string): ReplayPaths {
  const work = path.join(benchRoot, corpus.name)
  return {
    work,
    repo: path.join(work, 'repo'),
    store: path.join(work, 'store.sqlite'),
    results: path.join(work, 'results.jsonl'),
    scratch: path.join(work, 'scratch'),
  }
}

function log(message: string): void {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`)
}

function readResults(file: string): ResultLine[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ResultLine)
}

function lockDigest(repo: string, lockfiles: readonly string[]): string {
  return digest(
    lockfiles
      .map((f) => {
        try {
          return fs.readFileSync(path.join(repo, f), 'utf8')
        } catch {
          return ''
        }
      })
      .join('\u0000'),
  )
}

function checkout(repo: string, sha: string): void {
  git(repo, '-c', 'advice.detachedHead=false', 'checkout', '-q', '-f', sha)
  git(repo, 'clean', '-ffdxq', '-e', 'node_modules', '-e', '.veyrum')
}

function install(corpus: Corpus, repo: string): void {
  const [cmd, ...args] = corpus.install
  if (!cmd) return
  log(`install: ${corpus.install.join(' ')}`)
  const r = exec(cmd, args, { cwd: repo })
  if (r.code !== 0) throw new Error(`install failed:\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`)
}

/** Reruns failing files twice; any that pass are flaky and excluded from safety scoring. */
function detectFlaky(corpus: Corpus, repo: string, scratch: string, outcomes: Outcomes): Set<string> {
  const failing = [...outcomes].filter(([, o]) => o.verdict === 'fail').map(([f]) => f)
  const flaky = new Set<string>()
  if (failing.length === 0) return flaky
  for (let attempt = 0; attempt < 2; attempt++) {
    const rerun = plainRun(corpus, repo, scratch, failing)
    for (const f of failing) if (rerun.outcomes.get(f)?.verdict === 'pass') flaky.add(f)
  }
  return flaky
}

function durationOf(outcomes: Outcomes, files: Iterable<string>): number {
  let total = 0
  for (const f of files) total += outcomes.get(f)?.durationMs ?? 0
  return total
}

async function selectAll(
  corpus: Corpus,
  paths: ReplayPaths,
  store: Store,
  checks: readonly CheckRef[],
  changed: readonly string[],
  since: string | null,
  veyrumSelection: Set<string>,
): Promise<Record<BaselineName, Set<string> | null>> {
  const ctx: SelectionContext = { repo: paths.repo, store, checks, changed, lockfiles: corpus.lockfiles }
  const runtimeKey = latestRuntimeKey(store, checks)
  return {
    all: new Set(checks.map((c) => c.path)),
    naive: selectNaive(ctx),
    'vitest-changed': vitestChanged(corpus, paths.repo, paths.scratch, since),
    'file-coverage': selectFileCoverage(ctx),
    'file-closure': runtimeKey ? await selectFileClosure(ctx, runtimeKey) : null,
    veyrum: veyrumSelection,
  }
}

function latestRuntimeKey(store: Store, checks: readonly CheckRef[]): string | null {
  for (const c of checks) {
    const r = store.recordsFor(c, 1)[0]
    if (r) return r.runtimeKey
  }
  return null
}

export interface ReplayOptions {
  /** Measure an uninstrumented run every N commits (0 disables). */
  readonly overheadEvery: number
}

export async function replay(corpus: Corpus, benchRoot: string, options: ReplayOptions): Promise<void> {
  const paths = pathsFor(corpus, benchRoot)
  fs.mkdirSync(paths.scratch, { recursive: true })
  if (!fs.existsSync(path.join(paths.repo, '.git'))) {
    log(`clone ${corpus.repo}`)
    const r = exec('git', ['clone', '-q', '--filter=blob:none', corpus.repo, paths.repo], { cwd: paths.work })
    if (r.code !== 0) throw new Error(`clone failed: ${r.stderr}`)
  }
  git(paths.repo, 'fetch', '-q', 'origin', corpus.branch)
  const tip = corpus.until ?? `origin/${corpus.branch}`
  const shas = git(paths.repo, 'rev-list', '--first-parent', `--max-count=${corpus.commits + 1}`, tip)
    .split('\n')
    .filter(Boolean)
    .reverse()

  const done = readResults(paths.results).filter((r): r is CommitResult => r.kind === 'commit')
  const doneShas = new Set(done.map((r) => r.sha))
  let prev: CommitResult | undefined = done[done.length - 1]
  let installedLock = ''
  const store = Store.open(paths.store)
  // Synchronous appends: everything else in the loop is synchronous, so a buffered stream would
  // never flush, and results must survive an interrupted replay.
  const write = (line: ResultLine): void => {
    fs.appendFileSync(paths.results, `${JSON.stringify(line)}\n`)
  }

  try {
    for (const [index, sha] of shas.entries()) {
      if (doneShas.has(sha)) continue
      log(`commit ${index}/${shas.length - 1} ${sha.slice(0, 10)}`)
      checkout(paths.repo, sha)
      const lock = lockDigest(paths.repo, corpus.lockfiles)
      if (lock !== installedLock || !fs.existsSync(path.join(paths.repo, 'node_modules'))) {
        install(corpus, paths.repo)
        installedLock = lock
      }

      const parent = prev?.sha ?? null
      const changed = parent
        ? git(paths.repo, 'diff', '--name-only', parent, sha).split('\n').filter(Boolean)
        : []

      // 1. Plans, made before anything runs at this commit, from evidence of earlier commits only.
      let selections: Record<BaselineName, Set<string> | null> | null = null
      let veyrumPlanMs: number | null = null
      let checks: CheckRef[] = []
      if (parent) {
        const p = veyrumPlan(corpus, paths.repo, paths.store, paths.scratch)
        veyrumPlanMs = p.planMs
        checks = p.decisions.map((d) => d.check)
        const veyrumSelection = new Set(
          p.decisions.filter((d) => d.action === 'run').map((d) => d.check.path),
        )
        selections = await selectAll(corpus, paths, store, checks, changed, parent, veyrumSelection)
      }

      // 2. Optional uninstrumented run for overhead (before capture, alternating order is not needed
      //    since both runs are sequential on the same tree).
      let plainWallMs: number | null = null
      if (options.overheadEvery > 0 && index % options.overheadEvery === 0) {
        plainWallMs = plainRun(corpus, paths.repo, paths.scratch).wallMs
      }

      // 3. Ground truth and evidence for the next commit.
      const capture = captureRun(corpus, paths.repo, paths.store, paths.scratch)
      const outcomes = capture.outcomes
      const flaky = detectFlaky(corpus, paths.repo, paths.scratch, outcomes)
      const prevOutcomes = new Map(Object.entries(prev?.outcomes ?? {}))
      const flips: string[] = []
      for (const [file, o] of outcomes) {
        if (flaky.has(file)) continue
        const before = prevOutcomes.get(file)
        if (before ? before[0] !== o.verdict : o.verdict === 'fail') flips.push(file)
      }
      const failing = [...outcomes].filter(([f, o]) => o.verdict === 'fail' && !flaky.has(f)).map(([f]) => f)

      let baselines: CommitResult['baselines'] = null
      if (selections) {
        baselines = {}
        for (const name of BASELINES) {
          const sel = selections[name]
          baselines[name] = sel
            ? {
                selected: [...sel].sort(),
                selectedMs: durationOf(outcomes, sel),
                escapes: flips.filter((f) => !sel.has(f)),
                missedFailing: failing.filter((f) => !sel.has(f)),
              }
            : { selected: null, selectedMs: 0, escapes: [], missedFailing: [] }
        }
      }
      const result: CommitResult = {
        kind: 'commit',
        index,
        sha,
        parent,
        changed,
        testFiles: outcomes.size,
        totalMs: durationOf(outcomes, outcomes.keys()),
        outcomes: Object.fromEntries(
          [...outcomes].map(([f, o]) => [f, [o.verdict, Math.round(o.durationMs)] as const]),
        ),
        flips,
        flaky: [...flaky],
        baselines,
        veyrumPlanMs,
        capture: { runMs: capture.runMs, recordMs: capture.recordMs, wallMs: capture.wallMs },
        plainWallMs,
      }
      write(result)
      const summary = baselines
        ? BASELINES.map((b) => `${b}=${baselines?.[b]?.selected?.length ?? '-'}`).join(' ')
        : 'warm-up'
      log(`  ${outcomes.size} files, ${flips.length} flips, ${flaky.size} flaky; ${summary}`)

      // 4. Mutants on sampled commits, using evidence recorded at this commit.
      if (corpus.mutantsPerCommit > 0 && index % corpus.mutationEvery === 0) {
        for (const m of runMutants(corpus, paths, store, sha, changed, outcomes, capture.wallMs)) {
          write(await m)
        }
      }
      prev = result
    }
  } finally {
    store.close()
  }
}

function* runMutants(
  corpus: Corpus,
  paths: ReplayPaths,
  store: Store,
  sha: string,
  changed: readonly string[],
  outcomes: Outcomes,
  captureWallMs: number,
): Generator<Promise<MutantResult>> {
  const patterns = corpus.mutationSources.map((p) => new RegExp(p))
  const sources = git(paths.repo, 'ls-files')
    .split('\n')
    .filter((f) => patterns.some((re) => re.test(f)))
  if (sources.length === 0) return
  const changedSources = sources.filter((f) => changed.includes(f))
  const random = rng(sha)
  const pickFrom = (list: readonly string[]): string => list[Math.floor(random() * list.length)]!
  const checks: CheckRef[] = [...outcomes.keys()].map((p) => ({ path: p, project: '' }))

  for (let i = 0; i < corpus.mutantsPerCommit; i++) {
    const pool: 'changed' | 'random' = i % 2 === 0 && changedSources.length > 0 ? 'changed' : 'random'
    let mutant: Mutant | undefined
    for (let attempt = 0; attempt < 20 && !mutant; attempt++) {
      const file = pickFrom(pool === 'changed' ? changedSources : sources)
      const code = fs.readFileSync(path.join(paths.repo, file), 'utf8')
      const sites = mutationSites(file, code)
      if (sites.length > 0) mutant = sites[Math.floor(random() * sites.length)]
    }
    if (!mutant) continue
    const m = mutant
    yield (async (): Promise<MutantResult> => {
      const absolute = path.join(paths.repo, m.file)
      const original = fs.readFileSync(absolute, 'utf8')
      fs.writeFileSync(absolute, applyMutant(original, m))
      try {
        const plan = veyrumPlan(corpus, paths.repo, paths.store, paths.scratch)
        const planChecks = plan.decisions.map((d) => d.check)
        const veyrumSelection = new Set(
          plan.decisions.filter((d) => d.action === 'run').map((d) => d.check.path),
        )
        const selections = await selectAll(
          corpus,
          paths,
          store,
          planChecks.length > 0 ? planChecks : checks,
          [m.file],
          null,
          veyrumSelection,
        )
        let timedOut = false
        let killed: string[] = []
        try {
          const kill = plainRun(
            corpus,
            paths.repo,
            paths.scratch,
            [],
            Math.round(Math.max(120_000, captureWallMs * 3)),
          )
          killed = [...kill.outcomes]
            .filter(([f, o]) => o.verdict === 'fail' && outcomes.get(f)?.verdict === 'pass')
            .map(([f]) => f)
        } catch (error) {
          timedOut = true
          log(`  mutant run failed: ${String(error).slice(0, 600)}`)
        }
        const baselines: MutantResult['baselines'] = {}
        for (const name of BASELINES) {
          const sel = selections[name]
          if (!sel) continue
          baselines[name] = {
            selected: sel.size,
            selectedMs: durationOf(outcomes, sel),
            escapes: killed.filter((f) => !sel.has(f)),
          }
        }
        log(
          `  mutant ${m.file}:${m.line} ${m.kind}: killed ${killed.length}${timedOut ? ' (timed out)' : ''}`,
        )
        return {
          kind: 'mutant',
          sha,
          mutant: { file: m.file, line: m.line, kind: m.kind },
          pool,
          killed,
          timedOut,
          baselines,
        }
      } finally {
        fs.writeFileSync(absolute, original)
      }
    })()
  }
}
