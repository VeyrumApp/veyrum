/** Configuration handed from the Veyrum main process to node:test's test file processes. */
export interface NodeTestCaptureConfig {
  readonly root: string
  readonly outDir: string
  /** Absolute path prefixes whose files are never recorded (Veyrum's own code). */
  readonly ignored: readonly string[]
  /** The preload's own URL, which test files must not see in their execArgv. */
  readonly preload: string
}

export const NODE_TEST_CAPTURE_ENV = 'VEYRUM_NODE_TEST_CAPTURE'

/** Where the reporter writes each file's outcome, one JSON document per run. */
export interface ReportedFile {
  readonly file: string
  readonly verdict: 'pass' | 'fail'
  readonly durationMs: number
  readonly tests: readonly {
    readonly name: string
    readonly state: 'passed' | 'failed' | 'skipped' | 'pending'
    readonly durationMs: number
    readonly retries: number
  }[]
}
