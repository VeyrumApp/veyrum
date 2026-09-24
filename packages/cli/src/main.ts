#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  DEFAULT_POLICY,
  type Decision,
  makePolicy,
  parseShard,
  type RunMode,
  type RunOptions,
  type RunResult,
  type Shard,
  Store,
} from '@veyrum/core'
import { openStoreOrReset, runPlain } from './fallback.ts'
import { markdownSummary } from './summary.ts'

const HELP = `veyrum - run only the tests whose evidence is no longer valid

Usage:
  veyrum run [files] [options]  Run test files whose inputs changed; reuse evidence for the rest
  veyrum run --full [files]     Run every test file (or the named ones) and record evidence
  veyrum plan [files] [options] Show what would run and why, without running anything
  veyrum explain <file>         Explain the decision for one test file
  veyrum stats [options]        Show evidence store statistics
  veyrum merge <store...>       Add the evidence of other stores (parallel CI jobs) to the store

Options:
  --root <dir>         Project root (default: current directory)
  --runner <name>      vitest or jest (default: detected from the project)
  --config <file>      Runner config file
  --store <file>       Evidence store (default: <root>/.veyrum/store.sqlite)
  --max-workers <n>    Worker count
  --project <name>     Project filter (repeatable; Vitest allows wildcards, Jest matches
                       display names)
  --json <file>        Write decisions, records and outcomes as JSON
  --record-all         With --full: record evidence for every file, including those whose
                       evidence is still valid (by default they run without capture)
  --summary <file>     Append a Markdown report (for example to $GITHUB_STEP_SUMMARY)
  --explain            Print the reason for every decision
  --quiet              Do not print the runner's test output
  --audit              With --full: also report files the plan would have reused that fail
  --canary <fraction>  Also run this fraction of reusable files and report any that fail
  --shard <i>/<n>      Plan and run only this job's share of the test files, for n parallel
                       jobs; merge their stores afterwards
  --allow <flag>       Allow reuse despite a flag (repeatable), for example spawn; at your own risk
  --isolate            Vitest: run each test file in its own isolate even if the project
                       disables isolation (evidence from shared isolates is never reused)
  --strict             Fail on Veyrum's own errors. By default, if Veyrum fails before tests
                       run, the project's own runner runs every test instead; if recording
                       evidence fails, the test results stand and nothing is reused later
  --no-prune           Keep every record (by default a run keeps, per file and runtime, only the
                       records the planner reads); for tools that analyse the store's history
  --keep-scratch       Keep raw worker payloads under .veyrum/tmp (debugging)
  -h, --help           Show this help
`

interface Args {
  command: string
  positionals: string[]
  root: string
  runner: 'vitest' | 'jest' | undefined
  config: string | undefined
  store: string
  maxWorkers: number | undefined
  projects: string[]
  json: string | undefined
  summary: string | undefined
  explain: boolean
  quiet: boolean
  full: boolean
  keepScratch: boolean
  strict: boolean
  isolate: boolean
  audit: boolean
  recordAll: boolean
  canary: number
  shard: Shard | undefined
  prune: boolean
  allow: string[]
}

