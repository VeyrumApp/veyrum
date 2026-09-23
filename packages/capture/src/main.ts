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
}

const NODE_MODULES = `${path.sep}node_modules${path.sep}`

/** The package root of a file inside node_modules (handles scopes and nested node_modules). */
function packageRootOf(file: string): string | null {
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
  private hooks: { deregister(): void } | null = null
  /** The environment as it was when capture was created, before the runner changed anything. */
  readonly initialEnv: Readonly<Record<string, string | undefined>>
  private readonly volatileEnv: RegExp
  private readonly baseline: Record<string, Digest | null>
  private active = false

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
    if (register && !this.hooks) {
      this.hooks = register({
        load: (url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown) => {
          if (this.active && url.startsWith('file:')) {
            const root = packageRootOf(fileURLToPath(url))
            if (root) this.packages.add(path.join(root, 'package.json'))
          }
          return nextLoad(url, context)
        },
      })
    }
  }

  stop(): MainObservations {
    this.active = false
    setSink(null)
    this.hooks?.deregister()
    this.hooks = null
    return {
      loadedPackages: [...this.packages].sort(),
      // A path the process itself wrote is its own output (a cache, a report), not an input.
      paths: [...this.pathMap.values()].filter((o) => !this.written.has(o.p)),
      env: [...this.envMap].map(([n, h]) => ({ n, h })),
      envBaseline: this.baseline,
    }
  }

  path(absolute: string, kind: PathKind, type: PathType): void {
    if (!this.active || this.written.has(absolute)) return
    const key = `${kind}\u0000${absolute}`
    if (!this.pathMap.has(key)) this.pathMap.set(key, { p: absolute, kind, type })
  }
  write(absolute: string): void {
    if (this.active) this.written.add(absolute)
  }
  env(name: string, value: string | undefined, copying: boolean): void {
    // The runner copies the whole environment to hand it to workers; workers record what tests read.
    if (copying) return
    if (!this.active || this.envMap.has(name) || this.envWritten.has(name) || this.volatileEnv.test(name))
      return
    this.envMap.set(name, hashEnvValue(value))
  }
  envEnumerated(): void {}
  envWrite(name: string): void {
    // Values the process set itself derive from its code and configuration, not from the environment.
    this.envWritten.add(name)
  }
  net(): void {}
  spawn(): void {}
  dlopen(): void {}
  sourceObserved(): void {}
}
