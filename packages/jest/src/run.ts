import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MainRecorder, rawFs, VOLATILE_ENV } from '@veyrum/capture'
import { assemble } from '@veyrum/capture/assemble'
import { packageJsonAbove, storeFiles, veyrumDirs } from '@veyrum/capture/host'
import { endWorkerCapture, UNCAPTURED_FILE } from '@veyrum/capture/worker'
import {
  type CheckOutcomeSummary,
  type CheckRef,
  checkKey,
  type Decision,
  digest,
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
import { JEST_CAPTURE_ENV, type JestCaptureConfig } from './protocol.ts'
import { closeSession, openSession } from './reporter.ts'
import { createTransformer, type ProjectConfigLike } from './transformer.ts'

export interface JestRunOptions extends RunOptions {
  /** Path to the Jest config file (defaults to Jest's own lookup from the root). */
  readonly config?: string
  readonly maxWorkers?: number
  /** Restrict to these Jest projects (by display name), like `--selectProjects`. */
  readonly projects?: readonly string[]
}

/** The target project's own Jest install (never Veyrum's), as absolute module paths. */
export interface TargetJest {
  readonly version: string
  readonly major: number
  readonly core: string
  readonly config: string
  readonly runtime: string
  readonly transform: string
  readonly resolve: string
  readonly hasteMap: string
  /** jest-resolve as jest-runtime loads it: the resolver test files resolve through. */
  readonly runtimeResolve: string
  /** jest-resolve as jest-runner loads it: the one that resolves each file's test environment. */
  readonly runnerResolve: string
}

export function resolveTargetJest(root: string): TargetJest {
  const fromRoot = createRequire(path.join(root, 'package.json'))
  let core: string | null = null
  let version = ''
  for (const entry of ['jest', 'jest-cli', '@jest/core']) {
    let resolved: string
    try {
      resolved = fromRoot.resolve(entry)
    } catch {
      continue
    }
    const pkg = packageJsonAbove(resolved, entry)
    if (!pkg) continue
    version = pkg.version
    core =
      entry === '@jest/core'
        ? resolved
        : createRequire(path.join(pkg.dir, 'package.json')).resolve('@jest/core')
    if (entry !== 'jest') {
      version = packageJsonAbove(core, '@jest/core')?.version ?? version
    }
    break
  }
  if (!core) throw new Error(`Cannot find Jest installed in ${root}`)
  const fromCore = createRequire(core)
  const runtime = fromCore.resolve('jest-runtime')
  return {
    version,
    major: Number(version.split('.')[0]) || 0,
    core,
    config: fromCore.resolve('jest-config'),
    runtime,
    transform: fromCore.resolve('@jest/transform'),
    resolve: fromCore.resolve('jest-resolve'),
    hasteMap: createRequire(runtime).resolve('jest-haste-map'),
    runtimeResolve: createRequire(runtime).resolve('jest-resolve'),
    runnerResolve: createRequire(fromCore.resolve('jest-runner')).resolve('jest-resolve'),
  }
}

/** The subset of Jest's normalized project config Veyrum reads. */
interface ProjectConfig extends ProjectConfigLike {
  readonly rootDir: string
  readonly displayName?: { name: string }
  readonly testEnvironment: string
  readonly cacheDirectory: string
}

interface GlobalConfig {
  readonly maxWorkers: number
  readonly watchman: boolean
  readonly testSequencer: string
}

const processHolder = process as unknown as Record<symbol, unknown>
/** Where Veyrum's readers find the run's configuration (see takeConfig in environment.cts). */
const CONFIG_KEY = Symbol.for(`veyrum.config.${JEST_CAPTURE_ENV}`)
const MAIN_KEY = Symbol.for('veyrum.main')

/**
 * A file each worker loads first (--require): it sets the run's configuration where Veyrum's
 * readers look, then removes its own flag, so tests and the processes they fork see the
 * execArgv they would without Veyrum.
 */
function workerConfigSource(raw: string): string {
  return [
    `process[Symbol.for(${JSON.stringify(`veyrum.config.${JEST_CAPTURE_ENV}`)})] = ${JSON.stringify(raw)}`,
    `if (!process[Symbol.for('veyrum.main')]) {`,
    `  const at = process.execArgv.indexOf(__filename)`,
    `  if (at > 0 && process.execArgv[at - 1] === '--require') process.execArgv.splice(at - 1, 2)`,
    `}`,
    '',
  ].join('\n')
}

/** Jest's stock sequencer, which Veyrum's wraps; a project's own sequencer is left in place. */
const STOCK_SEQUENCER = /[\\/]@jest[\\/]test-sequencer[\\/]build[\\/]index\.js$/

interface JestApis {
  readConfigs(
    argv: object,
    projectPaths: string[],
  ): Promise<{ globalConfig: GlobalConfig; configs: ProjectConfig[] }>
  runCLI(argv: object, projects: string[]): Promise<{ results: { runExecError?: unknown } }>
  SearchSource: new (
    context: unknown,
  ) => {
    getTestPaths(...args: unknown[]): Promise<{ tests: { path: string }[] }>
  }
  createContext(config: ProjectConfig, options: object): Promise<unknown>
  createScriptTransformer(config: unknown): Promise<never>
  shouldLoadAsEsm(file: string, extensionsToTreatAsEsm: readonly string[]): boolean
  HasteMap: { prototype: { build(...args: unknown[]): Promise<unknown> } }
}

function loadApis(target: TargetJest): JestApis {
  const load = createRequire(import.meta.url)
  const core = load(target.core) as {
    runCLI: JestApis['runCLI']
    SearchSource: JestApis['SearchSource']
  }
  const config = load(target.config) as { readConfigs: JestApis['readConfigs'] }
  const runtime = load(target.runtime) as {
    default: { createContext: JestApis['createContext'] }
  }
  const transform = load(target.transform) as { createScriptTransformer: JestApis['createScriptTransformer'] }
  const resolver = load(target.resolve) as {
    default: { unstable_shouldLoadAsEsm?: (file: string, exts: readonly string[]) => boolean }
  }
  const hasteMap = load(target.hasteMap) as { default: JestApis['HasteMap'] }
  const Runtime = runtime.default
  const shouldLoadAsEsm = resolver.default.unstable_shouldLoadAsEsm
  return {
    readConfigs: config.readConfigs,
    runCLI: core.runCLI,
    SearchSource: core.SearchSource,
    createContext: (c, o) => Runtime.createContext(c, o),
    createScriptTransformer: transform.createScriptTransformer,
    shouldLoadAsEsm: (file, exts) =>
      shouldLoadAsEsm ? shouldLoadAsEsm.call(resolver.default, file, exts) : false,
    HasteMap: hasteMap.default,
  }
}

/**
 * Jest's haste map reads every file in the repository to index it. Those reads are not inputs of
 * any check, so the main-process recorder is paused while a haste map builds.
 */
function pauseDuringHasteMapBuilds(api: JestApis, recorder: MainRecorder): () => void {
  const proto = api.HasteMap.prototype
  const original = proto.build
  proto.build = async function (this: unknown, ...args: unknown[]) {
    const resume = recorder.pause()
    try {
      return await original.apply(this, args)
    } finally {
      resume()
    }
  }
  return () => {
    proto.build = original
  }
}

/** Configuration files every check depends on, read by transformers inside Jest's workers. */
const TOOLCHAIN_CONFIG =
  /(^|\/)(babel\.config\.[^/]+|\.babelrc(\.[^/]+)?|\.swcrc|\.browserslistrc|browserslist|(tsconfig|jsconfig)[^/]*\.json|jest\.config\.[^/]+|jest-preset\.[^/]+)$/

function projectNames(configs: readonly ProjectConfig[], root: string): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const config of configs) {
    let name = config.displayName?.name ?? (configs.length > 1 ? toRepoPath(root, config.rootDir) || '.' : '')
    for (let i = 2; used.has(name); i++) name = `${config.displayName?.name ?? 'project'}#${i}`
    used.add(name)
    out.set(config.id, name)
  }
  return out
}

