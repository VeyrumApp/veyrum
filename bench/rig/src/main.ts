#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadCorpus } from './corpus.ts'
import { EXIT_KILLED, KilledError } from './exec.ts'
import { pathsFor, replay } from './replay.ts'
import { readLines, renderReport } from './report.ts'
import { rescoreFileCoverage } from './rescore.ts'

const HELP = `veyrum-bench - replay history and mutants to compare Veyrum with baseline selectors

Usage:
  veyrum-bench replay <corpus.json> [--bench <dir>] [--overhead-every <n>] [--commits <n>] [--until <sha>]
  veyrum-bench report <corpus.json> [--bench <dir>]
  veyrum-bench rescore <corpus.json> [--bench <dir>]   Recompute the Datadog-style baseline of a finished replay

Corpora live in bench/corpora. Work directories default to <repo>/.bench/<name>.
`

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_BENCH = path.resolve(here, '../../../.bench')

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      bench: { type: 'string' },
      'overhead-every': { type: 'string' },
      commits: { type: 'string' },
      until: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command, corpusFile] = positionals
  if (values.help || !command || !corpusFile) {
    process.stdout.write(HELP)
    return values.help ? 0 : 2
  }
  const loaded = loadCorpus(corpusFile)
  // A shorter or pinned range than the corpus declares (a quick validation, or a reproducible run).
  const corpus = {
    ...loaded,
    ...(values.commits ? { commits: Number(values.commits) } : {}),
    ...(values.until ? { until: values.until } : {}),
  }
  const bench = path.resolve(values.bench ?? DEFAULT_BENCH)
  const paths = pathsFor(corpus, bench)
  if (command === 'replay') {
    await replay(corpus, bench, { overheadEvery: Number(values['overhead-every'] ?? 5) })
    return 0
  }
  if (command === 'rescore') {
    const { commits, mutants } = rescoreFileCoverage(corpus, bench)
    process.stdout.write(`rescored ${commits} commits and ${mutants} mutants in ${paths.results}\n`)
    return 0
  }
  if (command === 'report') {
    const report = renderReport(`Replay: ${corpus.name}`, readLines(paths.results))
    const file = path.join(paths.work, 'report.md')
    fs.writeFileSync(file, report)
    process.stdout.write(`${report}\n\nwritten to ${file}\n`)
    return 0
  }
  process.stderr.write(HELP)
  return 2
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  // Killed from outside after every retry: exit so bench/replay.sh resumes the replay later.
  if (!(error instanceof KilledError)) throw error
  process.stderr.write(`${error.message}\n`)
  process.exitCode = EXIT_KILLED
}
