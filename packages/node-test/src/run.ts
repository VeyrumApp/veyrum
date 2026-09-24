import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
import { NODE_TEST_CAPTURE_ENV, type NodeTestCaptureConfig, type ReportedFile } from './protocol.ts'
import { createTransformer } from './transformer.ts'

export interface NodeTestRunOptions extends RunOptions {
  /** Test files run at once (node --test's --test-concurrency). */
  readonly maxWorkers?: number
}

const SCRIPT = String.raw`\.(c|m)?(j|t)s$`
/**
 * The files `node --test` runs when given none: its default patterns, and TypeScript files where
 * this Node strips types.
 */
const DEFAULT_TEST_FILE = new RegExp(
  [
    String.raw`(^|/)[^/]+[.\-_]test${SCRIPT}`,
    `(^|/)test-[^/]+${SCRIPT}`,
    `(^|/)test${SCRIPT}`,
    `(^|/)test/.+${SCRIPT}`,
  ].join('|'),
)
const TYPESCRIPT = /\.(c|m)?ts$/

export function discoverTests(files: readonly string[]): string[] {
  const strips = Boolean((process.features as { typescript?: unknown }).typescript)
  return files.filter(
    (f) => DEFAULT_TEST_FILE.test(f) && !/(^|\/)node_modules\//.test(f) && (strips || !TYPESCRIPT.test(f)),
  )
}

export async function runNodeTest(options: NodeTestRunOptions): Promise<RunResult> {
  const started = performance.now()
  const root = path.resolve(options.root)
  const runId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const scratch = path.join(root, '.veyrum', 'tmp', runId)
  const files = listRepoFiles(root)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const ignored = [...veyrumDirs(here), scratch + path.sep, ...storeFiles(options.store.file)]
  const facts = runtimeFacts({ runner: 'node-test' })
  const runtimeKey = runtimeKeyOf(facts)
  const recorder = new MainRecorder({ root, ignoredPrefixes: ignored, volatileEnv: VOLATILE_ENV })

  recorder.start()
  try {
    const specs = discoverTests(files).map((f) => ({
      check: { path: f, project: '' },
      file: path.join(root, f),
    }))
    const selectedSpecs = selectFiles(specs, (s) => s.check.path, options)
    const checks = selectedSpecs.map((s) => s.check)
    // Node reads the root manifest for every module under it (module format, imports).
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
    const reportFile = path.join(scratch, 'outcomes.json')
    let exitCode = 0
    if (selected.length > 0) {
      exitCode = await runTests(
        root,
        selected.map((s) => s.file),
        {
          root,
          outDir: scratch,
          ignored,
          preload: pathToFileURL(path.join(here, 'preload.js')).href,
        },
        reportFile,
        pathToFileURL(path.join(here, 'reporter.js')).href,
        options,
      )
    }
    const runMs = performance.now() - runStarted

    const reported = new Map<string, ReportedFile>()
    try {
      for (const r of JSON.parse(fs.readFileSync(reportFile, 'utf8')) as ReportedFile[])
        reported.set(path.resolve(r.file), r)
    } catch {
      // No report: node --test itself failed, and every file counts as failed below.
    }
    // A file with no tests reports nothing and passes, as it does for node --test; when the runner
    // failed without reporting anything, nothing passed.
    const noReport = reported.size === 0 && exitCode !== 0
    const ranOutcomes: CheckOutcome[] = selected.map((s) => {
      const r = reported.get(s.file)
      return {
        file: s.file,
        project: '',
        env: '',
        verdict: r?.verdict ?? (noReport ? 'fail' : 'pass'),
        tests: r?.tests ?? [],
        durationMs: r?.durationMs ?? 0,
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
          runner: { name: 'node-test', version: process.version, isolate: true, pool: 'process' },
          sharedWorkerProjects: new Set(),
          ignored,
          configFiles: [],
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

/**
 * Runs `node --test` on the files with the capture preload, reporting outcomes to a file (and the
 * spec reporter to the terminal when tests print). Resolves with its exit code.
 */
function runTests(
  root: string,
  testFiles: readonly string[],
  config: NodeTestCaptureConfig,
  reportFile: string,
  reporter: string,
  options: NodeTestRunOptions,
): Promise<number> {
  const args = [
    '--import',
    config.preload,
    '--test',
    ...(options.maxWorkers ? [`--test-concurrency=${options.maxWorkers}`] : []),
    `--test-reporter=${reporter}`,
    `--test-reporter-destination=${reportFile}`,
    ...(options.printTests ? ['--test-reporter=spec', '--test-reporter-destination=stdout'] : []),
    ...testFiles,
  ]
  // Veyrum's own process starts the runner: nothing of that is a test's input.
  return unobserved(
    () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          cwd: root,
          env: { ...process.env, [NODE_TEST_CAPTURE_ENV]: JSON.stringify(config) },
          stdio: options.printTests ? 'inherit' : 'ignore',
        })
        child.on('error', reject)
        child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
      }),
  )
}
