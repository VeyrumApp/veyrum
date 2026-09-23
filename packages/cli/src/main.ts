#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { type Decision, makePolicy, type RunMode, type RunResult, Store } from '@veyrum/core'

const HELP = `veyrum - run only the tests whose evidence is no longer valid

Usage:
  veyrum run [files] [options]  Run test files whose inputs changed; reuse evidence for the rest
  veyrum run --full [files]     Run every test file (or the named ones) and record evidence
  veyrum plan [files] [options] Show what would run and why, without running anything
  veyrum explain <file>         Explain the decision for one test file
  veyrum stats [options]        Show evidence store statistics

Options:
  --root <dir>         Project root (default: current directory)
  --runner <name>      vitest or jest (default: detected from the project)
  --config <file>      Runner config file
  --store <file>       Evidence store (default: <root>/.veyrum/store.sqlite)
  --max-workers <n>    Worker count
  --project <name>     Project filter (repeatable; Vitest allows wildcards, Jest matches
                       display names)
  --json <file>        Write decisions and records as JSON
  --explain            Print the reason for every decision
  --quiet              Do not print the runner's test output
  --audit              With --full: also report files the plan would have reused that fail
  --canary <fraction>  Also run this fraction of reusable files and report any that fail
  --allow <flag>       Allow reuse despite a flag (repeatable), for example spawn; at your own risk
  --isolate            Vitest: run each test file in its own isolate even if the project
                       disables isolation (evidence from shared isolates is never reused)
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
  explain: boolean
  quiet: boolean
  full: boolean
  keepScratch: boolean
  isolate: boolean
  audit: boolean
  canary: number
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
      explain: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      'keep-scratch': { type: 'boolean', default: false },
      isolate: { type: 'boolean', default: false },
      audit: { type: 'boolean', default: false },
      canary: { type: 'string' },
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
    explain: values.explain,
    quiet: values.quiet,
    full: values.full,
    keepScratch: values['keep-scratch'],
    isolate: values.isolate,
    audit: values.audit,
    canary: values.canary ? Math.max(0, Math.min(1, Number(values.canary))) : 0,
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

function summarize(result: RunResult, mode: RunMode): string {
  const reused = result.decisions.filter((d) => d.action === 'skip')
  const savedMs = reused.reduce((sum, d) => sum + d.durationMs, 0)
  const lines = [
    `veyrum: ${result.decisions.length} test files, ${mode === 'plan' ? 'would run' : 'ran'} ${result.decisions.length - reused.length}, reused evidence for ${reused.length}`,
  ]
  if (reused.length > 0)
    lines.push(`veyrum: reused evidence covers about ${formatMs(savedMs)} of recorded test time`)
  const { planMs, runMs, recordMs } = result.timings
  lines.push(`veyrum: plan ${formatMs(planMs)}, run ${formatMs(runMs)}, record ${formatMs(recordMs)}`)
  return lines.join('\n')
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
      `store ${args.store}\nruns ${s.runs}\nrecords ${s.records}\ndistinct closures ${s.closures}\nsize ${(s.bytes / 1024 / 1024).toFixed(2)} MB\n` +
        `verified reuse decisions ${v.verified}\nescapes ${v.escapes}\n`,
    )
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

  const store = Store.open(args.store)
  try {
    const common = {
      root: args.root,
      store,
      mode,
      revision: gitRevision(args.root),
      printTests: !args.quiet && mode !== 'plan',
      ...(only ? { only } : {}),
      keepScratch: args.keepScratch,
      audit: args.audit,
      canary: args.canary,
      ...(args.allow.length > 0 ? { policy: makePolicy({ allow: args.allow }) } : {}),
    }
    const runner = args.runner ?? detectRunner(args.root)
    let result: RunResult
    if (runner === 'jest') {
      const { runJest } = await import('@veyrum/jest')
      result = await runJest({
        ...common,
        ...(args.config ? { config: args.config } : {}),
        ...(args.maxWorkers ? { maxWorkers: args.maxWorkers } : {}),
        ...(args.projects.length > 0 ? { projects: args.projects } : {}),
      })
    } else {
      const { runVitest } = await import('@veyrum/vitest')
      result = await runVitest({
        ...common,
        ...(args.config ? { config: args.config } : {}),
        vitestOptions: {
          ...(args.maxWorkers ? { maxWorkers: args.maxWorkers } : {}),
          ...(args.projects.length > 0 ? { project: args.projects } : {}),
        },
        forceIsolation: args.isolate,
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
    if (args.json) {
      fs.writeFileSync(
        args.json,
        JSON.stringify(
          { decisions: result.decisions, records: result.records, timings: result.timings },
          null,
          2,
        ),
      )
    }
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
