import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type MainObservations, MainRecorder, rawFs, unobserved, VOLATILE_ENV } from '@veyrum/capture'
import { assemble, type CheckOutcome } from '@veyrum/capture/assemble'
import { storeFiles, veyrumDirs } from '@veyrum/capture/host'
import {
  type CheckOutcomeSummary,
  type CheckRef,
  ConfigurationError,
  checkKey,
  type Decision,
  digest,
  type EvidenceRecord,
  FLAGS,
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
import { analyze, groupKey } from './analyze.ts'
import { loadPlaywrightCompiler, type PlaywrightCompiler } from './compile.ts'
import { LIST_ENV } from './lister.ts'
import {
  CONFIG_ENV,
  type ListedRun,
  type PlaywrightCaptureConfig,
  type ReportedFile,
  type ReportedRun,
  ROLE_ENV,
  SCRATCH,
} from './protocol.ts'
import { createTransformer } from './transformer.ts'

export interface PlaywrightRunOptions extends RunOptions {
  /** Playwright configuration file (--config). */
  readonly config?: string
  /** Worker processes (--workers). */
  readonly maxWorkers?: number
  /** Projects to run (--project), by name. */
  readonly projects?: readonly string[]
}

interface PlaywrightInstall {
  readonly version: string
  /** The CLI (`playwright test`). */
  readonly cli: string
  /** Digest of the browser builds this Playwright version installs and drives. */
  readonly browsers: string
  /** Directory of the `playwright` package that runs the tests (null if not found). */
  readonly playwright: string | null
}

/** The project's Playwright: @playwright/test, or the playwright package, which carries the same runner. */
export function resolvePlaywright(root: string): PlaywrightInstall {
  const require = createRequire(path.join(root, 'package.json'))
  for (const name of ['@playwright/test', 'playwright']) {
    let manifest: string
    try {
      manifest = require.resolve(`${name}/package.json`)
    } catch {
      continue
    }
    const version = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string }).version
    const cli = path.join(path.dirname(manifest), 'cli.js')
    let browsers = ''
    let playwright: string | null = null
    try {
      const local = createRequire(manifest)
      playwright = path.dirname(name === 'playwright' ? manifest : local.resolve('playwright/package.json'))
      const core = createRequire(path.join(playwright, 'package.json')).resolve(
        'playwright-core/package.json',
      )
      browsers = digest(fs.readFileSync(path.join(path.dirname(core), 'browsers.json')))
    } catch {
      // Older layouts: the version decides the browser builds.
    }
    return { version, cli, browsers, playwright }
  }
  throw new ConfigurationError(
    `Playwright is not installed in ${root} (install @playwright/test, or pass --runner for another runner)`,
  )
}

/** Runs Playwright in a child process that Veyrum's own capture does not observe. */
function runPlaywrightCli(
  root: string,
  cli: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  print: boolean,
): Promise<number> {
  return unobserved(
    () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...args], {
          cwd: root,
          env,
          stdio: print ? 'inherit' : 'ignore',
        })
        child.on('error', reject)
        child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
      }),
  )
}

/** A regular expression matching exactly this file, as Playwright's CLI takes file filters. */
function exactFile(file: string): string {
  return `/^${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$/`
}

/** The test files of every project, as Playwright lists them. */
async function listTests(
  root: string,
  install: PlaywrightInstall,
  scratch: string,
  options: PlaywrightRunOptions,
): Promise<ListedRun> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const out = path.join(scratch, SCRATCH.list)
  const args = [
    'test',
    '--list',
    `--reporter=${path.join(here, 'lister.js')}`,
    ...(options.config ? [`--config=${options.config}`] : []),
    // --project takes several values: the = form keeps it from taking the file filters.
    ...(options.projects ?? []).map((p) => `--project=${p}`),
  ]
  const env = { ...process.env, [LIST_ENV]: out }
  const code = await runPlaywrightCli(root, install.cli, args, env, false)
  let listed: ListedRun
  try {
    listed = JSON.parse(fs.readFileSync(out, 'utf8')) as ListedRun
  } catch {
    throw new Error(`playwright test --list failed (exit code ${code})`)
  }
  if (listed.errors.length > 0) throw new Error(`playwright test --list failed: ${listed.errors[0]}`)
  return listed
}

