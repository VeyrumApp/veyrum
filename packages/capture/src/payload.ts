import type { Digest } from '@veyrum/core'
import type { PathKind, PathType } from './hooks.ts'

/** What one test file's worker observed. Written as JSON; code lives in content-addressed blobs. */
export interface WorkerPayload {
  readonly version: 1
  /** Absolute path of the test file. */
  readonly testFile: string
  readonly pid: number
  readonly threadId: number
  /** True when this isolate already ran another test file (isolation off). */
  readonly isolateReused: boolean
  /** Modules executed through the runner's transform pipeline. */
  readonly modules: readonly PayloadModule[]
  /** Absolute paths of scripts loaded without the transform pipeline (node_modules, natives). */
  readonly natives: readonly string[]
  /**
   * Repository modules evaluated before coverage started (see WorkerCaptureOptions.deferCoverage):
   * compared whole, by their source.
   */
  readonly wholeModules?: readonly string[]
  readonly paths: readonly { readonly p: string; readonly kind: PathKind; readonly type: PathType }[]
  readonly writes: readonly string[]
  /** Environment variables read before this check wrote them, with value digests (never raw values). */
  readonly env: readonly { readonly n: string; readonly h: string | null }[]
  /** Digest of every variable present when the worker started, to detect runner-injected variables. */
  readonly envBaseline: Readonly<Record<string, string | null>>
  /**
   * Jest layout: variables the runner and its toolchain read from the worker's own environment
   * during this file (tests read their context's copy). Shared inputs of the run.
   */
  readonly toolchainEnv: readonly { readonly n: string; readonly h: string | null }[]
  readonly envEnumerated: boolean
  /** Drew random numbers: what it exercised can differ from run to run (see FLAGS.random). */
  readonly random?: boolean
  readonly envWritten: readonly string[]
  readonly net: readonly { readonly host: string; readonly port: number | null; readonly local: boolean }[]
  readonly spawns: readonly string[]
  /**
   * Jest layout: package names looked up among repository manifests while resolving (haste
   * packages), directly or through Jest's resolver cache.
   */
  readonly packageNames?: readonly string[]
  readonly dlopen: readonly string[]
  /** Number of executed scripts compiled from strings (eval, new Function). */
  readonly evalScripts: number
  readonly sourceObserved: boolean
  /**
   * The function source texts read (Function.prototype.toString), when few enough to keep. Absent
   * with sourceObserved set means every module of the file is compared by raw source.
   */
  readonly observedSources?: readonly string[]
  readonly snapshot: { readonly added: number; readonly updated: number }
  /**
   * Manifests of packages the worker loaded natively, outside the runner's module system. Under the
   * Jest layout these are the toolchain (transformers and their plugins), since test code loads
   * through Jest's runtime; they are shared inputs of the run. Empty under the Vitest layout.
   */
  readonly toolchain: readonly string[]
  /** Jest layout: files outside node_modules loaded natively (local transformers, plugins). */
  readonly toolchainFiles: readonly string[]
  /** Errors inside the capture layer itself; any error makes the record non-reusable. */
  readonly captureErrors: readonly string[]
  /** Time the capture layer spent in this worker for this file (diagnostics). */
  readonly timings?: {
    readonly beginMs: number
    readonly finishMs: number
    readonly takeMs?: number
    /** Starting coverage, when it started after the capture began (see deferCoverage). */
    readonly startMs?: number
  }
}

export interface PayloadModule {
  /** Absolute path of the module file. */
  readonly path: string
  /** Digest of the executed module code (wrapper removed); the code is in blobs/<digest>.js. */
  readonly code: string
  /** Executed function ranges as [start, end] offsets into the module code. */
  readonly executed: readonly (readonly [number, number])[]
  /**
   * Fingerprints of the executed units, keyed by unit path, when the runtime computes them itself
   * (Python, which runs its source as written): then no code blob is written and `executed` is
   * empty. Always holds the module top level.
   */
  readonly units?: Readonly<Record<string, Digest>>
  /** With `units`: digest of the source file they were computed from. */
  readonly src?: Digest
  /**
   * The transform environment this code came from, when it is not the test file's own (see
   * CheckOutcome.env): a Playwright test file runs modules in its test process and client files in
   * the browser, each compiled again differently at plan time.
   */
  readonly env?: string
}
