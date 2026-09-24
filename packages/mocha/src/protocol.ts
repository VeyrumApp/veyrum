/** Configuration handed from the Veyrum main process to the process that runs one test file. */
export interface MochaChildConfig {
  readonly root: string
  readonly outDir: string
  /** Absolute path prefixes whose files are never recorded (Veyrum's own code). */
  readonly ignored: readonly string[]
  /** The project's Mocha package directory. */
  readonly mochaDir: string
  /** Mocha command line arguments given to Veyrum (a --config file), which Mocha reads with its config. */
  readonly argv: readonly string[]
  /** The test file this process runs. */
  readonly file: string
  /** Where the process writes its ReportedFile. */
  readonly reportFile: string
  /** Print Mocha's spec reporter output. */
  readonly print: boolean
  /** Veyrum's own output is a terminal: color the spec reporter unless the project decides. */
  readonly color: boolean
}

export const MOCHA_CHILD_ENV = 'VEYRUM_MOCHA_CHILD'

/** A test file's outcome, written by its process once Mocha's run ends. */
export interface ReportedFile {
  readonly verdict: 'pass' | 'fail'
  readonly durationMs: number
  readonly tests: readonly {
    readonly name: string
    readonly state: 'passed' | 'failed' | 'skipped' | 'pending'
    readonly durationMs: number
    readonly retries: number
  }[]
}
