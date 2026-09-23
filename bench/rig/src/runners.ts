import fs from 'node:fs'
import path from 'node:path'
import type { Decision, EvidenceRecord } from '@veyrum/core'
import type { Corpus } from './corpus.ts'
import { childEnv, exec, VEYRUM_CLI } from './exec.ts'

export interface FileOutcome {
  readonly verdict: 'pass' | 'fail'
  readonly durationMs: number
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
      VEYRUM_CLI,
      ...args,
      '--quiet',
      '--store',
      store,
      '--max-workers',
      String(corpus.maxWorkers),
      '--json',
      json,
      ...projectArgs(corpus),
    ],
    { cwd: repo, env: childEnv() },
  )
}

/** Veyrum's CLI takes project filters as --project; other Vitest args are not passed through. */
function projectArgs(corpus: Corpus): string[] {
  const out: string[] = []
  const args = corpus.vitestArgs
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) out.push('--project', args[++i]!)
  }
  return out
}

/** Full run with capture: ground truth for this commit and evidence for the next. */
export function captureRun(corpus: Corpus, repo: string, store: string, scratch: string): CaptureResult {
  const json = path.join(scratch, 'capture.json')
  fs.rmSync(json, { force: true })
  const r = veyrum(corpus, repo, store, ['run', '--full'], json)
  if (!fs.existsSync(json)) throw new Error(`veyrum run --full produced no output:\n${r.stdout}\n${r.stderr}`)
  const data = JSON.parse(fs.readFileSync(json, 'utf8')) as {
    records: EvidenceRecord[]
    timings: { runMs: number; recordMs: number }
  }
  const outcomes: Outcomes = new Map()
  for (const rec of data.records)
    outcomes.set(rec.check, { verdict: rec.verdict, durationMs: rec.durationMs })
  return { outcomes, runMs: data.timings.runMs, recordMs: data.timings.recordMs, wallMs: r.ms }
}

/** Veyrum's plan (the system under test). */
export function veyrumPlan(
  corpus: Corpus,
  repo: string,
  store: string,
  scratch: string,
): { decisions: Decision[]; planMs: number; wallMs: number } {
  const json = path.join(scratch, 'plan.json')
  fs.rmSync(json, { force: true })
  const r = veyrum(corpus, repo, store, ['plan'], json)
  if (!fs.existsSync(json)) throw new Error(`veyrum plan produced no output:\n${r.stdout}\n${r.stderr}`)
  const data = JSON.parse(fs.readFileSync(json, 'utf8')) as {
    decisions: Decision[]
    timings: { planMs: number }
  }
  return { decisions: data.decisions, planMs: data.timings.planMs, wallMs: r.ms }
}

const VITEST_BIN = ['node_modules', 'vitest', 'vitest.mjs']

/** Plain Vitest run (no capture) with per-file results, used for mutant kill sets and overhead. */
export function plainRun(
  corpus: Corpus,
  repo: string,
  scratch: string,
  files: readonly string[] = [],
  timeoutMs?: number,
): { outcomes: Outcomes; wallMs: number } {
  const json = path.join(scratch, 'plain.json')
  fs.rmSync(json, { force: true })
  const r = exec(
    process.execPath,
    [
      path.join(repo, ...VITEST_BIN),
      'run',
      ...corpus.vitestArgs,
      `--maxWorkers=${corpus.maxWorkers}`,
      '--reporter=json',
      `--outputFile=${json}`,
      '--passWithNoTests',
      ...files,
    ],
    { cwd: repo, env: childEnv(), ...(timeoutMs ? { timeoutMs } : {}) },
  )
  const outcomes: Outcomes = new Map()
  if (!fs.existsSync(json))
    throw new Error(`plain vitest run produced no JSON:\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`)
  const data = JSON.parse(fs.readFileSync(json, 'utf8')) as {
    testResults: { name: string; status: string; startTime?: number; endTime?: number }[]
  }
  for (const t of data.testResults) {
    const rel = path.relative(repo, t.name).split(path.sep).join('/')
    outcomes.set(rel, {
      verdict: t.status === 'passed' ? 'pass' : 'fail',
      durationMs: (t.endTime ?? 0) - (t.startTime ?? 0),
    })
  }
  return { outcomes, wallMs: r.ms }
}

/** Vitest's own --changed selection: test files statically importing a changed file. */
export function vitestChanged(
  corpus: Corpus,
  repo: string,
  scratch: string,
  since: string | null,
): Set<string> | null {
  const json = path.join(scratch, 'changed.json')
  fs.rmSync(json, { force: true })
  const r = exec(
    process.execPath,
    [
      path.join(repo, ...VITEST_BIN),
      'list',
      ...corpus.vitestArgs,
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
