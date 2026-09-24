/** Configuration handed from the Veyrum main process to Jest workers via VEYRUM_JEST_CAPTURE. */
export interface JestCaptureConfig {
  readonly root: string
  readonly outDir: string
  /** Absolute path prefixes whose files are never recorded (Veyrum's own code). */
  readonly ignored: readonly string[]
  /** Absolute paths of Veyrum's capture modules, loaded natively by the environment wrapper. */
  readonly captureIndex: string
  readonly captureWorker: string
  /** The jest-resolve module Jest's runtime resolves with, whose haste lookups are observed. */
  readonly resolver: string
  /** The jest-resolve module Jest's runner resolves docblock environments with (see preload.cts). */
  readonly environmentResolver: string
  /** The @jest/transform module Jest's runner loads environments with (see preload.cts). */
  readonly runnerTransform: string
  /** The environment wrapper, which wraps every environment jest-runner loads (see preload.cts). */
  readonly environmentPath: string
  /** The preload workers load (see preload.cts), which tests must not see in their execArgv. */
  readonly preload: string
  /** The project collects its own V8 coverage in this run (see WorkerCaptureOptions). */
  readonly projectCoverage?: boolean
  /** The sequencer the project configured, which Veyrum's own wraps (see sequencer.cts). */
  readonly sequencer: string
  /** The environment each project configured, by Jest project config id. */
  readonly environments: Readonly<Record<string, string>>
}

export const JEST_CAPTURE_ENV = 'VEYRUM_JEST_CAPTURE'

/** Where the main process collects per-file outcomes from the reporter (same process). */
export const SESSION_KEY = Symbol.for('veyrum.jest.session')
