import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MainRecorder, rawFs, unobserved, VOLATILE_ENV } from '@veyrum/capture'
import { assemble, type CheckOutcome } from '@veyrum/capture/assemble'
import { storeFiles, veyrumDirs } from '@veyrum/capture/host'
import { UNCAPTURED_FILE } from '@veyrum/capture/worker'
import {
  type CheckOutcomeSummary,
  type CheckRef,
  checkKey,
  type Decision,
  forcedDecisions,
  listRepoFiles,
  needsPlan,
  plan,
  type RunOptions,
  type RunResult,
  recordEvidence,
  recordUncapturedFailures,
  recordVerifications,
  runtimeFacts,
  runtimeKeyOf,
  selectExecution,
  selectFiles,
  toRepoPath,
} from '@veyrum/core'
import {
  inDirectory,
  loadMochaOptions,
  mochaModule,
  resolveTargetMocha,
  specFiles,
  splitNodeFlags,
} from './mocha.ts'
import { MOCHA_CHILD_ENV, type MochaChildConfig, type ReportedFile } from './protocol.ts'
import { createTransformer } from './transformer.ts'

export interface MochaRunOptions extends RunOptions {
  /** Mocha config file (Mocha's --config); by default Mocha finds .mocharc.* itself. */
  readonly config?: string
  /** Test files run at once, each in its own process (default: available parallelism - 1). */
  readonly maxWorkers?: number
}

/** Mocha's configuration files, which it looks for in the working directory. */
const MOCHA_CONFIG = /^\.mocharc\.(c?js|mjs|jsonc?|ya?ml)$/

/**
 * The test files Mocha runs in this project: its spec patterns, extensions, recursion and ignore
 * rules from the project's configuration, with Mocha's own loader and file lookup. Also the Node
 * flags Mocha's executable would start its process with.
 */
export function discoverTests(root: string, config?: string): { files: string[]; nodeArgv: string[] } {
  const target = resolveTargetMocha(root)
  const argv = config ? ['--config', path.resolve(root, config)] : []
  return inDirectory(root, () => {
    // Each file's process loads these before capture begins: loaded here, under the main process's
    // recorder, the packages they come from are shared inputs.
    mochaModule(target.dir, 'lib/mocha.js')
    mochaModule(target.dir, 'lib/cli/cli.js')
    const loaded = loadMochaOptions(target.dir, argv)
    const inside = specFiles(target.dir, loaded).filter((f) => {
      const rel = path.relative(root, f)
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
    })
    return { files: inside, nodeArgv: splitNodeFlags(target.dir, loaded).nodeArgv }
  })
}

