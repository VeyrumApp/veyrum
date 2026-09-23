import type { Digest } from './hash.ts'

/**
 * One observed input of a check. Paths are repository-relative POSIX paths when the file lives
 * inside the repository, and absolute paths otherwise.
 */
export type ClosureEntry =
  /** A repository module executed through the runner's transform pipeline. */
  | {
      readonly k: 'mod'
      readonly p: string
      /** Digest of the raw source file on disk. */
      readonly src: Digest
      /** Fingerprints of the executed units (always includes the module top level). */
      readonly units: Readonly<Record<string, Digest>>
      /** Environment the module was transformed in (for example `ssr`). */
      readonly env: string
      /** The transform depends on more than the file itself (import.meta.glob); always re-transform. */
      readonly dyn?: true
    }
  /** A file loaded without transformation (node_modules, native addons, outside the repository). */
  | { readonly k: 'dep'; readonly p: string; readonly h: Digest | null }
  /** A file read through the fs API. `h` is null when the file did not exist at read time. */
  | { readonly k: 'file'; readonly p: string; readonly h: Digest | null }
  /**
   * A package manifest the runner's main process read. Compared by `hashManifest`: dependency
   * version ranges and scripts are left out, since what is installed is recorded separately.
   */
  | { readonly k: 'manifest'; readonly p: string; readonly h: Digest | null }
  /** A path whose existence or type was checked, but whose content was not read. */
  | { readonly k: 'stat'; readonly p: string; readonly t: 'file' | 'dir' | 'other' | 'absent' }
  /** A directory whose listing was read. */
  | { readonly k: 'dir'; readonly p: string; readonly h: Digest | null }
  /** An environment variable read. `h` is null when it was unset. */
  | { readonly k: 'env'; readonly n: string; readonly h: Digest | null }

export type ClosureKind = ClosureEntry['k']

/**
 * Flags record channels the closure cannot fully observe, or facts that affect reuse.
 * The policy decides which flags block reuse.
 */
export const FLAGS = {
  /** Opened a network connection to a non-loopback host. */
  netRemote: 'net-remote',
  /** Opened a loopback network connection (usually a server the test started itself). */
  netLocal: 'net-local',
  /** Spawned a child process or worker thread; its behavior is not observed. */
  spawn: 'spawn',
  /** Loaded a native addon (its binary is recorded as a dependency). */
  native: 'native-addon',
  /** Ran code compiled from strings (eval, new Function); derived from observed inputs. */
  evalCode: 'eval',
  /** Enumerated process.env. */
  envEnumerated: 'env-enumerated',
  /** Called Function.prototype.toString on non-native code; raw source is compared. */
  sourceObserved: 'source-observed',
  /** A snapshot contains file positions; raw source is compared. */
  positionsObserved: 'positions-observed',
  /** Wrote a snapshot during the run; the pass is not evidence. */
  snapshotWritten: 'snapshot-written',
  /** Needed a retry to pass. */
  flakySuspect: 'flaky-suspect',
  /** Ran in a worker shared with other test files (isolation off). */
  sharedWorker: 'shared-worker',
  /** Wrote files outside temporary directories. */
  writesFs: 'writes-fs',
  /** Capture failed or was incomplete for this check. */
  captureIncomplete: 'capture-incomplete',
} as const

export type Flag = (typeof FLAGS)[keyof typeof FLAGS]

export interface TestOutcome {
  readonly name: string
  readonly state: 'passed' | 'failed' | 'skipped' | 'pending'
  readonly durationMs: number
  readonly retries: number
}

export interface EvidenceRecord {
  readonly id: string
  /** Repository-relative test file path. */
  readonly check: string
  /** Runner project name ('' for the default project). */
  readonly project: string
  readonly runId: string
  readonly runtimeKey: Digest
  readonly verdict: 'pass' | 'fail'
  /** False when the verdict is not evidence at all (flaky, snapshot written, capture incomplete). */
  readonly reusable: boolean
  readonly flags: readonly string[]
  readonly tests: readonly TestOutcome[]
  readonly durationMs: number
  readonly closure: readonly ClosureEntry[]
  readonly createdAt: string
  readonly revision: string | null
}

/** Facts about one runner invocation, shared by every record it produced. */
export interface RunInfo {
  readonly id: string
  readonly createdAt: string
  readonly revision: string | null
  readonly runtimeKey: Digest
  readonly runtime: Readonly<Record<string, string>>
  /** Inputs read by the runner's main process (config, env files, resolution probes, env). */
  readonly shared: readonly ClosureEntry[]
  /** Environment variables injected into workers by the runner, name to value digest. */
  readonly injectedEnv: Readonly<Record<string, Digest | null>>
  /**
   * Variables the runner set in workers to values that differed between files, for example
   * Vitest's SSR, which depends on each file's test environment. Their value follows from the
   * runner's configuration and the file's own source, both inputs already.
   */
  readonly injectedVaryingEnv?: readonly string[]
  /** Repository-relative files that existed when the run started (for shadowing checks). */
  readonly files: readonly string[]
  readonly runner: {
    readonly name: string
    readonly version: string
    readonly isolate: boolean
    readonly pool: string
  }
}

export interface CheckRef {
  /** Repository-relative test file path. */
  readonly path: string
  readonly project: string
}

export type Action = 'run' | 'skip'

export interface Decision {
  readonly check: CheckRef
  readonly action: Action
  /** Short machine-readable reason code. */
  readonly reason:
    | 'reused'
    | 'no-evidence'
    | 'inputs-changed'
    | 'shared-inputs-changed'
    | 'blocked-flag'
    | 'not-reusable'
    | 'runtime-changed'
    | 'forced'
  readonly recordId: string | null
  /** Human-readable description of what changed or why reuse was refused. */
  readonly details: readonly string[]
  readonly closureSize: number
  /** Flags present on the reused record (only for skips). */
  readonly flagsRelied: readonly string[]
  /** Duration of the reused or most recent record, for savings estimates. */
  readonly durationMs: number
}
