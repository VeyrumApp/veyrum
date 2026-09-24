import fs from 'node:fs'
import path from 'node:path'
import type { CheckOutcomeSummary, Decision } from '@veyrum/core'
import type { Corpus } from './corpus.ts'
import { childEnv, exec, VEYRUM_CLI } from './exec.ts'

export interface FileOutcome {
  readonly verdict: 'pass' | 'fail'
  readonly durationMs: number
  /** For a failing file: its first failing test and message (diagnostics). */
  readonly failure?: string
}

/** Per test file outcome, keyed by repository-relative path. */
export type Outcomes = Map<string, FileOutcome>

export interface CaptureResult {
  readonly outcomes: Outcomes
  readonly runMs: number
  readonly recordMs: number
  readonly wallMs: number
}

function veyrum(corpus: Corpus, repo: string, store: string, args: readonly string[], json: string) {
  return exec(
    process.execPath,
    [
      ...corpus.nodeArgs,
      VEYRUM_CLI,
      ...args,
      '--runner',
      corpus.runner,
      ...(corpus.config ? ['--config', corpus.config] : []),
      '--quiet',
      // A degraded run (Veyrum falling back to the plain runner) must never become a measurement.
      '--strict',
      // Baselines and rescoring read the store's whole history.
      '--no-prune',
      // Plain runs disable coverage too: overhead compares like with like.
      '--no-coverage',
      '--store',
      store,
      '--max-workers',
      String(corpus.maxWorkers),
      '--json',
      json,
      ...projectArgs(corpus),
      ...(corpus.forceIsolation ? ['--isolate'] : []),
    ],
    { cwd: repo, env: childEnv() },
  )
}

/** Veyrum's CLI takes project filters as --project; other runner args are not passed through. */
function projectArgs(corpus: Corpus): string[] {
  const out: string[] = []
  const args = corpus.runnerArgs
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) out.push('--project', args[++i]!)
  }
  return out
}

/**
 * Reads the CLI's --json output, which writes one array item per line. A run's output can exceed
 * the longest string Node creates (a record with enormous fields), so large outputs are parsed line
 * by line, skipping records (which the rig does not use) and reporting the biggest of their fields.
 */
export function readOutput<T>(file: string, lineByLineAbove = 256 * 1024 * 1024): T {
  const buf = fs.readFileSync(file)
  if (buf.length < lineByLineAbove) return JSON.parse(buf.toString('utf8')) as T
  const out: Record<string, unknown> = {}
  let key: string | null = null
  let items: unknown[] = []
  const oversized: { key: string; bytes: number; fields: string }[] = []
  let start = 0
  while (start < buf.length) {
    let end = buf.indexOf(10, start)
    if (end === -1) end = buf.length
    const length = end - start
    if (key === 'records' && length > 1024 && buf[start] === 0x7b) {
      if (length > 1024 * 1024) oversized.push({ key, bytes: length, fields: fieldSizes(buf, start, end) })
    } else {
      const line = buf.toString('utf8', start, end).replace(/,$/, '')
      const header = /^"(\w+)": (.*)$/.exec(line)
      if (key === null && header) {
        const [, name, rest] = header as unknown as [string, string, string]
        if (rest === '[') {
          key = name
          items = []
        } else out[name] = JSON.parse(rest)
      } else if (key !== null && line === ']') {
        out[key] = items
        key = null
      } else if (key !== null && line !== '') items.push(JSON.parse(line))
    }
    start = end + 1
  }
  for (const o of oversized.sort((a, b) => b.bytes - a.bytes).slice(0, 5))
    process.stderr.write(`[rig] oversized ${o.key} item: ${o.bytes} bytes; ${o.fields}\n`)
  return out as T
}