export async function runMocha(options: MochaRunOptions): Promise<RunResult> {
  const started = performance.now()
  const root = path.resolve(options.root)
  const runId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const scratch = path.join(root, '.veyrum', 'tmp', runId)
  const files = listRepoFiles(root)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const ignored = [...veyrumDirs(here), scratch + path.sep, ...storeFiles(options.store.file)]
  const target = resolveTargetMocha(root)
  const facts = runtimeFacts({ runner: 'mocha', mocha: target.version })
  const runtimeKey = runtimeKeyOf(facts)
  const recorder = new MainRecorder({ root, ignoredPrefixes: ignored, volatileEnv: VOLATILE_ENV })

  recorder.start()
  try {
    // Discovery is not an input of any file: each file's process reads the configuration itself.
    const argv = options.config ? ['--config', path.resolve(root, options.config)] : []
    const discovered = unobserved(() => discoverTests(root, options.config))
    const specs = discovered.files
      .map((file) => ({ check: { path: toRepoPath(root, file), project: '' }, file }))
      .sort((a, b) => a.check.path.localeCompare(b.check.path))
    const selectedSpecs = selectFiles(specs, (s) => s.check.path, options)
    const checks = selectedSpecs.map((s) => s.check)
    const configFiles = files.filter((f) => MOCHA_CONFIG.test(f)).map((f) => path.join(root, f))
    if (options.config) configFiles.push(path.resolve(root, options.config))
    // The root manifest holds Mocha's "mocha" configuration and Node's module format.
    const manifestFiles = [path.join(root, 'package.json')]

    const planStarted = performance.now()
    let decisions: Decision[]
    if (!needsPlan(options)) {
      decisions = forcedDecisions(checks)
    } else {
      decisions = await plan({
        root,
        store: options.store,
        checks,
        runtimeKey,
        transformer: createTransformer(root),
        files,
        fs: rawFs,
        env: recorder.initialEnv as NodeJS.ProcessEnv,
        ...(options.policy ? { policy: options.policy } : {}),
      })
    }
    const planMs = performance.now() - planStarted
    if (options.mode === 'plan') {
      return {
        runId,
        runtimeKey,
        decisions,
        records: [],
        ran: [],
        outcomes: [],
        verifications: [],
        ok: true,
        timings: { planMs, runMs: 0, recordMs: 0, totalMs: performance.now() - started },
      }
    }

    const execution = selectExecution(checks, decisions, options, runId)
    const selected = selectedSpecs.filter((s) => execution.toRun.has(checkKey(s.check)))
    const captured = (check: CheckRef): boolean => execution.capture.has(checkKey(check))
    fs.mkdirSync(scratch, { recursive: true })
    fs.writeFileSync(
      path.join(scratch, UNCAPTURED_FILE),
      JSON.stringify(selected.filter((s) => !captured(s.check)).map((s) => s.file)),
    )
    const main = recorder.stop()

    const runStarted = performance.now()
    const concurrency = Math.max(1, options.maxWorkers ?? os.availableParallelism() - 1)
    const results = await runFiles(
      selected.map((s, i) => ({
        root,
        outDir: scratch,
        ignored,
        mochaDir: target.dir,
        argv,
        file: s.file,
        reportFile: path.join(scratch, `outcome-${i}.json`),
        print: Boolean(options.printTests),
        color: Boolean(process.stdout.isTTY),
      })),
      discovered.nodeArgv,
      path.join(here, 'child.js'),
      concurrency,
    )
    const runMs = performance.now() - runStarted

    const ranOutcomes: CheckOutcome[] = selected.map((s, i) => {
      const r = results[i]
      // A file passes only when its run ended with a passing report and its process succeeded.
      const verdict = r?.report?.verdict === 'pass' && r.exitCode === 0 ? 'pass' : 'fail'
      return {
        file: s.file,
        project: '',
        env: '',
        verdict,
        tests: r?.report?.tests ?? [],
        durationMs: r?.report?.durationMs ?? 0,
        retries: 0,
      }
    })
    const outcomes: CheckOutcomeSummary[] = ranOutcomes.map((o) => {
      const check = { path: toRepoPath(root, o.file), project: '' }
      return { check, verdict: o.verdict, durationMs: o.durationMs, captured: captured(check) }
    })

    const recordStarted = performance.now()
    const recording = recordEvidence(options.strict, () => {
      const { run, records } = options.store.transaction(() =>
        assemble({
          root,
          runId,
          runtimeKey,
          runtime: facts,
          revision: options.revision ?? null,
          createdAt,
          outDir: scratch,
          outcomes: ranOutcomes.filter((o) => captured({ path: toRepoPath(root, o.file), project: '' })),
          main,
          files,
          store: options.store,
          fs: rawFs,
          runner: { name: 'mocha', version: target.version, isolate: true, pool: 'process' },
          sharedWorkerProjects: new Set(),
          ignored,
          configFiles,
          manifestFiles,
        }),
      )
      options.store.transaction(() => {
        options.store.putRun(run)
        for (const record of records) options.store.putRecord(record)
      })
      recordUncapturedFailures(options.store, runId, options.revision ?? null, decisions, outcomes)
      return { records, verifications: recordVerifications(options.store, runId, execution, outcomes) }
    })
    const { records, verifications } = recording
    const recordMs = performance.now() - recordStarted
    const failed =
      outcomes.some((o) => o.verdict === 'fail') ||
      (recording.recorded && records.some((r) => r.verdict === 'fail'))
    return {
      runId,
      runtimeKey,
      decisions,
      records,
      ran: selected.map((s) => s.check),
      outcomes,
      verifications,
      ok: !failed,
      timings: { planMs, runMs, recordMs, totalMs: performance.now() - started },
    }
  } finally {
    recorder.stop()
    if (!options.keepScratch) fs.rmSync(scratch, { recursive: true, force: true })
  }
}

interface FileResult {
  readonly exitCode: number
  readonly report: ReportedFile | null
}

/**
 * Runs each test file in its own process, `concurrency` at once. When tests print, each process's
 * output is shown as one block once it ends, so concurrent files do not interleave.
 */
async function runFiles(
  configs: readonly MochaChildConfig[],
  nodeArgv: readonly string[],
  child: string,
  concurrency: number,
): Promise<FileResult[]> {
  const results: FileResult[] = new Array(configs.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < configs.length) {
      const index = next++
      const config = configs[index] as MochaChildConfig
      const exitCode = await runFile(config, nodeArgv, child)
      let report: ReportedFile | null = null
      try {
        report = JSON.parse(fs.readFileSync(config.reportFile, 'utf8')) as ReportedFile
      } catch {
        // No report: the run did not end (a load error, or the process exited early).
      }
      results[index] = { exitCode, report }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, configs.length) }, worker))
  return results
}

/** Runs one test file's process and resolves with its exit code. */
function runFile(config: MochaChildConfig, nodeArgv: readonly string[], child: string): Promise<number> {
  // Veyrum's own process starts the runner: nothing of that is a test's input.
  return unobserved(
    () =>
      new Promise<number>((resolve, reject) => {
        const proc = spawn(process.execPath, [...nodeArgv, child], {
          cwd: config.root,
          env: { ...process.env, [MOCHA_CHILD_ENV]: JSON.stringify(config) },
          stdio: config.print ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        })
        const output: { stream: NodeJS.WriteStream; chunk: Buffer }[] = []
        proc.stdout?.on('data', (chunk: Buffer) => output.push({ stream: process.stdout, chunk }))
        proc.stderr?.on('data', (chunk: Buffer) => output.push({ stream: process.stderr, chunk }))
        proc.on('error', reject)
        proc.on('close', (code, signal) => {
          for (const { stream, chunk } of output) stream.write(chunk)
          resolve(code ?? (signal ? 1 : 0))
        })
      }),
  )
}
