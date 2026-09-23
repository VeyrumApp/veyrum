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
  readonly paths: readonly { readonly p: string; readonly kind: PathKind; readonly type: PathType }[]
  readonly writes: readonly string[]
  /** Environment variables read before this check wrote them, with value digests (never raw values). */
  readonly env: readonly { readonly n: string; readonly h: string | null }[]
  /** Digest of every variable present when the worker started, to detect runner-injected variables. */
  readonly envBaseline: Readonly<Record<string, string | null>>
  readonly envEnumerated: boolean
  readonly envWritten: readonly string[]
  readonly net: readonly { readonly host: string; readonly port: number | null; readonly local: boolean }[]
  readonly spawns: readonly string[]
  readonly dlopen: readonly string[]
  /** Number of executed scripts compiled from strings (eval, new Function). */
  readonly evalScripts: number
  readonly sourceObserved: boolean
  readonly snapshot: { readonly added: number; readonly updated: number }
  /** Errors inside the capture layer itself; any error makes the record non-reusable. */
  readonly captureErrors: readonly string[]
}

export interface PayloadModule {
  /** Absolute path of the module file. */
  readonly path: string
  /** Digest of the executed module code (wrapper removed); the code is in blobs/<digest>.js. */
  readonly code: string
  /** Executed function ranges as [start, end] offsets into the module code. */
  readonly executed: readonly (readonly [number, number])[]
}