/** The byte size of each top-level field of the JSON object in buf[start, end). */
function fieldSizes(buf: Buffer, start: number, end: number): string {
  const keys: { name: string; at: number }[] = []
  let depth = 0
  let inString = false
  let stringStart = 0
  for (let i = start; i < end; i++) {
    const c = buf[i]
    if (inString) {
      if (c === 0x5c) i++
      else if (c === 0x22) {
        inString = false
        if (depth === 1 && buf[i + 1] === 0x3a)
          keys.push({ name: buf.toString('utf8', stringStart + 1, Math.min(i, stringStart + 81)), at: i })
      }
    } else if (c === 0x22) {
      inString = true
      stringStart = i
    } else if (c === 0x7b || c === 0x5b) depth++
    else if (c === 0x7d || c === 0x5d) depth--
  }
  return keys
    .map((k, n) => ({ name: k.name, bytes: (keys[n + 1]?.at ?? end) - k.at }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 6)
    .map((k) => `${k.name}=${k.bytes}`)
    .join(' ')
}

/** Full run with capture: ground truth for this commit and evidence for the next. */
export function captureRun(corpus: Corpus, repo: string, store: string, scratch: string): CaptureResult {
  const json = path.join(scratch, 'capture.json')
  fs.rmSync(json, { force: true })
  const r = veyrum(corpus, repo, store, ['run', '--full'], json)
  if (!fs.existsSync(json))
    throw new Error(
      `veyrum run --full produced no output (exit ${r.code}, signal ${r.signal ?? 'none'}):\n${r.stdout}\n${r.stderr}`,
    )
  const data = readOutput<{
    outcomes: CheckOutcomeSummary[]
    timings: { runMs: number; recordMs: number }
  }>(json)
  // Files whose evidence was still valid ran without capture; every file that ran has an outcome.
  const outcomes: Outcomes = new Map()
  for (const o of data.outcomes) outcomes.set(o.check.path, { verdict: o.verdict, durationMs: o.durationMs })
  return { outcomes, runMs: data.timings.runMs, recordMs: data.timings.recordMs, wallMs: r.ms }
}

/**
 * Runs files under capture with a throwaway store: the run is only for its verdicts, and records
 * nothing the replay's own store reads.
 */
export function captureRerun(
  corpus: Corpus,
  repo: string,
  scratch: string,
  files: readonly string[],
): Outcomes {
  const json = path.join(scratch, 'capture-rerun.json')
  const store = path.join(scratch, 'capture-rerun.sqlite')
  for (const f of [json, store, `${store}-wal`, `${store}-shm`]) fs.rmSync(f, { force: true })
  const r = veyrum(corpus, repo, store, ['run', '--full', ...files], json)
  if (!fs.existsSync(json))
    throw new Error(
      `veyrum run --full produced no output (exit ${r.code}, signal ${r.signal ?? 'none'}):\n${r.stdout}\n${r.stderr}`,
    )
  const data = readOutput<{ outcomes: CheckOutcomeSummary[] }>(json)
  const outcomes: Outcomes = new Map()
  for (const o of data.outcomes) outcomes.set(o.check.path, { verdict: o.verdict, durationMs: o.durationMs })
  return outcomes
}

/** Veyrum's plan (the system under test). */
export function veyrumPlan(
  corpus: Corpus,
  repo: string,
  store: string,
  scratch: string,
): { decisions: Decision[]; runtimeKey: string; planMs: number; wallMs: number } {
  const json = path.join(scratch, 'plan.json')
  fs.rmSync(json, { force: true })
  const r = veyrum(corpus, repo, store, ['plan'], json)
  if (!fs.existsSync(json))
    throw new Error(
      `veyrum plan produced no output (exit ${r.code}, signal ${r.signal ?? 'none'}):\n${r.stdout}\n${r.stderr}`,
    )
  const data = JSON.parse(fs.readFileSync(json, 'utf8')) as {
    decisions: Decision[]
    runtimeKey: string
    timings: { planMs: number }
  }
  return { decisions: data.decisions, runtimeKey: data.runtimeKey, planMs: data.timings.planMs, wallMs: r.ms }
}

/**
 * The project's own runner entry point: the nearest node_modules/<runner> from the test root
 * upwards, so a workspace package that inherits the runner from the repository root finds it too.
 * Looked up afresh on every call: the rig outlives many installs, and require.resolve would keep
 * returning a path the package manager has since replaced (pnpm renames a package's directory
 * when its peers change).
 */
function runnerBin(testRoot: string, runner: 'vitest' | 'jest'): string {
  for (let dir = path.resolve(testRoot); ; dir = path.dirname(dir)) {
    const link = path.join(dir, 'node_modules', runner)
    if (fs.existsSync(path.join(link, 'package.json'))) {
      const root = fs.realpathSync(link)
      return path.join(root, ...(runner === 'vitest' ? ['vitest.mjs'] : ['bin', 'jest.js']))
    }
    if (path.dirname(dir) === dir) throw new Error(`no ${runner} installed above ${testRoot}`)
  }
}

/** Jest takes project filters as --selectProjects. */
function jestArgs(corpus: Corpus): string[] {
  const out: string[] = []
  const args = corpus.runnerArgs
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) out.push('--selectProjects', args[++i]!)
    else out.push(args[i]!)
  }
  return [...out, ...(corpus.config ? ['--config', corpus.config] : [])]
}

/** Plain runner invocation (no capture) with per-file results, for mutant kill sets and overhead. */
/**
 * A test file's verdict from its JSON status. Jest reports `skipped` when every test in the file
 * was skipped and `focused` when the tests that ran passed but some were skipped; only `failed`
 * is a failure (Vitest reports only `passed` and `failed`).
 */
