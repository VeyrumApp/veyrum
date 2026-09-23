/**
 * Vitest setup file added in front of the project's own setup files. It registers the hook that
 * finishes capture once the test file has run.
 *
 * Module loading is deliberate:
 * - Veyrum's own modules load through Node's native loader (createRequire), never through Vite,
 *   so this file shares one instance with the `--import` preload;
 * - `vitest` is imported from the target project's install (not Veyrum's), so the hook registers
 *   on the runner that executes the test file.
 */
import { createRequire } from 'node:module'
import type * as Capture from '@veyrum/capture'
import type * as CaptureWorker from '@veyrum/capture/worker'
import { PENDING_KEY, readCaptureConfig } from './protocol.ts'

/** Vitest 5 counts with CounterMap (valueOf gives the total); older versions used numbers. */
interface SnapshotStateLike {
  added?: number | { valueOf(): number }
  updated?: number | { valueOf(): number }
}

const config = readCaptureConfig()
if (config) {
  const nativeRequire = createRequire(import.meta.url)
  const { VOLATILE_ENV } = nativeRequire('@veyrum/capture') as typeof Capture
  const { beginWorkerCapture } = nativeRequire('@veyrum/capture/worker') as typeof CaptureWorker
  const g = globalThis as unknown as Record<symbol, Promise<CaptureWorker.WorkerCapture> | undefined>
  // The preload starts capture for the first file in an isolate. When an isolate runs several
  // files (isolation off), later files start here; their payloads are marked as reused.
  const pending =
    g[PENDING_KEY] ??
    beginWorkerCapture({
      root: config.root,
      outDir: config.outDir,
      ignoredPrefixes: config.ignored,
      volatileEnv: VOLATILE_ENV,
    })
  g[PENDING_KEY] = undefined
  const vitest = (await import(/* @vite-ignore */ config.vitestEntry)) as typeof import('vitest')
  const capture = await pending
  vitest.afterAll(async () => {
    const state = vitest.expect.getState() as unknown as {
      testPath?: string
      snapshotState?: SnapshotStateLike
    }
    const snapshot = state.snapshotState
    await capture.finish(state.testPath ?? '', {
      added: Number(snapshot?.added ?? 0),
      updated: Number(snapshot?.updated ?? 0),
    })
  })
}
