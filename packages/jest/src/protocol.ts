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
  /** The sequencer the project configured, which Veyrum's own wraps (see sequencer.cts). */
  readonly sequencer: string
  /** The environment each project configured, by Jest project config id, that the wrapper runs. */
  readonly environments: Readonly<Record<string, string>>
}

export const JEST_CAPTURE_ENV = 'VEYRUM_JEST_CAPTURE'

/** Where the main process collects per-file outcomes from the reporter (same process). */
export const SESSION_KEY = Symbol.for('veyrum.jest.session')