export function fileVerdict(status: string): 'pass' | 'fail' {
  return status === 'failed' ? 'fail' : 'pass'
}

export function plainRun(
  corpus: Corpus,
  repo: string,
  scratch: string,
  files: readonly string[] = [],
  timeoutMs?: number,
): { outcomes: Outcomes; wallMs: number } {
  const json = path.join(scratch, 'plain.json')
  fs.rmSync(json, { force: true })
  const args =
    corpus.runner === 'jest'
      ? [
          ...corpus.nodeArgs,
          runnerBin(repo, 'jest'),
          ...jestArgs(corpus),
          `--maxWorkers=${corpus.maxWorkers}`,
          // Veyrum's runs collect no project coverage; neither may the run they are compared with.
          '--coverage=false',
          '--ci',
          '--silent',
          '--json',
          `--outputFile=${json}`,
          '--passWithNoTests',
          ...(files.length > 0 ? ['--runTestsByPath', ...files] : []),
        ]
      : [
          ...corpus.nodeArgs,
          runnerBin(repo, 'vitest'),
          'run',
          ...corpus.runnerArgs,
          ...(corpus.config ? ['--config', corpus.config] : []),
          `--maxWorkers=${corpus.maxWorkers}`,
          // Veyrum's runs collect no project coverage; neither may the run they are compared with.
          '--coverage.enabled=false',
          '--reporter=json',
          `--outputFile=${json}`,
          '--passWithNoTests',
          ...(corpus.forceIsolation ? ['--isolate'] : []),
          ...files,
        ]
  const r = exec(process.execPath, args, { cwd: repo, env: childEnv(), ...(timeoutMs ? { timeoutMs } : {}) })
  const outcomes: Outcomes = new Map()
  if (!fs.existsSync(json))
    throw new Error(
      `plain ${corpus.runner} run produced no JSON (exit ${r.code}, signal ${r.signal ?? 'none'}):\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`,
    )
  // Vitest's JSON reporter follows Jest's format.
  const data = JSON.parse(fs.readFileSync(json, 'utf8')) as {
    testResults: {
      name: string
      status: string
      startTime?: number
      endTime?: number
      message?: string
      assertionResults?: { status: string; fullName?: string; failureMessages?: string[] }[]
    }[]
  }
  for (const t of data.testResults) {
    const rel = path.relative(repo, t.name).split(path.sep).join('/')
    const verdict = fileVerdict(t.status)
    const failedTest = t.assertionResults?.find((a) => a.status === 'failed')
    const why = failedTest
      ? `${failedTest.fullName ?? ''}: ${failedTest.failureMessages?.[0] ?? ''}`
      : (t.message ?? '')
    outcomes.set(rel, {
      verdict,
      durationMs: (t.endTime ?? 0) - (t.startTime ?? 0),
      ...(verdict === 'fail' ? { failure: why.replace(/\s+/g, ' ').slice(0, 400) } : {}),
    })
  }
  return { outcomes, wallMs: r.ms }
}

/**
 * The runner's own changed-files selection: test files whose static import graph reaches a file
 * changed since `since` (Vitest --changed, Jest --changedSince).
 */
export function runnerChanged(
  corpus: Corpus,
  repo: string,
  scratch: string,
  since: string | null,
): Set<string> | null {
  if (corpus.runner === 'jest') {
    const r = exec(
      process.execPath,
      [
        ...corpus.nodeArgs,
        runnerBin(repo, 'jest'),
        ...jestArgs(corpus),
        '--listTests',
        '--json',
        since ? `--changedSince=${since}` : '--onlyChanged',
        '--passWithNoTests',
      ],
      { cwd: repo, env: childEnv() },
    )
    if (r.code !== 0) return null
    const line = r.stdout
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('['))
      .pop()
    if (!line) return new Set()
    const files = JSON.parse(line) as string[]
    return new Set(files.map((f) => path.relative(repo, f).split(path.sep).join('/')))
  }
  const json = path.join(scratch, 'changed.json')
  fs.rmSync(json, { force: true })
  const r = exec(
    process.execPath,
    [
      ...corpus.nodeArgs,
      runnerBin(repo, 'vitest'),
      'list',
      ...corpus.runnerArgs,
      ...(corpus.config ? ['--config', corpus.config] : []),
      since ? `--changed=${since}` : '--changed',
      '--filesOnly',
      `--json=${json}`,
      '--passWithNoTests',
    ],
    { cwd: repo, env: childEnv() },
  )
  if (!fs.existsSync(json)) {
    // Vitest prints nothing when no test is affected.
    if (r.code === 0) return new Set()
    return null
  }
  const data = JSON.parse(fs.readFileSync(json, 'utf8')) as { file: string }[]
  return new Set(data.map((d) => path.relative(repo, d.file).split(path.sep).join('/')))
}
