import { AsyncLocalStorage } from 'node:async_hooks'
import module from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Digest } from '@veyrum/core/hash'
import { hashEnvValue } from '@veyrum/core/state'
import { type HookSink, installHooks, type PathKind, type PathType, setSink, unobserved } from './hooks.ts'

export interface MainObservations {
  readonly paths: readonly { readonly p: string; readonly kind: PathKind; readonly type: PathType }[]
  readonly env: readonly { readonly n: string; readonly h: Digest | null }[]
  /** Every non-volatile variable present when capture started, name to value digest. */
  readonly envBaseline: Readonly<Record<string, Digest | null>>
  /**
   * Manifests (package.json) of every package the main process loaded code from: the runner, Vite,
   * plugins and whatever they use. Their versions decide how every module is transformed.
   */
  readonly loadedPackages: readonly string[]
  /**
   * Files outside node_modules the main process loaded as code through Node's loader: runner
   * configuration and its local imports, global setup, custom environments and reporters.
   */
  readonly loadedFiles: readonly string[]
  /**
   * False when module loads could not be observed (Node without module.registerHooks): shared
   * inputs are then incomplete and no record of the run is evidence.
   */
  readonly loadsObserved: boolean
  /**
   * Paths the process wrote (global setup's caches and generated files). What it created during
   * the run is a product of shared inputs, not an input of any test.
   */
  readonly writes?: readonly string[]
  /**
   * What the process read on behalf of one project only (its global setup, see
   * MainRecorder.scoped), by project name: inputs of that project's checks, not of every check.
   */
  readonly scoped?: Readonly<Record<string, ScopedObservations>>
}

/** Reads the main process made within one project's scope. */
export interface ScopedObservations {
  readonly paths: MainObservations['paths']
  readonly env: MainObservations['env']
  readonly loadedFiles: readonly string[]
}

interface Bucket {
  readonly paths: Map<string, { p: string; kind: PathKind; type: PathType }>
  readonly env: Map<string, Digest | null>
  readonly files: Set<string>
}

const NODE_MODULES = `${path.sep}node_modules${path.sep}`

/** The package root of a file inside node_modules (handles scopes and nested node_modules). */
export function packageRootOf(file: string): string | null {
  const at = file.lastIndexOf(NODE_MODULES)
  if (at < 0) return null
  const rest = file.slice(at + NODE_MODULES.length).split(path.sep)
  const depth = rest[0]?.startsWith('@') ? 2 : 1
  if (rest.length <= depth) return null
  return file.slice(0, at + NODE_MODULES.length) + rest.slice(0, depth).join(path.sep)
}

/**
 * Records what the runner's main process reads: configuration files, env files, module
 * resolution probes and environment variables. These are shared inputs of every check in the run.
 */
export class MainRecorder implements HookSink {
  private readonly pathMap = new Map<string, { p: string; kind: PathKind; type: PathType }>()
  private readonly written = new Set<string>()
  private readonly envMap = new Map<string, Digest | null>()
  private readonly envWritten = new Set<string>()
  private readonly packages = new Set<string>()
  private readonly files = new Set<string>()
  /** The project whose work is running (see scoped), carried across its asynchronous work. */
  private readonly scope = new AsyncLocalStorage<string>()
  /** Set within work whose reads are no input (see unrecorded), carried across its async work. */
  private readonly ignoring = new AsyncLocalStorage<true>()
  private readonly buckets = new Map<string, Bucket>()
  private hooks: { deregister(): void } | null = null
  private loadsObserved = false
  /** The environment as it was when capture was created, before the runner changed anything. */
  readonly initialEnv: Readonly<Record<string, string | undefined>>
  private readonly volatileEnv: RegExp
  private readonly baseline: Record<string, Digest | null>
  private active = false
  /** While positive, reads and environment accesses are not inputs (see pause). */
  private paused = 0

  constructor(options: { root: string; ignoredPrefixes: readonly string[]; volatileEnv: RegExp }) {
    this.volatileEnv = options.volatileEnv
    installHooks({ root: options.root, ignoredPrefixes: options.ignoredPrefixes, observeSource: false })
    this.initialEnv = unobserved(() => ({ ...process.env }))
    this.baseline = unobserved(() => {
      const out: Record<string, Digest | null> = {}
      for (const [n, v] of Object.entries(process.env))
        if (!this.volatileEnv.test(n)) out[n] = hashEnvValue(v)
      return out
    })
  }

