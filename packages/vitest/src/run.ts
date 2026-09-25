import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MainRecorder, rawFs, VOLATILE_ENV } from '@veyrum/capture'
import { assemble } from '@veyrum/capture/assemble'
import { packageJsonAbove, storeFiles, veyrumDirs } from '@veyrum/capture/host'
import { UNCAPTURED_FILE } from '@veyrum/capture/worker'
import {
  type CheckOutcomeSummary,
  type CheckRef,
  ConfigurationError,
  checkKey,
  type Decision,
  forcedDecisions,
  listRepoFiles,
  needsPlan,
  PROJECT_CONFIG,
  ProjectConfigs,
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
import type { TestSpecification, Vitest } from 'vitest/node'
import { CAPTURE_ENV, type CaptureConfig, MAIN_KEY } from './protocol.ts'
import { OutcomeReporter } from './reporter.ts'
import { createTransformer } from './transformer.ts'

export type { RunMode, Verification } from '@veyrum/core'

export interface VitestRunOptions extends RunOptions {
  /** Path to the Vitest config file (defaults to Vitest's own lookup). */
  readonly config?: string
  /** Extra Vitest options (for example maxWorkers). */
  readonly vitestOptions?: Record<string, unknown>
  /**
   * Run every test file in its own isolate even if the project disables isolation. Evidence from a
   * shared isolate is never reused, so projects with `isolate: false` only benefit with this on.
   */
  readonly forceIsolation?: boolean
}

export type VitestRunResult = RunResult

interface TargetVitest {
  readonly nodeUrl: string
  readonly entryUrl: string
  readonly version: string
  readonly viteVersion: string
}

/** Resolves a package export for ESM consumers (conditions node, import, default). */
function resolveEsmExport(pkgDir: string, subpath: string): string | null {
  let pkg: { exports?: unknown; module?: string; main?: string }
  try {
    pkg = JSON.parse(rawFs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8') as string)
  } catch {
    return null
  }
  const pick = (target: unknown): string | null => {
    if (typeof target === 'string') return target
    if (Array.isArray(target)) {
      for (const t of target) {
        const found = pick(t)
        if (found) return found
      }
      return null
    }
    if (target && typeof target === 'object') {
      const record = target as Record<string, unknown>
      for (const condition of ['node', 'import', 'default']) {
        if (condition in record) {
          const found = pick(record[condition])
          if (found) return found
        }
      }
    }
    return null
  }
  const exportsField = pkg.exports
  let target: string | null = null
  if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const record = exportsField as Record<string, unknown>
    target = subpath in record ? pick(record[subpath]) : subpath === '.' ? pick(record) : null
  } else if (subpath === '.') {
    target = pick(exportsField) ?? pkg.module ?? pkg.main ?? null
  }
  return target ? path.join(pkgDir, target) : null
}

/** Resolves the target project's own Vitest install (never Veyrum's), as ESM entry points. */
export function resolveTargetVitest(root: string): TargetVitest {
  const require = createRequire(path.join(root, 'package.json'))
  const vitestPkg = packageJsonAbove(require.resolve('vitest/package.json'), 'vitest')
  if (!vitestPkg) throw new Error(`Cannot find Vitest installed in ${root}`)
  const nodePath = resolveEsmExport(vitestPkg.dir, './node')
  const entryPath = resolveEsmExport(vitestPkg.dir, '.')
  if (!nodePath || !entryPath) throw new Error(`Cannot resolve Vitest entry points in ${vitestPkg.dir}`)
  let viteVersion = ''
  try {
    const viteEntry = createRequire(path.join(vitestPkg?.dir ?? root, 'package.json')).resolve('vite')
    viteVersion = packageJsonAbove(viteEntry, 'vite')?.version ?? ''
  } catch {
    // Vite is a hard dependency of Vitest; an unresolvable one only weakens the runtime key.
  }
  return {
    nodeUrl: pathToFileURL(nodePath).href,
    entryUrl: pathToFileURL(entryPath).href,
    version: vitestPkg?.version ?? '',
    viteVersion,
  }
}

const BUILTIN_ENVIRONMENTS = new Set(['node', 'jsdom', 'happy-dom', 'edge-runtime'])

/**
 * Whether capture must start when the worker starts rather than in Veyrum's setup file (the first
 * setup file). Before setup files, a Vitest worker runs project code only for a custom environment,
 * snapshot serializers, a diff configuration module or a custom runner. Without those, starting in
 * the setup file observes everything the project runs, and Vitest's own start-up runs without
 * coverage, which is measurably cheaper.
 */
function startsBeforeSetupFiles(config: {
  environment?: string
  snapshotSerializers?: string[]
  diff?: unknown
  runner?: string
}): boolean {
  return (
    !BUILTIN_ENVIRONMENTS.has(config.environment ?? 'node') ||
    (config.snapshotSerializers?.length ?? 0) > 0 ||
    config.diff !== undefined ||
    config.runner !== undefined
  )
}

interface ServerEnvironments {
  environments?: Record<string, { moduleGraph?: { idToModuleMap: Map<string, { file: string | null }> } }>
}

/**
 * Files Vitest ran through its `__vitest__` Vite environment: custom test environments (loaded in
 * workers by a separate module runner whose modules coverage cannot attribute), global setup files
 * and the VCS provider. Each of them can affect every test file, so they are shared inputs.
 */
function runnerEnvironmentFiles(servers: readonly unknown[]): string[] {
  const out = new Set<string>()
  for (const server of servers) {
    const environment = (server as ServerEnvironments).environments?.__vitest__
    for (const node of environment?.moduleGraph?.idToModuleMap.values() ?? [])
      if (
        node.file &&
        path.isAbsolute(node.file) &&
        !node.file.includes(`${path.sep}node_modules${path.sep}`)
      )
        out.add(node.file)
  }
  return [...out]
}

interface NamedConfigOptions {
  root?: string
  tsconfig?: unknown
  oxc?: { tsconfig?: unknown } | false
  optimizeDeps?: { rolldownOptions?: { tsconfig?: unknown }; esbuildOptions?: { tsconfig?: unknown } }
}

/**
 * Project configurations the projects' configuration names, as repository paths: Vite's `tsconfig`
 * (rolldown's TsconfigCache then uses it for every file), a path in the transform or dependency
 * optimizer options, and Vitest's type-checking configuration. Each applies to files anywhere.
 */
function namedProjectConfigs(root: string, vitest: Vitest): string[] {
  const out: string[] = []
  const configs = [vitest, ...vitest.projects].map((p) => ({ vite: p.vite.config, test: p.config }))
  for (const config of configs) {
    const vite = config.vite as unknown as NamedConfigOptions
    const test = config.test as unknown as { typecheck?: { tsconfig?: unknown } }
    const named = [
      vite.tsconfig,
      vite.oxc ? vite.oxc.tsconfig : undefined,
      vite.optimizeDeps?.rolldownOptions?.tsconfig,
      vite.optimizeDeps?.esbuildOptions?.tsconfig,
      test.typecheck?.tsconfig,
    ]
    for (const name of named)
      if (typeof name === 'string') out.push(toRepoPath(root, path.resolve(vite.root ?? root, name)))
  }
  return out
}

function checkOf(root: string, spec: TestSpecification): CheckRef {
  return { path: toRepoPath(root, spec.moduleId), project: spec.project.name }
}

export async function runVitest(options: VitestRunOptions): Promise<VitestRunResult> {
  const started = performance.now()
  const root = path.resolve(options.root)
  const runId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  // Scratch space lives inside the project root wherever the store is: the setup file placed here
  // must be a project file, or Vite may refuse to serve it.
  const scratch = path.join(root, '.veyrum', 'tmp', runId)
  const files = listRepoFiles(root)
  const target = resolveTargetVitest(root)
  const ownDirs = veyrumDirs(path.dirname(fileURLToPath(import.meta.url)))
  // Only the store's own files are ignored, never its directory: a store kept next to (or above)
  // the project would otherwise hide the whole project from capture.
  const ignored = [...ownDirs, scratch + path.sep, ...storeFiles(options.store.file)]
  const preloadUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.js')).href
  // The setup file must be a project file for Vite; it is copied into the run's scratch directory.
  const setupPath = path.join(scratch, 'veyrum-setup.mjs')
  fs.mkdirSync(scratch, { recursive: true })
  const setupSource = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup.js'),
    'utf8',
  )
  // The compiled file points at a source map next to the original; the copy has none.
  fs.writeFileSync(setupPath, setupSource.replace(/\n\/\/# sourceMappingURL=.*$/m, '\n'))
  const ownRequire = createRequire(import.meta.url)

  const captureConfig: CaptureConfig = {
    root,
    outDir: scratch,
    ignored,
    vitestEntry: target.entryUrl,
    captureIndex: ownRequire.resolve('@veyrum/capture'),
    captureWorker: ownRequire.resolve('@veyrum/capture/worker'),
  }
  const previousCaptureEnv = process.env[CAPTURE_ENV]
  ;(process as unknown as Record<symbol, unknown>)[MAIN_KEY] = true
  process.env[CAPTURE_ENV] = JSON.stringify(captureConfig)
  // As the vitest command does before anything else (createVitest does not): without it, Vite's
  // configuration loading sets NODE_ENV to development, and tests and the programs they start see
  // that instead of test.
  const previousRunnerEnv = {
    TEST: process.env.TEST,
    VITEST: process.env.VITEST,
    NODE_ENV: process.env.NODE_ENV,
  }
  process.env.TEST = 'true'
  process.env.VITEST = 'true'
  process.env.NODE_ENV ??= 'test'
  const recorder = new MainRecorder({ root, ignoredPrefixes: ignored, volatileEnv: VOLATILE_ENV })

  const { createVitest } = (await import(target.nodeUrl)) as typeof import('vitest/node')
  const reporter = new OutcomeReporter()
  const reporters: unknown[] = [reporter]
  if (options.printTests) reporters.push('default')

  const facts = runtimeFacts({ runner: 'vitest', vitest: target.version, vite: target.viteVersion })
  const runtimeKey = runtimeKeyOf(facts)

  recorder.start()
  let vitest: Vitest | undefined
  try {
    // The (mode, options) form works on Vitest 4 and 5 (5 keeps it as a deprecated overload).
    vitest = await (
      createVitest as unknown as (mode: 'test', options: Record<string, unknown>) => Promise<Vitest>
    )('test', {
      root,
      ...(options.config ? { config: options.config } : {}),
      watch: false,
      run: true,
      passWithNoTests: true,
      // Planning runs nothing, and starting a coverage provider can clear its report directory.
      ...(options.mode === 'plan' || options.coverage === false
        ? { coverage: { enabled: false } }
        : options.coverage
          ? { coverage: { enabled: true } }
          : {}),
      reporters: reporters as never,
      ...options.vitestOptions,
    })

    const coverage = (vitest.config as unknown as { coverage?: { enabled?: boolean; provider?: string } })
      .coverage
    // Istanbul instruments the code that runs, which fingerprints see through (see fingerprint.ts);
    // a custom provider could do anything.
    const provider = coverage?.provider ?? 'v8'
    if (coverage?.enabled && provider !== 'v8' && provider !== 'istanbul')
      throw new ConfigurationError(
        `Veyrum can collect coverage only with Vitest's v8 or istanbul provider (this project uses ${provider}): run with --no-coverage`,
      )
    // Only V8 coverage shares the profiler with capture. Workers start later and read this then.
    const v8Coverage = coverage?.enabled === true && provider === 'v8'
    if (v8Coverage) process.env[CAPTURE_ENV] = JSON.stringify({ ...captureConfig, projectCoverage: true })

    // A project's global setup runs for that project's files only: what it reads is an input of
    // theirs, not of every file (the root project's applies to all). Vitest runs them one project
    // at a time; asynchronous work they start stays attributed to their project.
    const rootProject = vitest.getRootProject()
    for (const project of vitest.projects) {
      if (project === rootProject) continue
      const target = project as unknown as Record<string, unknown>
      for (const method of ['_initializeGlobalSetup', '_teardownGlobalSetup']) {
        const original = target[method]
        if (typeof original !== 'function') continue
        target[method] = (...args: unknown[]) =>
          recorder.scoped(project.name, () => (original as (...a: unknown[]) => unknown).apply(project, args))
      }
    }
    // Vite pre-transforms the local imports of each module it transforms, whether or not anything
    // loads them. What a test loads is recorded by the test; what the main process ran is recorded
    // after the run (see executedInMain).
    for (const project of vitest.projects) {
      for (const environment of Object.values(project.vite.environments)) {
        const target = environment as unknown as { warmupRequest?: (...args: unknown[]) => unknown }
        const original = target.warmupRequest
        if (typeof original !== 'function') continue
        target.warmupRequest = (...args: unknown[]) =>
          recorder.unrecorded(() => original.apply(environment, args))
      }
    }

    const sharedWorkerProjects = new Set<string>()
    for (const project of vitest.projects) {
      const config = project.config as unknown as {
        execArgv: string[]
        setupFiles: string[]
        isolate: boolean
        environment?: string
        snapshotSerializers?: string[]
        diff?: unknown
        runner?: string
      }
      // The project's own V8 coverage starts before setup files, and must go through Veyrum's
      // coverage hub (see @veyrum/capture's coverage.ts), which the preload installs first.
      if ((startsBeforeSetupFiles(config) || v8Coverage) && !config.execArgv.includes(preloadUrl))
        config.execArgv.push('--import', preloadUrl)
      if (!config.setupFiles.includes(setupPath)) config.setupFiles.unshift(setupPath)
      if (config.isolate === false) {
        if (options.forceIsolation) config.isolate = true
        else sharedWorkerProjects.add(project.name)
      }
    }

    const configFiles = new Set<string>()
    for (const project of vitest.projects) {
      const viteConfig = project.vite.config as unknown as {
        configFile?: string
        configFileDependencies?: string[]
        cacheDir?: string
      }
      // Vite's cache directory holds the runner's own outputs (results, pre-bundled deps). Workers
      // that execute pre-bundled deps still record those files as dependencies.
      if (viteConfig.cacheDir) ignored.push(path.resolve(root, viteConfig.cacheDir) + path.sep)
      if (viteConfig.configFile) configFiles.add(path.resolve(viteConfig.configFile))
      for (const dep of viteConfig.configFileDependencies ?? []) configFiles.add(path.resolve(root, dep))
    }
    // Vite 8 discovers project configurations in native code, which fs hooks cannot see: every
    // tsconfig and jsconfig in the repository is a shared input, with the files they extend or
    // reference. Each affects only the files it can govern (see @veyrum/core's tsconfig.ts),
    // except those the configuration names, which apply to every file, and those Vite's
    // configuration loading depends on.
    const configGraph = new ProjectConfigs(root, rawFs, files)
    const allProjectConfigs = configGraph
      .related(files.filter((f) => PROJECT_CONFIG.test(f)))
      .map((f) => path.join(root, f))
    const projectConfigs = new Set(allProjectConfigs.filter((f) => !configFiles.has(f)))
    for (const f of configGraph.related(namedProjectConfigs(root, vitest)))
      projectConfigs.delete(path.join(root, f))
    for (const f of allProjectConfigs) configFiles.add(f)

    // Initializes reporters and the coverage provider without running.
    // Vitest 4.1 renamed init() to standalone().
    const legacy = vitest as unknown as { standalone?: () => Promise<void>; init: () => Promise<void> }
    await (legacy.standalone ? legacy.standalone() : legacy.init())
    const allSpecs = await vitest.globTestSpecifications()
    const specs = selectFiles(allSpecs, (s) => toRepoPath(root, s.moduleId), options)
    const checks = specs.map((s) => checkOf(root, s))

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
        transformer: createTransformer(vitest, root),
        files,
        fs: rawFs,
        env: recorder.initialEnv as NodeJS.ProcessEnv,
        ...(options.policy ? { policy: options.policy } : {}),
      })
    }
    const planMs = performance.now() - planStarted

    if (options.mode === 'plan') {
      recorder.stop()
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
    const selected = specs.filter((s) => execution.toRun.has(checkKey(checkOf(root, s))))
    const captured = (check: CheckRef): boolean => execution.capture.has(checkKey(check))
    fs.writeFileSync(
      path.join(scratch, UNCAPTURED_FILE),
      JSON.stringify(selected.filter((s) => !captured(checkOf(root, s))).map((s) => s.moduleId)),
    )
    const runStarted = performance.now()
    let unhandled = 0
    if (selected.length > 0) {
      const result = await vitest.runTestSpecifications(selected, selected.length === allSpecs.length)
      unhandled = result.unhandledErrors.length
      // Vitest stops each worker in the background once its file has run, and a file whose tests
      // were all skipped finishes its capture only then (see setup.ts): wait for every worker.
      await (vitest as unknown as { pool?: { close?: () => Promise<void> } }).pool?.close?.()
    }
    const runMs = performance.now() - runStarted
    // What the main process's module runner executed (global setups and what they import): the
    // root project's is an input of every file, another project's only of that project's files.
    // Projects defined inline share the root's server, so a module belongs to a project when only
    // its runner evaluated it; on a server of its own, everything that server transformed is its.
    const rootServers = new Set<unknown>([vitest.vite, rootProject.vite])
    const rootGraph = runnerEnvironmentFiles([...rootServers])
    const rootEvaluated = new Set([...evaluatedBy(vitest), ...evaluatedBy(rootProject)])
    const projectOnly = new Set<string>()
    const sharedRunnerFiles = new Set<string>()
    for (const project of vitest.projects) {
      if (project === rootProject) continue
      const own = new Set(evaluatedBy(project).filter((f) => !rootEvaluated.has(f)))
      if (!rootServers.has(project.vite))
        for (const f of runnerEnvironmentFiles([project.vite])) if (!rootGraph.includes(f)) own.add(f)
      for (const f of own) {
        if (PROJECT_CONFIG.test(path.basename(f))) sharedRunnerFiles.add(f)
        else projectOnly.add(f)
      }
      recorder.executed(
        [...own].filter((f) => !PROJECT_CONFIG.test(path.basename(f))),
        project.name,
      )
    }
    for (const f of rootGraph) if (!projectOnly.has(f)) sharedRunnerFiles.add(f)
    const main = recorder.stop()
    for (const f of sharedRunnerFiles) {
      configFiles.add(f)
      projectConfigs.delete(f)
    }

    const recordStarted = performance.now()
    const pool = String((vitest.config as unknown as { pool?: string }).pool ?? '')
    const outcomes: CheckOutcomeSummary[] = [...reporter.outcomes.values()].map((o) => {
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
          outcomes: [...reporter.outcomes.values()].filter((o) =>
            captured({ path: toRepoPath(root, o.file), project: o.project }),
          ),
          main,
          files,
          store: options.store,
          fs: rawFs,
          runner: {
            name: 'vitest',
            version: target.version,
            isolate: sharedWorkerProjects.size === 0,
            pool,
          },
          sharedWorkerProjects,
          ignored,
          configFiles: [...configFiles],
          projectConfigs: [...projectConfigs],
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
      unhandled > 0 ||
      outcomes.some((o) => o.verdict === 'fail') ||
      outcomes.length < selected.length ||
      (recording.recorded && records.some((r) => r.verdict === 'fail'))
    return {
      runId,
      runtimeKey,
      decisions,
      records,
      ran: selected.map((s) => checkOf(root, s)),
      outcomes,
      verifications,
      ok: !failed,
      timings: { planMs, runMs, recordMs, totalMs: performance.now() - started },
    }
  } finally {
    recorder.stop()
    if (vitest) await vitest.close()
    if (previousCaptureEnv === undefined) delete process.env[CAPTURE_ENV]
    else process.env[CAPTURE_ENV] = previousCaptureEnv
    for (const [name, value] of Object.entries(previousRunnerEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    if (!options.keepScratch) fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/** The files a project's (or Vitest's own) module runner evaluated in the main process. */
function evaluatedBy(owner: unknown): string[] {
  const runner = (owner as { runner?: { evaluatedModules?: { fileToModulesMap?: Map<string, unknown> } } })
    .runner
  const files = runner?.evaluatedModules?.fileToModulesMap
  return files ? [...files.keys()].filter((f) => path.isAbsolute(f)) : []
}