function parse(argv: string[]): Args | null {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      runner: { type: 'string' },
      config: { type: 'string' },
      store: { type: 'string' },
      'max-workers': { type: 'string' },
      project: { type: 'string', multiple: true },
      json: { type: 'string' },
      summary: { type: 'string' },
      explain: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      'keep-scratch': { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      isolate: { type: 'boolean', default: false },
      audit: { type: 'boolean', default: false },
      'record-all': { type: 'boolean', default: false },
      canary: { type: 'string' },
      shard: { type: 'string' },
      'no-prune': { type: 'boolean', default: false },
      allow: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command, ...rest] = positionals
  if (values.help || !command) return null
  const root = path.resolve(values.root ?? process.cwd())
  const maxWorkers = values['max-workers'] ? Number(values['max-workers']) : undefined
  if (values.runner !== undefined && values.runner !== 'vitest' && values.runner !== 'jest') {
    throw new Error(`Unknown runner "${values.runner}" (expected vitest or jest)`)
  }
  return {
    command,
    positionals: rest,
    root,
    runner: values.runner,
    config: values.config,
    store: path.resolve(values.store ?? path.join(root, '.veyrum', 'store.sqlite')),
    maxWorkers: maxWorkers && Number.isFinite(maxWorkers) ? maxWorkers : undefined,
    projects: values.project ?? [],
    json: values.json,
    summary: values.summary,
    explain: values.explain,
    quiet: values.quiet,
    full: values.full,
    keepScratch: values['keep-scratch'],
    strict: values.strict,
    isolate: values.isolate,
    audit: values.audit,
    recordAll: values['record-all'],
    canary: values.canary ? Math.max(0, Math.min(1, Number(values.canary))) : 0,
    shard: values.shard ? parseShard(values.shard) : undefined,
    prune: !values['no-prune'],
    allow: values.allow ?? [],
  }
}

const VITEST_CONFIG = /^vitest\.(config|workspace)\.[cm]?[jt]s$/
const JEST_CONFIG = /^jest\.config\.([cm]?[jt]s|json)$/