export async function runJest(options: JestRunOptions): Promise<RunResult> {
  const started = performance.now()
  const root = path.resolve(options.root)
  const runId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const scratch = path.join(root, '.veyrum', 'tmp', runId)
  const files = listRepoFiles(root)
  const target = resolveTargetJest(root)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const ignored = [...veyrumDirs(here), scratch + path.sep, ...storeFiles(options.store.file)]
  const ownRequire = createRequire(import.meta.url)

  // The wrapper lives under a node_modules directory so no project transform applies to it, at a
  // path that depends only on its content: the path is part of the project config, which Jest's
  // transformers put in their cache keys, so a per-run path would defeat the transform cache.
  const source = (name: string): string =>
    fs.readFileSync(path.join(here, name), 'utf8').replace(/\n\/\/# sourceMappingURL=.*$/m, '\n')
  const environmentSource = source('environment.cjs')
  const sequencerSource = source('sequencer.cjs')
  const environmentDir = path.join(
    root,
    '.veyrum',
    'jest',
    digest(`${environmentSource}\u0000${sequencerSource}`),
    'node_modules',
  )
  const environmentPath = path.join(environmentDir, 'veyrum-environment.cjs')
  const sequencerPath = path.join(environmentDir, 'veyrum-sequencer.cjs')
  for (const [file, content] of [
    [environmentPath, environmentSource],
    [sequencerPath, sequencerSource],
  ] as const) {
    if (fs.existsSync(file)) continue
    fs.mkdirSync(environmentDir, { recursive: true })
    const temporary = `${file}.${runId}`
    fs.writeFileSync(temporary, content)
    fs.renameSync(temporary, file)
  }
  ignored.push(path.dirname(environmentDir) + path.sep)
  const reporterPath = path.join(here, 'reporter.js')

  const recorder = new MainRecorder({ root, ignoredPrefixes: ignored, volatileEnv: VOLATILE_ENV })
  const configFile = path.join(scratch, 'config.cjs')
  // Readers in this process leave its execArgv alone: workers inherit it.
  processHolder[MAIN_KEY] = true
  const previousNodeEnv = process.env.NODE_ENV
  const facts = runtimeFacts({ runner: 'jest', jest: target.version })
  const runtimeKey = runtimeKeyOf(facts)

  recorder.start()
  const api = loadApis(target)
  const restoreHasteMap = pauseDuringHasteMapBuilds(api, recorder)
  try {
    // As the jest binary does before anything else.
    if (process.env.NODE_ENV === undefined) process.env.NODE_ENV = 'test'
    const baseArgv = {
      $0: 'veyrum',
      _: [] as string[],
      ...(options.config ? { config: options.config } : {}),
      ...(options.maxWorkers ? { maxWorkers: options.maxWorkers } : {}),
      ...(options.projects?.length ? { selectProjects: [...options.projects] } : {}),
      // Planning runs nothing, and coverage reporting would write an empty report.
      ...(options.mode === 'plan' ? { collectCoverage: false } : {}),
      ...(options.mode !== 'plan' && options.coverage !== undefined
        ? { collectCoverage: options.coverage }
        : {}),
      passWithNoTests: true,
      silent: !options.printTests,
    }
    const { globalConfig, configs: allConfigs } = await api.readConfigs(baseArgv, [root])
    const { collectCoverage, coverageProvider } = globalConfig as unknown as {
      collectCoverage?: boolean
      coverageProvider?: string
    }
    // Babel coverage instruments the code that runs, which fingerprints see through (see
    // fingerprint.ts); V8 coverage shares the profiler with capture (see WorkerCaptureOptions).
    const v8Coverage = collectCoverage === true && coverageProvider === 'v8'
    const names = projectNames(allConfigs, root)
    const configs = options.projects?.length
      ? allConfigs.filter((c) => options.projects!.includes(c.displayName?.name ?? ''))
      : allConfigs
    const environments: Record<string, string> = {}
    for (const config of allConfigs) {
      environments[config.id] = config.testEnvironment
      // Transform caches inside the repository are the runner's own outputs.
      if (config.cacheDirectory) ignored.push(path.resolve(config.cacheDirectory) + path.sep)
    }
    const captureConfig: JestCaptureConfig = {
      root,
      outDir: scratch,
      ignored,
      captureIndex: ownRequire.resolve('@veyrum/capture'),
      captureWorker: ownRequire.resolve('@veyrum/capture/worker'),
      resolver: target.runtimeResolve,
      environmentResolver: target.runnerResolve,
      environmentPath,
      preload: path.join(here, 'preload.cjs'),
      environments,
      ...(v8Coverage ? { projectCoverage: true } : {}),
      sequencer: globalConfig.testSequencer,
    }
    // The configuration reaches workers through a file they load first, never through the
    // environment tests see; this process keeps it where its own readers look.
    const configRaw = JSON.stringify(captureConfig)
    fs.mkdirSync(scratch, { recursive: true })
    fs.writeFileSync(configFile, workerConfigSource(configRaw))
    processHolder[CONFIG_KEY] = configRaw

    // Discovery, per project, with Jest's own search.
    const specs: { check: CheckRef; file: string }[] = []
    const configsByProject = new Map<string, ProjectConfig>()
    for (const config of configs) {
      const project = names.get(config.id) ?? ''
      configsByProject.set(project, config)
      const context = await api.createContext(config, {
        maxWorkers: globalConfig.maxWorkers,
        watchman: globalConfig.watchman,
      })
      const search = new api.SearchSource(context)
      const { tests } =
        target.major >= 30
          ? await search.getTestPaths(globalConfig, config)
          : await search.getTestPaths(globalConfig)
      for (const test of tests)
        specs.push({ check: { path: toRepoPath(root, test.path), project }, file: test.path })
    }
    const selectedSpecs = selectFiles(specs, (s) => s.check.path, options)
    const checks = selectedSpecs.map((s) => s.check)

    const configFiles = new Set<string>()
    for (const f of files) if (TOOLCHAIN_CONFIG.test(f)) configFiles.add(path.join(root, f))
    // The root manifest can hold Jest, Babel and Browserslist configuration.
    const manifestFiles = [path.join(root, 'package.json')]
    if (options.config) configFiles.add(path.resolve(root, options.config))

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
        transformer: createTransformer(api, configsByProject, root),
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
    const runStarted = performance.now()
    const session = openSession(names)
    let runError = false
    if (selected.length > 0) {
      // Workers inherit this process's execArgv: the preload reaches every worker before its first
      // test (docblock environments), and loading it here covers tests run in band.
      const preload = captureConfig.preload
      ownRequire(preload)
      const execArgv = [...process.execArgv]
      process.execArgv.push('--require', configFile, '--require', preload)
      let results: { runExecError?: unknown }
      try {
        ;({ results } = await api.runCLI(
          {
            ...baseArgv,
            _: [...new Set(selected.map((s) => s.file))],
            runTestsByPath: true,
            testEnvironment: environmentPath,
            ...(STOCK_SEQUENCER.test(globalConfig.testSequencer) ? { testSequencer: sequencerPath } : {}),
            reporters: options.printTests ? ['default', reporterPath] : [reporterPath],
          },
          [root],
        ))
      } finally {
        process.execArgv.splice(0, process.execArgv.length, ...execArgv)
      }
      runError = results.runExecError != null
      // Files that ran in band left a coverage session open in this process.
      await endWorkerCapture()
    }
    const runMs = performance.now() - runStarted
    const main = recorder.stop()

    const recordStarted = performance.now()
    // Jest runs every file of a multi-project config in each project whose patterns match it;
    // only outcomes for checks that were discovered for that project become records.
    const known = new Set(specs.map((s) => checkKey(s.check)))
    const ranOutcomes = [...session.outcomes.values()].filter((o) =>
      known.has(checkKey({ path: toRepoPath(root, o.file), project: o.project })),
    )
    const outcomes: CheckOutcomeSummary[] = ranOutcomes.map((o) => {
      const check = { path: toRepoPath(root, o.file), project: o.project }
      return { check, verdict: o.verdict, durationMs: o.durationMs, captured: captured(check) }
    })
    const recording = recordEvidence(options.strict, () => {
      // One transaction: assembly caches a digest for every file it reads.
      const { run, records } = options.store.transaction(() =>
        assemble({
          root,
          runId,
          runtimeKey,
          runtime: facts,
          revision: options.revision ?? null,
          createdAt,
          outDir: scratch,
          outcomes: ranOutcomes.filter((o) =>
            captured({ path: toRepoPath(root, o.file), project: o.project }),
          ),
          main,
          files,
          store: options.store,
          fs: rawFs,
          runner: { name: 'jest', version: target.version, isolate: true, pool: 'workers' },
          sharedWorkerProjects: new Set(),
          ignored,
          configFiles: [...configFiles],
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
    const ranKeys = new Set(outcomes.map((o) => checkKey(o.check)))
    const failed =
      runError ||
      outcomes.some((o) => o.verdict === 'fail') ||
      (recording.recorded && records.some((r) => r.verdict === 'fail')) ||
      selected.some((s) => !ranKeys.has(checkKey(s.check)))
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
    restoreHasteMap()
    closeSession()
    delete processHolder[CONFIG_KEY]
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (!options.keepScratch) fs.rmSync(scratch, { recursive: true, force: true })
  }
}