  start(): void {
    this.active = true
    setSink(this)
    const register = (module as unknown as { registerHooks?: (hooks: object) => { deregister(): void } })
      .registerHooks
    this.loadsObserved = typeof register === 'function'
    if (register && !this.hooks) {
      this.hooks = register({
        load: (url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown) => {
          if (this.active && url.startsWith('file:')) {
            const file = fileURLToPath(url)
            const root = packageRootOf(file)
            if (root) this.packages.add(path.join(root, 'package.json'))
            else if (!this.files.has(file)) (this.bucket()?.files ?? this.files).add(file)
          }
          return nextLoad(url, context)
        },
      })
    }
  }

  /**
   * Stops recording reads and environment accesses until the returned function is called. For
   * runner work whose reads are not inputs of any check, such as crawling the repository to index
   * files (Jest's haste map reads every source file to extract dependencies).
   */
  pause(): () => void {
    this.paused++
    let resumed = false
    return () => {
      if (!resumed) this.paused--
      resumed = true
    }
  }

  /**
   * Runs `fn` on behalf of one project: what it and the asynchronous work it starts read are
   * inputs of that project's checks only (a project's global setup). Work the process does
   * meanwhile for anything else stays a shared input of every check.
   */
  scoped<T>(project: string, fn: () => T): T {
    return this.scope.run(project, fn)
  }

  /**
   * Runs `fn` without recording what it and the asynchronous work it starts read: speculative
   * runner work such as Vite pre-transforming the imports of a module it transformed. Unlike pause,
   * reads the process makes meanwhile for other work are still recorded.
   */
  unrecorded<T>(fn: () => T): T {
    return this.ignoring.run(true, fn)
  }

  /**
   * Adds files the process executed outside Node's loader (a module runner's global setup), for
   * `project` only or, without one, for every check.
   */
  executed(files: Iterable<string>, project?: string): void {
    const into = project === undefined ? this.files : this.scoped(project, () => this.bucket()!.files)
    for (const file of files) if (!this.files.has(file)) into.add(file)
  }

  private bucket(): Bucket | undefined {
    const name = this.scope.getStore()
    if (name === undefined) return undefined
    let bucket = this.buckets.get(name)
    if (!bucket) {
      bucket = { paths: new Map(), env: new Map(), files: new Set() }
      this.buckets.set(name, bucket)
    }
    return bucket
  }

  stop(): MainObservations {
    this.active = false
    setSink(null)
    this.hooks?.deregister()
    this.hooks = null
    return {
      loadedPackages: [...this.packages].sort(),
      loadedFiles: [...this.files].sort(),
      loadsObserved: this.loadsObserved,
      // A path the process itself wrote is its own output (a cache, a report), not an input.
      paths: [...this.pathMap.values()].filter((o) => !this.written.has(o.p)),
      env: [...this.envMap].map(([n, h]) => ({ n, h })),
      envBaseline: this.baseline,
      writes: [...this.written],
      scoped: Object.fromEntries(
        [...this.buckets].map(([name, b]) => [
          name,
          {
            paths: [...b.paths.values()].filter((o) => !this.written.has(o.p)),
            env: [...b.env].map(([n, h]) => ({ n, h })),
            loadedFiles: [...b.files].sort(),
          },
        ]),
      ),
    }
  }

  seen(absolute: string, kind: PathKind): boolean {
    const key = `${kind}\u0000${absolute}`
    return this.written.has(absolute) || this.pathMap.has(key) || (this.bucket()?.paths.has(key) ?? false)
  }
  path(absolute: string, kind: PathKind, type: PathType): void {
    if (!this.active || this.paused > 0 || this.written.has(absolute) || this.ignoring.getStore()) return
    const key = `${kind}\u0000${absolute}`
    if (this.pathMap.has(key)) return
    const into = this.bucket()?.paths ?? this.pathMap
    if (!into.has(key)) into.set(key, { p: absolute, kind, type })
  }
  write(absolute: string): void {
    if (this.active) this.written.add(absolute)
  }
  env(name: string, value: string | undefined, copying: boolean): void {
    // The runner copies the whole environment to hand it to workers; workers record what tests read.
    if (copying) return
    if (
      !this.active ||
      this.paused > 0 ||
      this.ignoring.getStore() ||
      this.envMap.has(name) ||
      this.envWritten.has(name) ||
      this.volatileEnv.test(name)
    )
      return
    const into = this.bucket()?.env ?? this.envMap
    if (!into.has(name)) into.set(name, hashEnvValue(value))
  }
  envEnumerated(): void {}
  envWrite(name: string): void {
    // Values the process set itself derive from its code and configuration, not from the environment.
    this.envWritten.add(name)
  }
  net(): void {}
  spawn(): void {}
  packageName(): void {}
  dlopen(): void {}
  sourceObserved(): void {}
}
