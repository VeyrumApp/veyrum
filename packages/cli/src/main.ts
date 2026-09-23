#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { type Decision, Store } from '@veyrum/core'
import { type RunMode, runVitest, type VitestRunResult } from '@veyrum/vitest'

const HELP = `veyrum - run only the tests whose evidence is no longer valid

Usage:
  veyrum run [options]          Run test files whose inputs changed; reuse evidence for the rest
  veyrum run --full [options]   Run every test file and record evidence
  veyrum plan [options]         Show what would run and why, without running anything
  veyrum explain <file>         Explain the decision for one test file
  veyrum stats [options]        Show evidence store statistics

Options:
  --root <dir>         Project root (default: current directory)
  --config <file>      Vitest config file
  --store <file>       Evidence store (default: <root>/.veyrum/store.sqlite)
  --max-workers <n>    Vitest worker count
  --json <file>        Write decisions and records as JSON
  --explain            Print the reason for every decision
  --quiet              Do not print Vitest's test output
  --keep-scratch       Keep raw worker payloads under .veyrum/tmp (debugging)
  -h, --help           Show this help
`

interface Args {
  command: string
  positionals: string[]
  root: string
  config: string | undefined
  store: string
  maxWorkers: number | undefined
  json: string | undefined
  explain: boolean
  quiet: boolean
  full: boolean
  keepScratch: boolean
}

function parse(argv: string[]): Args | null {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      config: { type: 'string' },
      store: { type: 'string' },
      'max-workers': { type: 'string' },
      json: { type: 'string' },
      explain: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      'keep-scratch': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command, ...rest] = positionals
  if (values.help || !command) return null
  const root = path.resolve(values.root ?? process.cwd())
  const maxWorkers = values['max-workers'] ? Number(values['max-workers']) : undefined
  return {
    command,
    positionals: rest,
    root,
    config: values.config,
    store: path.resolve(values.store ?? path.join(root, '.veyrum', 'store.sqlite')),
    maxWorkers: maxWorkers && Number.isFinite(maxWorkers) ? maxWorkers : undefined,
    json: values.json,
    explain: values.explain,
    quiet: values.quiet,
    full: values.full,
    keepScratch: values['keep-scratch'],
  }
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

function summarize(result: VitestRunResult, mode: RunMode): string {
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
    store.close()
    process.stdout.write(
      `store ${args.store}\nruns ${s.runs}\nrecords ${s.records}\ndistinct closures ${s.closures}\nsize ${(s.bytes / 1024 / 1024).toFixed(2)} MB\n`,
    )
    return 0
  }

  if (!['run', 'plan', 'explain'].includes(args.command)) {
    process.stderr.write(`Unknown command: ${args.command}\n\n${HELP}`)
    return 2
  }

  const mode: RunMode = args.command === 'run' ? (args.full ? 'full' : 'affected') : 'plan'
  const only =
    args.command === 'explain'
      ? args.positionals.map((p) => path.relative(args.root, path.resolve(p)).split(path.sep).join('/'))
      : undefined
  if (args.command === 'explain' && (!only || only.length === 0)) {
    process.stderr.write('explain needs a test file\n')
    return 2
  }

  const store = Store.open(args.store)
  try {
    const result = await runVitest({
      root: args.root,
      store,
      mode,
      revision: gitRevision(args.root),
      printTests: !args.quiet && mode !== 'plan',
      ...(args.config ? { config: args.config } : {}),
      ...(args.maxWorkers ? { vitestOptions: { maxWorkers: args.maxWorkers } } : {}),
      ...(only ? { only } : {}),
      keepScratch: args.keepScratch,
    })
    if (args.explain || mode === 'plan') {
      for (const d of [...result.decisions].sort((a, b) => a.check.path.localeCompare(b.check.path))) {
        process.stdout.write(`${describe(d)}\n`)
      }
    }
    process.stdout.write(`${summarize(result, mode)}\n`)
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

process.exitCode = await main(process.argv.slice(2))
