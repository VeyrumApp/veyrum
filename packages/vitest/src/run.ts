import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MainRecorder, rawFs, VOLATILE_ENV } from '@veyrum/capture'
import {
  type CheckRef,
  type Decision,
  type EvidenceRecord,
  listRepoFiles,
  type Policy,
  plan,
  runtimeFacts,
  runtimeKeyOf,
  type Store,
  toRepoPath,
} from '@veyrum/core'
import type { TestSpecification, Vitest } from 'vitest/node'
import { assemble } from './assemble.ts'
import { CAPTURE_ENV, type CaptureConfig } from './protocol.ts'
import { OutcomeReporter } from './reporter.ts'
import { createTransformer } from './transformer.ts'

export type RunMode =
  /** Run every test file and record evidence. */
  | 'full'
  /** Skip test files whose evidence is still valid; run and record the rest. */
  | 'affected'
  /** Only compute decisions; run nothing. */
  | 'plan'

export interface VitestRunOptions {
  readonly root: string
  readonly store: Store
  readonly mode: RunMode
  /** Path to the Vitest config file (defaults to Vitest's own lookup). */
  readonly config?: string
  readonly revision?: string | null
  readonly policy?: Policy
  /** Extra Vitest options (for example maxWorkers). */
  readonly vitestOptions?: Record<string, unknown>
  /** Print Vitest's default reporter output. */
  readonly printTests?: boolean
  /** Restrict to these repository-relative test files (others are neither planned nor run). */
  readonly only?: readonly string[]
  /** Keep worker payloads and module code after the run (for debugging). */
  readonly keepScratch?: boolean
}

export interface VitestRunResult {
  readonly runId: string
  readonly decisions: readonly Decision[]
  readonly records: readonly EvidenceRecord[]
  readonly ran: readonly CheckRef[]
  readonly ok: boolean
  readonly timings: {
    readonly planMs: number
    readonly runMs: number
    readonly recordMs: number
    readonly totalMs: number
  }
}

interface TargetVitest {
  readonly nodeUrl: string
  readonly entryUrl: string
  readonly version: string
  readonly viteVersion: string
}

function packageJsonAbove(file: string, name: string): { version: string; dir: string } | null {
  let dir = path.dirname(file)
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json')
    try {
      const pkg = JSON.parse(rawFs.readFileSync(candidate, 'utf8') as string) as {
        name?: string
        version?: string
      }
      if (pkg.name === name) return { version: pkg.version ?? '', dir }
    } catch {
      // keep walking
    }
    dir = path.dirname(dir)
  }
  return null
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

function veyrumDirs(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const require = createRequire(import.meta.url)
  const dirs = new Set<string>([path.dirname(here)])
  for (const pkg of ['@veyrum/capture', '@veyrum/core']) {
    const found = packageJsonAbove(require.resolve(pkg), pkg)
    if (found) dirs.add(found.dir)
  }
  const out: string[] = []
  for (const d of dirs) {
    out.push(d + path.sep)
    try {
      out.push(fs.realpathSync(d) + path.sep)
    } catch {
      // not a symlink
    }
  }
  return [...new Set(out)]
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
  const ownDirs = veyrumDirs()
  const ignored = [...ownDirs, scratch + path.sep, path.dirname(options.store.file) + path.sep]
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
  process.env[CAPTURE_ENV] = JSON.stringify(captureConfig)
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
      coverage: { enabled: false },
      reporters: reporters as never,
      ...options.vitestOptions,
    })

    const sharedWorkerProjects = new Set<string>()
    for (const project of vitest.projects) {
      const config = project.config as unknown as {
        execArgv: string[]
        setupFiles: string[]
        isolate: boolean
      }
      if (!config.execArgv.includes(preloadUrl)) config.execArgv.push('--import', preloadUrl)
      if (!config.setupFiles.includes(setupPath)) config.setupFiles.unshift(setupPath)
      if (config.isolate === false) sharedWorkerProjects.add(project.name)
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
    for (const f of files)
      if (/(^|\/)(tsconfig|jsconfig)[^/]*\.json$/.test(f)) configFiles.add(path.join(root, f))

    // Initializes reporters (and the coverage provider, which Veyrum disables) without running.
    await vitest.standalone()
    let specs = await vitest.globTestSpecifications()
    if (options.only) {
      const wanted = new Set(options.only)
      specs = specs.filter((s) => wanted.has(toRepoPath(root, s.moduleId)))
    }
    const checks = specs.map((s) => checkOf(root, s))

    const planStarted = performance.now()
    let decisions: Decision[]
    if (options.mode === 'full') {
      decisions = checks.map((check) => ({
        check,
        action: 'run',
        reason: 'forced',
        recordId: null,
        details: ['full run requested'],
        closureSize: 0,
        flagsRelied: [],
        durationMs: 0,
      }))
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
        decisions,
        records: [],
        ran: [],
        ok: true,
        timings: { planMs, runMs: 0, recordMs: 0, totalMs: performance.now() - started },
      }
    }

    const toRun = new Set(
      decisions.filter((d) => d.action === 'run').map((d) => `${d.check.project}\u0000${d.check.path}`),
    )
    const selected = specs.filter((s) => toRun.has(`${s.project.name}\u0000${toRepoPath(root, s.moduleId)}`))
    const runStarted = performance.now()
    let unhandled = 0
    if (selected.length > 0) {
      const result = await vitest.runTestSpecifications(selected, selected.length === specs.length)
      unhandled = result.unhandledErrors.length
    }
    const runMs = performance.now() - runStarted
    const main = recorder.stop()

    const recordStarted = performance.now()
    const { run, records } = assemble({
      root,
      runId,
      runtimeKey,
      runtime: facts,
      revision: options.revision ?? null,
      createdAt,
      outDir: scratch,
      outcomes: reporter.outcomes,
      main,
      files,
      store: options.store,
      fs: rawFs,
      runner: {
        name: 'vitest',
        version: target.version,
        isolate: sharedWorkerProjects.size === 0,
        pool: String((vitest.config as unknown as { pool?: string }).pool ?? ''),
      },
      sharedWorkerProjects,
      ignored,
      configFiles: [...configFiles],
    })
    options.store.transaction(() => {
      options.store.putRun(run)
      for (const record of records) options.store.putRecord(record)
    })
    const recordMs = performance.now() - recordStarted
    const failed =
      records.some((r) => r.verdict === 'fail') || unhandled > 0 || records.length < selected.length
    return {
      runId,
      decisions,
      records,
      ran: selected.map((s) => checkOf(root, s)),
      ok: !failed,
      timings: { planMs, runMs, recordMs, totalMs: performance.now() - started },
    }
  } finally {
    recorder.stop()
    if (vitest) await vitest.close()
    if (previousCaptureEnv === undefined) delete process.env[CAPTURE_ENV]
    else process.env[CAPTURE_ENV] = previousCaptureEnv
    if (!options.keepScratch) fs.rmSync(scratch, { recursive: true, force: true })
  }
}
