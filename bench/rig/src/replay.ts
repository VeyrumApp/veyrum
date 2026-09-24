import fs from 'node:fs'
import path from 'node:path'
import { type CheckRef, Store } from '@veyrum/core'
import { type SelectionContext, selectFileClosure, selectFileCoverage, selectNaive } from './baselines.ts'
import type { Corpus } from './corpus.ts'
import { exec, git, KilledError } from './exec.ts'
import { applyMutant, type Mutant, mutationSites, rng } from './mutate.ts'
import { captureRun, type Outcomes, plainRun, runnerChanged, veyrumPlan } from './runners.ts'

export const BASELINES = [
  'all',
  'naive',
  'runner-changed',
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
  /** Why Veyrum ran files: count per reason, and the first details of each (diagnostics). */
  readonly veyrumReasons?: Readonly<
    Record<string, { readonly count: number; readonly details: readonly string[] }>
  >
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

/** A commit that could not be replayed (install, runner or Veyrum failed); not scored. */
export interface BrokenResult {
  readonly kind: 'broken'
  readonly index: number
  readonly sha: string
  readonly error: string
}

export type ResultLine = CommitResult | MutantResult | BrokenResult

interface ReplayPaths {
  readonly work: string
  readonly repo: string
  /** Where the tests run (the repository, or a package inside it). */
  readonly testRoot: string
  readonly store: string
  readonly results: string
  readonly scratch: string
}

export function pathsFor(corpus: Corpus, benchRoot: string): ReplayPaths {
  const work = path.join(benchRoot, corpus.name)
  return {
    work,
    repo: path.join(work, 'repo'),
    testRoot: path.join(work, 'repo', corpus.cwd),
    store: path.join(work, 'store.sqlite'),
    results: path.join(work, 'results.jsonl'),
    scratch: path.join(work, 'scratch'),
  }
}

function log(message: string): void {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`)
}

export function readResults(file: string): ResultLine[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ResultLine)
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

function prepare(corpus: Corpus, repo: string): void {
  const [cmd, ...args] = corpus.prepare ?? []
  if (!cmd) return
  const r = exec(cmd, args, { cwd: repo })
  if (r.code !== 0) throw new Error(`prepare failed:\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`)
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
  /** The runtime key Veyrum planned with: whole-file closure identity must honor it too. */
  runtimeKey: string,
): Promise<Record<BaselineName, Set<string> | null>> {
  // Git paths are relative to the repository; selectors work relative to the test root.
  const relative = changed.map((f) =>
    path.relative(paths.testRoot, path.join(paths.repo, f)).split(path.sep).join('/'),
  )
  const ctx: SelectionContext = {
    repo: paths.testRoot,
    store,
    checks,
    changed: relative,
    lockfileChanged: changed.some((f) => corpus.lockfiles.includes(f)),
    lockfiles: corpus.lockfiles.map((f) =>
      path.relative(paths.testRoot, path.join(paths.repo, f)).split(path.sep).join('/'),
    ),
  }
  return {
    all: new Set(checks.map((c) => c.path)),
    naive: selectNaive(ctx),
    'runner-changed': runnerChanged(corpus, paths.testRoot, paths.scratch, since),
    'file-coverage': selectFileCoverage(ctx),
    'file-closure': await selectFileClosure(ctx, runtimeKey),
    veyrum: veyrumSelection,
  }
}

export interface ReplayOptions {
  /** Measure an uninstrumented run every N commits (0 disables). */
  readonly overheadEvery: number
  /**
   * Replay only window `index` of `count` contiguous windows of the range, preceded by its own
   * warm-up commit, so windows run in parallel. Commit indexes stay global; a window's warm-up
   * records no mutants or overhead pairs unless it is the range's own first commit, so merged
   * results count every commit once.
   */
  readonly shard?: { readonly index: number; readonly count: number }
}

/** The commits of one shard (with its warm-up first), as [global index, sha] pairs. */
export function shardCommits(
  shas: readonly string[],
  shard: ReplayOptions['shard'],
): (readonly [number, string])[] {
  const all = shas.map((sha, i) => [i, sha] as const)
  if (!shard || shard.count <= 1) return all
  const commits = shas.length - 1
  const start = 1 + Math.floor((shard.index * commits) / shard.count)
  const end = Math.floor(((shard.index + 1) * commits) / shard.count)
  return all.slice(start - 1, end + 1)
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

  const lines = readResults(paths.results)
  const done = lines.filter((r): r is CommitResult => r.kind === 'commit')
  const doneShas = new Set([...done, ...lines.filter((r) => r.kind === 'broken')].map((r) => r.sha))
  let broken = 0
  let prev: CommitResult | undefined = done[done.length - 1]
  const store = Store.open(paths.store)
  // Synchronous appends: everything else in the loop is synchronous, so a buffered stream would
  // never flush, and results must survive an interrupted replay.
  const write = (line: ResultLine): void => {
    fs.appendFileSync(paths.results, `${JSON.stringify(line)}\n`)
  }

  try {
    const window = shardCommits(shas, options.shard)
    const firstIndex = window[0]?.[0] ?? 0
    for (const [index, sha] of window) {
      if (doneShas.has(sha)) continue
      // A shard's own warm-up commit is scored by the previous shard; it only records evidence.
      const scored = index === 0 || index !== firstIndex
      log(`commit ${index}/${shas.length - 1} ${sha.slice(0, 10)}`)
      try {
        // A replay interrupted after this commit's capture was stored, but before its result line was
        // written, left evidence from this very commit. Plans must only see earlier commits.
        const purged = store.forgetRevision(sha)
        if (purged > 0) log(`  discarded ${purged} run(s) recorded at this commit by an interrupted replay`)
        checkout(paths.repo, sha)
        // As CI does on every run. The clean removed what install generates outside node_modules
        // (postinstall steps such as `nuxt prepare`), and a state CI never sees skews every selector.
        install(corpus, paths.repo)
        prepare(corpus, paths.repo)

        const parent = prev?.sha ?? null
        const changed = parent
          ? git(paths.repo, 'diff', '--name-only', parent, sha).split('\n').filter(Boolean)
          : []

        // 1. Plans, made before anything runs at this commit, from evidence of earlier commits only.
        let selections: Record<BaselineName, Set<string> | null> | null = null
        let veyrumPlanMs: number | null = null
        let veyrumReasons: Record<string, { count: number; details: string[] }> | undefined
        let checks: CheckRef[] = []
        if (parent) {
          const p = veyrumPlan(corpus, paths.testRoot, paths.store, paths.scratch)
          veyrumPlanMs = p.planMs
          veyrumReasons = {}
          for (const d of p.decisions) {
            if (d.action !== 'run') continue
            const entry = veyrumReasons[d.reason] ?? { count: 0, details: [] }
            veyrumReasons[d.reason] = entry
            entry.count++
            for (const detail of d.details.length > 0 ? d.details : ['']) {
              if (entry.details.length >= 8) break
              const line = `${d.check.path}: ${detail}`
              if (!entry.details.includes(line)) entry.details.push(line)
            }
          }
          checks = p.decisions.map((d) => d.check)
          const veyrumSelection = new Set(
            p.decisions.filter((d) => d.action === 'run').map((d) => d.check.path),
          )
          selections = await selectAll(
            corpus,
            paths,
            store,
            checks,
            changed,
            parent,
            veyrumSelection,
            p.runtimeKey,
          )
        }

        // 2. Optional uninstrumented run for overhead (before capture, alternating order is not needed
        //    since both runs are sequential on the same tree).
        let plainWallMs: number | null = null
        if (scored && options.overheadEvery > 0 && index % options.overheadEvery === 0) {
          plainWallMs = plainRun(corpus, paths.testRoot, paths.scratch).wallMs
        }

        // 3. Ground truth and evidence for the next commit.
        const capture = captureRun(corpus, paths.testRoot, paths.store, paths.scratch)
        const outcomes = capture.outcomes
        const flaky = detectFlaky(corpus, paths.testRoot, paths.scratch, outcomes)
        const prevOutcomes = new Map(Object.entries(prev?.outcomes ?? {}))
        const flips: string[] = []
        for (const [file, o] of outcomes) {
          if (flaky.has(file)) continue
          const before = prevOutcomes.get(file)
          if (before ? before[0] !== o.verdict : o.verdict === 'fail') flips.push(file)
        }
        const failing = [...outcomes]
          .filter(([f, o]) => o.verdict === 'fail' && !flaky.has(f))
          .map(([f]) => f)

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
          ...(veyrumReasons ? { veyrumReasons } : {}),
          capture: { runMs: capture.runMs, recordMs: capture.recordMs, wallMs: capture.wallMs },
          plainWallMs,
        }
        write(result)
        const summary = baselines
          ? BASELINES.map((b) => `${b}=${baselines?.[b]?.selected?.length ?? '-'}`).join(' ')
          : 'warm-up'
        log(`  ${outcomes.size} files, ${flips.length} flips, ${flaky.size} flaky; ${summary}`)

        // 4. Mutants on sampled commits, using evidence recorded at this commit.
        if (scored && corpus.mutantsPerCommit > 0 && index % corpus.mutationEvery === 0) {
          for (const m of runMutants(corpus, paths, store, sha, changed, outcomes, capture.wallMs)) {
            const result = await m
            if (result) write(result)
          }
        }
        prev = result
      } catch (error) {
        // A commit whose tree cannot be tested (for example a test glob that walks into
        // node_modules) is recorded and skipped; the replay fails at the end so it is noticed.
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
        log(`  commit ${sha.slice(0, 10)} could not be replayed:\n${message.slice(0, 4000)}`)
        store.forgetRevision(sha)
        write({ kind: 'broken', index, sha, error: message.slice(0, 2000) })
        broken++
      }
    }
  } finally {
    store.close()
  }
  if (broken > 0)
    throw new Error(`${broken} commit(s) could not be replayed; see the broken lines in ${paths.results}`)
}

function* runMutants(
  corpus: Corpus,
  paths: ReplayPaths,
  store: Store,
  sha: string,
  changed: readonly string[],
  outcomes: Outcomes,
  captureWallMs: number,
): Generator<Promise<MutantResult | null>> {
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
    yield (async (): Promise<MutantResult | null> => {
      const absolute = path.join(paths.repo, m.file)
      const original = fs.readFileSync(absolute, 'utf8')
      fs.writeFileSync(absolute, applyMutant(original, m))
      try {
        try {
          prepare(corpus, paths.repo)
        } catch {
          // A mutant that does not build tests nothing about selection.
          log(`  mutant ${m.file}:${m.line} ${m.kind}: does not build, skipped`)
          return null
        }
        const plan = veyrumPlan(corpus, paths.testRoot, paths.store, paths.scratch)
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
          plan.runtimeKey,
        )
        let timedOut = false
        let killed: string[] = []
        try {
          const kill = plainRun(
            corpus,
            paths.testRoot,
            paths.scratch,
            [],
            Math.round(Math.max(120_000, captureWallMs * 3)),
          )
          const failing = [...kill.outcomes]
            .filter(([f, o]) => o.verdict === 'fail' && outcomes.get(f)?.verdict === 'pass')
            .map(([f]) => f)
          // A flaky file can fail once under any mutant: a kill counts only if it fails again.
          if (failing.length > 0) {
            const again = plainRun(corpus, paths.testRoot, paths.scratch, failing)
            killed = failing.filter((f) => again.outcomes.get(f)?.verdict === 'fail')
            const flaky = failing.length - killed.length
            if (flaky > 0)
              log(`  mutant ${m.file}:${m.line}: ${flaky} failing file(s) passed on rerun, not counted`)
          }
        } catch (error) {
          if (error instanceof KilledError) throw error
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
        prepare(corpus, paths.repo)
      }
    })()
  }
}
