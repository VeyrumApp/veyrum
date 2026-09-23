import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MainRecorder, rawFs, VOLATILE_ENV } from '@veyrum/capture'
import { assemble } from '@veyrum/capture/assemble'
import { packageJsonAbove, storeFiles, veyrumDirs } from '@veyrum/capture/host'
import { endWorkerCapture } from '@veyrum/capture/worker'
import {
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
  recordVerifications,
  runtimeFacts,
  runtimeKeyOf,
  selectExecution,
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
}

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
  const environmentSource = fs
    .readFileSync(path.join(here, 'environment.cjs'), 'utf8')
    .replace(/\n\/\/# sourceMappingURL=.*$/m, '\n')
  const environmentDir = path.join(root, '.veyrum', 'jest', digest(environmentSource), 'node_modules')
  const environmentPath = path.join(environmentDir, 'veyrum-environment.cjs')
  if (!fs.existsSync(environmentPath)) {
    fs.mkdirSync(environmentDir, { recursive: true })
    const temporary = `${environmentPath}.${runId}`
    fs.writeFileSync(temporary, environmentSource)
    fs.renameSync(temporary, environmentPath)
  }
  ignored.push(path.dirname(environmentDir) + path.sep)
  const reporterPath = path.join(here, 'reporter.js')

  const recorder = new MainRecorder({ root, ignoredPrefixes: ignored, volatileEnv: VOLATILE_ENV })
  const previousCaptureEnv = process.env[JEST_CAPTURE_ENV]
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
      collectCoverage: false,
      passWithNoTests: true,
      silent: !options.printTests,
    }
    const { globalConfig, configs: allConfigs } = await api.readConfigs(baseArgv, [root])
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
      environments,
    }
    process.env[JEST_CAPTURE_ENV] = JSON.stringify(captureConfig)

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
    let selectedSpecs = specs
    if (options.only) {
      const wanted = new Set(options.only)
      selectedSpecs = specs.filter((s) => wanted.has(s.check.path))
    }
    const checks = selectedSpecs.map((s) => s.check)

    const configFiles = new Set<string>()
    for (const f of files)
      if (TOOLCHAIN_CONFIG.test(f) || f === 'package.json') configFiles.add(path.join(root, f))
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
        verifications: [],
        ok: true,
        timings: { planMs, runMs: 0, recordMs: 0, totalMs: performance.now() - started },
      }
    }

    const execution = selectExecution(checks, decisions, options, runId)
    const selected = selectedSpecs.filter((s) => execution.toRun.has(checkKey(s.check)))
    const runStarted = performance.now()
    const session = openSession(names)
    let runError = false
    if (selected.length > 0) {
      const { results } = await api.runCLI(
        {
          ...baseArgv,
          _: [...new Set(selected.map((s) => s.file))],
          runTestsByPath: true,
          testEnvironment: environmentPath,
          reporters: options.printTests ? ['default', reporterPath] : [reporterPath],
        },
        [root],
      )
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
    const outcomes = [...session.outcomes.values()].filter((o) =>
      known.has(checkKey({ path: toRepoPath(root, o.file), project: o.project })),
    )
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
          outcomes,
          main,
          files,
          store: options.store,
          fs: rawFs,
          runner: { name: 'jest', version: target.version, isolate: true, pool: 'workers' },
          sharedWorkerProjects: new Set(),
          ignored,
          configFiles: [...configFiles],
        }),
      )
      options.store.transaction(() => {
        options.store.putRun(run)
        for (const record of records) options.store.putRecord(record)
      })
      return { records, verifications: recordVerifications(options.store, runId, execution, records) }
    })
    const { records, verifications } = recording
    const recordMs = performance.now() - recordStarted
    const ranKeys = new Set(
      recording.recorded
        ? records.map((r) => checkKey({ path: r.check, project: r.project }))
        : outcomes.map((o) => checkKey({ path: toRepoPath(root, o.file), project: o.project })),
    )
    const failed =
      runError ||
      (recording.recorded
        ? records.some((r) => r.verdict === 'fail')
        : outcomes.some((o) => o.verdict === 'fail')) ||
      selected.some((s) => !ranKeys.has(checkKey(s.check)))
    return {
      runId,
      runtimeKey,
      decisions,
      records,
      ran: selected.map((s) => s.check),
      verifications,
      ok: !failed,
      timings: { planMs, runMs, recordMs, totalMs: performance.now() - started },
    }
  } finally {
    recorder.stop()
    restoreHasteMap()
    closeSession()
    if (previousCaptureEnv === undefined) delete process.env[JEST_CAPTURE_ENV]
    else process.env[JEST_CAPTURE_ENV] = previousCaptureEnv
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (!options.keepScratch) fs.rmSync(scratch, { recursive: true, force: true })
  }
}
