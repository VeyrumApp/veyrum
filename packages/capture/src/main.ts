import type { Digest } from '@veyrum/core/hash'
import { hashEnvValue } from '@veyrum/core/state'
import { type HookSink, installHooks, type PathKind, type PathType, setSink, unobserved } from './hooks.ts'

export interface MainObservations {
  readonly paths: readonly { readonly p: string; readonly kind: PathKind; readonly type: PathType }[]
  readonly env: readonly { readonly n: string; readonly h: Digest | null }[]
  /** Every non-volatile variable present when capture started, name to value digest. */
  readonly envBaseline: Readonly<Record<string, Digest | null>>
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
  /** The environment as it was when capture was created, before the runner changed anything. */
  readonly initialEnv: Readonly<Record<string, string | undefined>>
  private readonly volatileEnv: RegExp
  private readonly baseline: Record<string, Digest | null>
  private active = false

  constructor(options: { ignoredPrefixes: readonly string[]; volatileEnv: RegExp }) {
    this.volatileEnv = options.volatileEnv
    installHooks({ ignoredPrefixes: options.ignoredPrefixes, observeSource: false })
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
  }

  stop(): MainObservations {
    this.active = false
    setSink(null)
    return {
      paths: [...this.pathMap.values()],
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
    this.written.add(absolute)
  }
  env(name: string, value: string | undefined): void {
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
