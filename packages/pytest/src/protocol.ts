import type { TestOutcome } from '@veyrum/core'

/** The variable carrying PytestCaptureConfig into the pytest processes Veyrum starts. */
export const PYTEST_CAPTURE_ENV = 'VEYRUM_PYTEST_CAPTURE'

/** Configuration of the capture plugin (python/veyrum_capture.py), as JSON. */
export type PytestCaptureConfig =
  | {
      /** List the test files pytest would run (`--collect-only`). */
      readonly mode: 'collect'
      /** Where the plugin writes the CollectedTests document. */
      readonly collectFile: string
      readonly pythonPath: string | null
      readonly pluginDir: string
    }
  | {
      /** Run one test file, reporting its tests and, when `capture` is set, its inputs. */
      readonly mode: 'run'
      readonly capture: boolean
      readonly root: string
      /** Absolute path prefixes whose files are never recorded (Veyrum's own code and scratch). */
      readonly ignored: readonly string[]
      readonly testFile: string
      /** Where the plugin writes the file's WorkerPayload (capture's payload format). */
      readonly payload: string
      /** Where the plugin writes the ReportedFile document. */
      readonly report: string
      /** Source of VOLATILE_ENV: variables whose reads are never recorded. */
      readonly volatileEnv: string
      /** PYTHONPATH as the project had it, restored before tests run (null: unset). */
      readonly pythonPath: string | null
      /** The plugin's own directory, removed from sys.path before tests run. */
      readonly pluginDir: string
      /** Where traced Python child processes of the test write their payloads. */
      readonly children: string
    }

/** What collect mode reports. */
export interface CollectedTests {
  /** Absolute paths of the files with tests, and of files that failed to collect. */
  readonly files: readonly string[]
  readonly rootpath: string
  /** The configuration file pytest used, if any. */
  readonly inipath: string | null
  /** Whether pytest-xdist is active (Veyrum then turns its distribution off per file). */
  readonly xdist: boolean
}

/** What run mode reports for its test file. */
export interface ReportedFile {
  /** Whether any test (or the file's collection) failed. */
  readonly verdict: 'pass' | 'fail'
  readonly exitStatus: number
  readonly durationMs: number
  readonly tests: readonly TestOutcome[]
}
