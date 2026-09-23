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
}

const PENDING = Symbol.for('veyrum.vitest.pending')

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
  const nodes = state?.evaluatedModules?.fileToModulesMap?.get(absolutePath)
  if (!nodes) return undefined
  const out: string[] = []
  for (const node of nodes) if (typeof node.meta?.code === 'string') out.push(node.meta.code)
  return out
}
const raw = process.env.VEYRUM_CAPTURE
const config = raw ? (JSON.parse(raw) as SetupConfig) : null

if (config) {
  // Vitest's entry is imported before capture starts: no project code runs while it loads, and
  // under precise coverage its compilation costs several times more.
  const vitest = (await import(/* @vite-ignore */ config.vitestEntry)) as typeof import('vitest')
  const nativeRequire = createRequire(import.meta.url)
  const { VOLATILE_ENV } = nativeRequire(config.captureIndex) as typeof Capture
  const { beginWorkerCapture } = nativeRequire(config.captureWorker) as typeof CaptureWorker
  const g = globalThis as unknown as Record<symbol, Promise<CaptureWorker.WorkerCapture> | undefined>
  // The preload starts capture when project code can run before setup files (custom environment,
  // snapshot serializers, diff options, custom runner); otherwise capture starts here, before any
  // project code. When an isolate runs several files (isolation off), later files start here too;
  // their payloads are marked as reused.
  const pending =
    g[PENDING] ??
    beginWorkerCapture({
      root: config.root,
      outDir: config.outDir,
      ignoredPrefixes: config.ignored,
      volatileEnv: VOLATILE_ENV,
    })
  g[PENDING] = undefined
  const capture = await pending
  vitest.afterAll(async () => {
    const state = vitest.expect.getState() as unknown as {
      testPath?: string
      snapshotState?: SnapshotStateLike
    }
    const snapshot = state.snapshotState
    await capture.finish(
      state.testPath ?? '',
      { added: Number(snapshot?.added ?? 0), updated: Number(snapshot?.updated ?? 0) },
      evaluatedSources,
    )
  })
}