/** The file's verdict: it fails when a test failed, or did not run although the run did not pass. */
function verdictOf(
  file: ReportedFile | undefined,
  run: ReportedRun | null,
  exitCode: number,
): 'pass' | 'fail' {
  if (!file) return exitCode === 0 && run !== null ? 'pass' : 'fail'
  if (file.tests.some((t) => t.outcome === 'unexpected')) return 'fail'
  if (exitCode !== 0 && file.tests.some((t) => t.outcome === 'notrun')) return 'fail'
  // A run that failed outside any test (a failing global setup or webServer) is no evidence.
  if (run === null || run.errors > 0) return 'fail'
  // Tests skipped only because a project they depend on failed.
  if (exitCode !== 0 && file.tests.length > 0 && file.tests.every((t) => t.state === 'skipped')) return 'fail'
  return 'pass'
}

export async function runPlaywright(options: PlaywrightRunOptions): Promise<RunResult> {
  const started = performance.now()
  const root = path.resolve(options.root)
  const runId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const scratch = path.join(root, '.veyrum', 'tmp', runId)
  const files = listRepoFiles(root)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const ignored = [...veyrumDirs(here), scratch + path.sep, ...storeFiles(options.store.file)]
  const install = resolvePlaywright(root)
  const facts = runtimeFacts({
    runner: 'playwright',
    playwright: install.version,
    browsers: install.browsers,
  })
  const runtimeKey = runtimeKeyOf(facts)
  // Playwright's own transform, loaded only when a module must be compiled again.
  let compiler: PlaywrightCompiler | null | undefined
  const playwrightCompiler = (): PlaywrightCompiler | null => {
    if (compiler === undefined) compiler = loadPlaywrightCompiler(install.playwright)
    return compiler
  }
  const recorder = new MainRecorder({ root, ignoredPrefixes: ignored, volatileEnv: VOLATILE_ENV })

  recorder.start()
  try {
    fs.mkdirSync(scratch, { recursive: true })
    const listed = await listTests(root, install, scratch, options)
    const specs = listed.tests
      .filter((t) => isInsideRoot(root, t.file))
      .map((t) => ({
        check: { path: toRepoPath(root, t.file), project: t.project },
        file: t.file,
        projectId: t.projectId,
      }))
      .sort((a, b) => checkKey(a.check).localeCompare(checkKey(b.check)))
    const selectedSpecs = selectFiles(specs, (s) => s.check.path, options)
    const checks = selectedSpecs.map((s) => s.check)
    const configFiles = listed.configFile ? [listed.configFile] : []
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
        transformer: createTransformer(root, playwrightCompiler),
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
    fs.writeFileSync(
      path.join(scratch, SCRATCH.uncaptured),
      JSON.stringify(selected.filter((s) => !captured(s.check)).map((s) => `${s.projectId}\u0000${s.file}`)),
    )
    const veyrumMain = recorder.stop()

    const runStarted = performance.now()
    let exitCode = 0
    if (selected.length > 0) {
      const config: PlaywrightCaptureConfig = { root, scratch, ignored }
      const preload = pathToFileURL(path.join(here, 'preload.js')).href
      const reporter = path.join(here, 'reporter.js')
      const projects = [...new Set(selected.map((s) => s.check.project))]
      const args = [
        'test',
        `--reporter=${options.printTests ? `list,${reporter}` : reporter}`,
        ...(options.config ? [`--config=${options.config}`] : []),
        ...(options.maxWorkers ? [`--workers=${options.maxWorkers}`] : []),
        ...projects.map((p) => `--project=${p}`),
        ...[...new Set(selected.map((s) => s.file))].map(exactFile),
      ]
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_OPTIONS: [`--import=${preload}`, process.env.NODE_OPTIONS ?? ''].join(' ').trim(),
        [CONFIG_ENV]: JSON.stringify(config),
        [ROLE_ENV]: 'main',
      }
      exitCode = await runPlaywrightCli(root, install.cli, args, env, options.printTests === true)
    }
    const runMs = performance.now() - runStarted

    let reportedRun: ReportedRun | null = null
    try {
      reportedRun = JSON.parse(fs.readFileSync(path.join(scratch, SCRATCH.outcomes), 'utf8')) as ReportedRun
    } catch {
      // No report: Playwright itself failed, and every file counts as failed.
    }
    const reported = new Map<string, ReportedFile>()
    for (const r of reportedRun?.files ?? []) reported.set(`${r.project}\u0000${path.resolve(r.file)}`, r)
    const ranOutcomes = selected.map((s) => {
      const r = reported.get(`${s.check.project}\u0000${path.resolve(s.file)}`)
      const verdict = selected.length > 0 ? verdictOf(r, reportedRun, exitCode) : 'pass'
      const outcome: CheckOutcome = {
        file: s.file,
        project: s.check.project,
        env: '',
        verdict,
        tests: (r?.tests ?? []).map(({ outcome: _, ...t }) => t),
        durationMs: r?.durationMs ?? 0,
        retries: Math.max(0, ...(r?.tests ?? []).map((t) => t.retries)),
      }
      return { spec: s, outcome }
    })
    const outcomes: CheckOutcomeSummary[] = ranOutcomes.map(({ spec, outcome }) => ({
      check: spec.check,
      verdict: outcome.verdict,
      durationMs: outcome.durationMs,
      captured: captured(spec.check),
    }))

    const recordStarted = performance.now()
    const recording = recordEvidence(options.strict, () => {
      const analysis = analyze({
        root,
        scratch,
        ignored,
        testFiles: new Set(specs.map((s) => path.resolve(s.file))),
        compiler: playwrightCompiler,
      })
      const main = mergeMain(veyrumMain, analysis.main)
      const common = {
        root,
        runId,
        runtimeKey,
        runtime: facts,
        revision: options.revision ?? null,
        createdAt,
        main,
        files,
        store: options.store,
        fs: rawFs,
        runner: { name: 'playwright', version: install.version, isolate: true, pool: 'process' },
        sharedWorkerProjects: new Set<string>(),
        ignored,
        configFiles,
        manifestFiles,
      }
      const blobs = path.join(scratch, SCRATCH.capture, 'blobs')
      // assemble reads one payload per test file: each project is assembled on its own.
      const layout = (name: string, keys: readonly string[]): string => {
        const dir = path.join(scratch, 'assemble', name)
        fs.mkdirSync(path.join(dir, 'payloads'), { recursive: true })
        if (fs.existsSync(blobs)) fs.symlinkSync(blobs, path.join(dir, 'blobs'), 'junction')
        keys.forEach((key, i) => {
          const payload = analysis.payloads.get(key)
          if (payload) fs.writeFileSync(path.join(dir, 'payloads', `${i}.json`), JSON.stringify(payload))
        })
        return dir
      }
      const toRecord = ranOutcomes.filter(({ spec }) => captured(spec.check))
      const byProject = new Map<string, typeof toRecord>()
      for (const entry of toRecord)
        byProject.set(entry.spec.projectId, [...(byProject.get(entry.spec.projectId) ?? []), entry])
      const records: EvidenceRecord[] = []
      let index = 0
      for (const [projectId, entries] of byProject) {
        const dir = layout(
          String(index++),
          entries.map(({ spec }) => groupKey(projectId, spec.file)),
        )
        const { records: assembled } = options.store.transaction(() =>
          assemble({ ...common, outDir: dir, outcomes: entries.map((e) => e.outcome) }),
        )
        for (const record of assembled) {
          const entry = entries.find((e) => toRepoPath(root, e.spec.file) === record.check)
          const extra = entry ? analysis.flags.get(groupKey(projectId, entry.spec.file)) : undefined
          records.push(withFlags(record, extra))
        }
      }
      // The run's shared inputs and injected environment, from every payload.
      const all = layout('run', [...analysis.payloads.keys()])
      const { run } = options.store.transaction(() => assemble({ ...common, outDir: all, outcomes: [] }))
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
      exitCode !== 0 ||
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

function isInsideRoot(root: string, file: string): boolean {
  const rel = path.relative(root, file)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Veyrum's own reads with those of Playwright's main process (null when it wrote none). */
function mergeMain(own: MainObservations, playwright: MainObservations | null): MainObservations {
  if (!playwright) return { ...own, loadsObserved: false }
  return {
    paths: [...own.paths, ...playwright.paths],
    env: [...own.env, ...playwright.env.filter((e) => !own.env.some((o) => o.n === e.n))],
    envBaseline: own.envBaseline,
    loadedPackages: [...new Set([...own.loadedPackages, ...playwright.loadedPackages])],
    loadedFiles: [...new Set([...own.loadedFiles, ...playwright.loadedFiles])],
    loadsObserved: own.loadsObserved && playwright.loadsObserved,
  }
}

/** Adds the flags a payload cannot carry: browsers and servers Veyrum could not observe. */
function withFlags(
  record: EvidenceRecord,
  extra: { browser: string[]; server: string[] } | undefined,
): EvidenceRecord {
  if (!extra || (extra.browser.length === 0 && extra.server.length === 0)) return record
  const flags = new Set(record.flags)
  if (extra.browser.length > 0) flags.add(FLAGS.browserUnobserved)
  if (extra.server.length > 0) flags.add(FLAGS.serverUnobserved)
  return {
    ...record,
    flags: [...flags].sort(),
    channels: {
      ...record.channels,
      ...(extra.browser.length > 0 ? { browser: [...extra.browser].sort().slice(0, 20) } : {}),
      ...(extra.server.length > 0 ? { server: [...extra.server].sort().slice(0, 20) } : {}),
    },
  }
}