/** Picks the runner from configuration files, then from declared dependencies. */
function detectRunner(root: string): 'vitest' | 'jest' {
  let names: string[] = []
  try {
    names = fs.readdirSync(root)
  } catch {
    // An unreadable root fails later with a clearer error.
  }
  if (names.some((n) => VITEST_CONFIG.test(n))) return 'vitest'
  if (names.some((n) => JEST_CONFIG.test(n))) return 'jest'
  let pkg: { jest?: unknown; dependencies?: object; devDependencies?: object } = {}
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {
    // No manifest: default below.
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  if ('vitest' in deps) return 'vitest'
  if (pkg.jest !== undefined || 'jest' in deps) return 'jest'
  return 'vitest'
}

/** Runs through the adapter for the project's runner. */
async function runWith(runner: 'vitest' | 'jest', args: Args, common: RunOptions): Promise<RunResult> {
  // Fault injection for the fail-open tests.
  if (process.env.VEYRUM_FAULT === 'before-run') throw new Error('injected fault before the run')
  if (runner === 'jest') {
    const { runJest } = await import('@veyrum/jest')
    return runJest({
      ...common,
      ...(args.config ? { config: args.config } : {}),
      ...(args.maxWorkers ? { maxWorkers: args.maxWorkers } : {}),
      ...(args.projects.length > 0 ? { projects: args.projects } : {}),
    })
  }
  const { runVitest } = await import('@veyrum/vitest')
  return runVitest({
    ...common,
    ...(args.config ? { config: args.config } : {}),
    vitestOptions: {
      ...(args.maxWorkers ? { maxWorkers: args.maxWorkers } : {}),
      ...(args.projects.length > 0 ? { project: args.projects } : {}),
    },
    forceIsolation: args.isolate,
  })
}

function gitRevision(root: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function formatMs(ms: number): string {
  return ms >= 60_000
    ? `${(ms / 60_000).toFixed(1)}m`
    : ms >= 1000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.round(ms)}ms`
}

function describe(decision: Decision): string {
  const head = `${decision.action === 'skip' ? 'reuse' : 'run  '} ${decision.check.project ? `[${decision.check.project}] ` : ''}${decision.check.path}`
  if (decision.action === 'skip') {
    const flags = decision.flagsRelied.length > 0 ? `; relies on ${decision.flagsRelied.join(', ')}` : ''
    return `${head}\n        ${decision.closureSize} recorded inputs unchanged (evidence ${decision.recordId?.slice(0, 8)})${flags}`
  }
  return `${head}\n${decision.details.map((d) => `        ${d}`).join('\n')}`
}

/**
 * Writes an object whose array fields are written one element at a time: a run over a huge tree
 * produces more JSON than fits in one string.
 */
function writeJson(file: string, fields: Record<string, unknown>): void {
  const fd = fs.openSync(file, 'w')
  try {
    let separator = '{'
    for (const [key, value] of Object.entries(fields)) {
      fs.writeSync(fd, `${separator}\n${JSON.stringify(key)}: `)
      separator = ','
      if (!Array.isArray(value)) {
        fs.writeSync(fd, JSON.stringify(value))
        continue
      }
      let itemSeparator = '['
      for (const item of value) {
        fs.writeSync(fd, `${itemSeparator}\n${JSON.stringify(item)}`)
        itemSeparator = ','
      }
      fs.writeSync(fd, itemSeparator === '[' ? '[]' : '\n]')
    }
    fs.writeSync(fd, '\n}\n')
  } finally {
    fs.closeSync(fd)
  }
}

function summarize(result: RunResult, mode: RunMode): string {
  const reused = result.decisions.filter((d) => d.action === 'skip')
  const savedMs = reused.reduce((sum, d) => sum + d.durationMs, 0)
  if (mode === 'full') {
    const recorded = result.outcomes.filter((o) => o.captured).length
    const { planMs, runMs, recordMs } = result.timings
    return [
      `veyrum: ${result.decisions.length} test files, ran ${result.outcomes.length}, recorded evidence for ${recorded} (the others already had valid evidence)`,
      `veyrum: plan ${formatMs(planMs)}, run ${formatMs(runMs)}, record ${formatMs(recordMs)}`,
    ].join('\n')
  }
  const lines = [
    `veyrum: ${result.decisions.length} test files, ${mode === 'plan' ? 'would run' : 'ran'} ${result.decisions.length - reused.length}, reused evidence for ${reused.length}`,
  ]
  if (reused.length > 0)
    lines.push(`veyrum: reused evidence covers about ${formatMs(savedMs)} of recorded test time`)
  const { planMs, runMs, recordMs } = result.timings
  lines.push(`veyrum: plan ${formatMs(planMs)}, run ${formatMs(runMs)}, record ${formatMs(recordMs)}`)
  return lines.join('\n')
}

/** Prunes the store after a run; a failure only leaves it larger (unless strict). */
function pruneStore(store: Store, strict: boolean): void {
  try {
    store.prune({ keepRecords: DEFAULT_POLICY.maxCandidates })
  } catch (error) {
    if (strict) throw error
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`veyrum: pruning the evidence store failed (${message})\n`)
  }
}

async function main(argv: string[]): Promise<number> {
  let args: Args | null
  try {
    args = parse(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`)
    return 2
  }
  if (!args) {
    process.stdout.write(HELP)
    return 0
  }

  if (args.command === 'stats') {
    if (!fs.existsSync(args.store)) {
      process.stdout.write(`No evidence store at ${args.store}\n`)
      return 0
    }
    const store = Store.open(args.store)
    const s = store.stats()
    const v = store.verificationStats()
    store.close()
    process.stdout.write(
      `store ${args.store}\nruns ${s.runs}\nrecords ${s.records}\ndistinct closures ${s.closures}\nclosure entries ${s.entries}\nsize ${(s.bytes / 1024 / 1024).toFixed(2)} MB\n` +
        `verified reuse decisions ${v.verified}\nescapes ${v.escapes}\n`,
    )
    return 0
  }

  if (args.command === 'merge') {
    if (args.positionals.length === 0) {
      process.stderr.write('merge needs the stores to add\n')
      return 2
    }
    const store = openStoreOrReset(args.store)
    try {
      for (const p of args.positionals) {
        const file = path.resolve(p)
        if (file === args.store) continue
        if (!fs.existsSync(file)) {
          process.stderr.write(`veyrum: no evidence store at ${file}, skipped\n`)
          continue
        }
        process.stdout.write(`veyrum: merged ${store.merge(file)} new records from ${file}\n`)
      }
      if (args.prune) store.prune({ keepRecords: DEFAULT_POLICY.maxCandidates })
    } finally {
      store.close()
    }
    return 0
  }

  if (!['run', 'plan', 'explain'].includes(args.command)) {
    process.stderr.write(`Unknown command: ${args.command}\n\n${HELP}`)
    return 2
  }

  const mode: RunMode = args.command === 'run' ? (args.full ? 'full' : 'affected') : 'plan'
  // Test files named on the command line restrict every command to them.
  const only =
    args.positionals.length > 0
      ? args.positionals.map((p) => path.relative(args.root, path.resolve(p)).split(path.sep).join('/'))
      : undefined
  if (args.command === 'explain' && (!only || only.length === 0)) {
    process.stderr.write('explain needs a test file\n')
    return 2
  }

  const store = args.strict ? Store.open(args.store) : openStoreOrReset(args.store)
  const runner = args.runner ?? detectRunner(args.root)
  try {
    const common = {
      strict: args.strict,
      root: args.root,
      store,
      mode,
      revision: gitRevision(args.root),
      printTests: !args.quiet && mode !== 'plan',
      ...(only ? { only } : {}),
      keepScratch: args.keepScratch,
      audit: args.audit,
      canary: args.canary,
      ...(args.shard ? { shard: args.shard } : {}),
      recordAll: args.recordAll,
      ...(args.allow.length > 0 ? { policy: makePolicy({ allow: args.allow }) } : {}),
    }
    let result: RunResult
    try {
      result = await runWith(runner, args, common)
    } catch (error) {
      // Fail open: Veyrum's own failure must never stand between a project and its tests.
      if (args.strict || mode === 'plan') throw error
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `veyrum: internal error (${message}); running the tests with ${runner} directly, without Veyrum\n`,
      )
      // The runner's own sharding splits files differently from Veyrum's, so a shard that falls
      // back runs every file: otherwise files of this shard could run in no job at all.
      if (args.shard)
        process.stderr.write(
          `veyrum: running every test file, not only shard ${args.shard.index}/${args.shard.count}\n`,
        )
      return runPlain({
        root: args.root,
        runner,
        ...(args.config ? { config: args.config } : {}),
        projects: args.projects,
        ...(args.maxWorkers ? { maxWorkers: args.maxWorkers } : {}),
        ...(only ? { only } : {}),
        quiet: args.quiet,
      })
    }
    if (args.explain || mode === 'plan') {
      for (const d of [...result.decisions].sort((a, b) => a.check.path.localeCompare(b.check.path))) {
        process.stdout.write(`${describe(d)}\n`)
      }
    }
    process.stdout.write(`${summarize(result, mode)}\n`)
    if (result.verifications.length > 0) {
      const escapes = result.verifications.filter((v) => v.outcome === 'fail')
      const kind = result.verifications[0]?.kind === 'audit' ? 'audit' : 'canaries'
      process.stdout.write(
        `veyrum: ${kind}: ${result.verifications.length} reuse decisions verified by running them, ${escapes.length} would have been wrong\n`,
      )
      for (const e of escapes) {
        process.stdout.write(
          `veyrum: ESCAPE ${e.check.path} was reusable (evidence ${e.recordId.slice(0, 8)}) but fails\n`,
        )
      }
    }
    if (args.summary)
      fs.appendFileSync(
        args.summary,
        markdownSummary(result, { mode, audit: args.audit, ...(args.shard ? { shard: args.shard } : {}) }),
      )
    if (args.json) {
      writeJson(args.json, {
        runtimeKey: result.runtimeKey,
        decisions: result.decisions,
        records: result.records,
        outcomes: result.outcomes,
        timings: result.timings,
      })
    }
    if (mode !== 'plan' && args.prune) pruneStore(store, args.strict)
    return result.ok ? 0 : 1
  } finally {
    store.close()
  }
}

// A closed pipe (for example `veyrum plan | head`) is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0)
    throw error
  })
}

process.exitCode = await main(process.argv.slice(2))
