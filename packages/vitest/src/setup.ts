/**
 * Vitest setup file added in front of the project's own setup files. It registers the hook that
 * finishes capture once the test file has run.
 *
 * This file is copied into the run's scratch directory inside the project root before the run, so
 * Vite treats it as a project file (files outside the root can be refused by `server.fs.allow`).
 * It must therefore stay self-contained: no relative imports.
 *
 * Module loading is deliberate:
 * - Veyrum's capture modules load by absolute path through Node's native loader, never through
 *   Vite, so this file shares one instance with the `--import` preload;
 * - `vitest` is imported from the target project's install (not Veyrum's), so the hook registers
 *   on the runner that executes the test file.
 */
import { createRequire } from 'node:module'
import type * as Capture from '@veyrum/capture'
import type * as CaptureWorker from '@veyrum/capture/worker'

/** Vitest 5 counts with CounterMap (valueOf gives the total); older versions used numbers. */
interface SnapshotStateLike {
  added?: number | { valueOf(): number }
  updated?: number | { valueOf(): number }
}

interface SetupConfig {
  root: string
  outDir: string
  ignored: string[]
  vitestEntry: string
  captureIndex: string
  captureWorker: string
  projectCoverage?: boolean
}

const PENDING = Symbol.for('veyrum.vitest.pending')
/** Finishes the capture of the previous file in this worker, when no hook of that file did. */
const UNFINISHED = Symbol.for('veyrum.vitest.unfinished')

interface EvaluatedModuleLike {
  meta?: { code?: unknown }
}

/**
 * The code Vitest's module runner evaluated for a file. The runner keeps it on each evaluated
 * module (Vite uses it for source maps), which is much cheaper than asking the Debugger.
 */
function evaluatedSources(absolutePath: string): string[] | undefined {
  const state = (globalThis as Record<string, unknown>).__vitest_worker__ as
    | { evaluatedModules?: { fileToModulesMap?: Map<string, Set<EvaluatedModuleLike>> } }
    | undefined
  const map = state?.evaluatedModules?.fileToModulesMap
  // Vitest names files with forward slashes on Windows too.
  const nodes = map?.get(absolutePath) ?? map?.get(absolutePath.replaceAll('\\', '/'))
  if (!nodes) return undefined
  const out: string[] = []
  for (const node of nodes) if (typeof node.meta?.code === 'string') out.push(node.meta.code)
  return out
}
/** Every file the runner has evaluated in this worker so far. */
function evaluatedFiles(): string[] {
  const state = (globalThis as Record<string, unknown>).__vitest_worker__ as
    | { evaluatedModules?: { fileToModulesMap?: Map<string, unknown> } }
    | undefined
  return [...(state?.evaluatedModules?.fileToModulesMap?.keys() ?? [])]
}

/**
 * The run's configuration, from the variable Veyrum's main process sets for its workers. In a
 * worker it is then removed from the environment, so tests and the programs they start see the
 * environment they would without Veyrum; later readers in this process, in any realm, get it from
 * `process`.
 */
function takeConfig(name: string): string | undefined {
  const holder = process as unknown as Record<symbol, unknown>
  const key = Symbol.for(`veyrum.config.${name}`)
  const taken = holder[key] as string | undefined
  if (taken !== undefined) return taken
  const raw = process.env[name]
  if (raw === undefined) return undefined
  holder[key] = raw
  if (!holder[Symbol.for('veyrum.main')]) delete process.env[name]
  return raw
}

const raw = takeConfig('VEYRUM_CAPTURE')
const config = raw ? (JSON.parse(raw) as SetupConfig) : null

if (config) {
  // Vitest's entry is imported before capture starts: no project code runs while it loads, and
  // under precise coverage its compilation costs several times more.
  const vitest = (await import(/* @vite-ignore */ config.vitestEntry)) as typeof import('vitest')
  const nativeRequire = createRequire(import.meta.url)
  const { VOLATILE_ENV } = nativeRequire(config.captureIndex) as typeof Capture
  const { beginWorkerCapture, uncapturedFiles } = nativeRequire(config.captureWorker) as typeof CaptureWorker
  const g = globalThis as unknown as Record<symbol, Promise<CaptureWorker.WorkerCapture> | undefined>
  const unfinished = globalThis as unknown as Record<symbol, (() => Promise<void>) | undefined>
  await unfinished[UNFINISHED]?.()
  const worker = (globalThis as Record<string, unknown>).__vitest_worker__ as
    | { filepath?: string; onCleanup?: (listener: () => Promise<void>) => void }
    | undefined
  const testFile = worker?.filepath
  // A file whose evidence is still valid runs plain: its record already describes this execution.
  const plain = testFile !== undefined && uncapturedFiles(config.outDir).has(testFile)
  if (plain) {
    const started = g[PENDING]
    g[PENDING] = undefined
    if (started) await (await started).abandon()
  }
  // The preload starts capture when project code can run before setup files (custom environment,
  // snapshot serializers, diff options, custom runner); otherwise capture starts here, before any
  // project code. When an isolate runs several files (isolation off), later files start here too;
  // their payloads are marked as reused.
  const pending = plain
    ? null
    : (g[PENDING] ??
      beginWorkerCapture({
        root: config.root,
        outDir: config.outDir,
        ignoredPrefixes: config.ignored,
        volatileEnv: VOLATILE_ENV,
        ...(config.projectCoverage ? { projectCoverage: true } : {}),
      }))
  g[PENDING] = undefined
  const capture = pending ? await pending : null
  // A capture the preload began has recorded I/O since the worker started; coverage starts now,
  // before any setup file or test code, and what the runner evaluated so far is recorded whole.
  if (capture) {
    await capture.startCoverage(evaluatedFiles())
    let finishing: Promise<void> | undefined
    const finish = (): Promise<void> => {
      if (unfinished[UNFINISHED] === finish) unfinished[UNFINISHED] = undefined
      finishing ??= (async () => {
        const state = vitest.expect.getState() as unknown as {
          testPath?: string
          snapshotState?: SnapshotStateLike
        }
        const snapshot = state.snapshotState
        await capture.finish(
          state.testPath ?? testFile ?? '',
          { added: Number(snapshot?.added ?? 0), updated: Number(snapshot?.updated ?? 0) },
          evaluatedSources,
        )
      })()
      return finishing
    }
    vitest.afterAll(finish)
    // Vitest runs no hook of a file whose tests are all skipped. Its capture then finishes when the
    // worker stops (each isolated file has its own), or when the next file starts in this worker.
    unfinished[UNFINISHED] = finish
    worker?.onCleanup?.(async () => {
      await unfinished[UNFINISHED]?.()
    })
  }
}
