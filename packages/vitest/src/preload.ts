/**
 * Loaded into every Vitest worker with `node --import` before any Vitest or user code runs, so
 * the profiler and I/O hooks observe everything the test file's isolate executes.
 */
import { VOLATILE_ENV } from '@veyrum/capture'
import { beginWorkerCapture } from '@veyrum/capture/worker'
import { PENDING_KEY, readCaptureConfig } from './protocol.ts'

const config = readCaptureConfig()
if (config) {
  const g = globalThis as unknown as Record<symbol, unknown>
  g[PENDING_KEY] = beginWorkerCapture({
    root: config.root,
    outDir: config.outDir,
    ignoredPrefixes: config.ignored,
    volatileEnv: VOLATILE_ENV,
  })
  // Surface capture start-up failures when the setup file awaits the promise, not as crashes here.
  ;(g[PENDING_KEY] as Promise<unknown>).catch(() => {})
}
