import inspector from 'node:inspector'
import { Session } from 'node:inspector/promises'

/**
 * V8 keeps one precise-coverage state per isolate. When two inspector sessions each start precise
 * coverage, every take resets the counts (or marks the functions) the other would have reported,
 * and a stop turns coverage off for both. Veyrum's capture and a project's own coverage (Vitest's
 * v8 provider, Jest's v8 coverage) therefore share one session, the hub's: coverage calls from other
 * sessions are served by it. Every take is handed to every consumer, and each consumer's take
 * returns everything reported since its own last take, so neither misses an execution.
 */

export interface ScriptCoverage {
  readonly scriptId: string
  readonly url: string
  readonly functions: readonly {
    readonly functionName?: string
    readonly isBlockCoverage?: boolean
    readonly ranges: readonly {
      readonly startOffset: number
      readonly endOffset: number
      readonly count: number
    }[]
  }[]
}

export interface CoverageMode {
  readonly callCount: boolean
  readonly detailed: boolean
}

/** Sessions the hub itself owns: their calls reach the inspector untouched. */
const own = new WeakSet<object>()

class CoverageHub {
  private session: Session | null = null
  private mode: CoverageMode = { callCount: false, detailed: false }
  /** Results reported since each consumer's last take. */
  private readonly pending = new Map<object, ScriptCoverage[]>()
  /** Consumers that held coverage while its mode changed (see disturbed). */
  private readonly changedUnder = new Set<object>()
  private queue: Promise<unknown> = Promise.resolve()

  /** Runs operations one at a time: a take must not interleave with a mode change or a stop. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  /**
   * Starts coverage for a consumer, at least in the mode it asks for, and returns the hub's
   * session. `beforeStart` runs on a new session before coverage starts.
   */
  acquire(
    consumer: object,
    mode: CoverageMode,
    beforeStart?: (session: Session) => Promise<void>,
  ): Promise<Session> {
    return this.serial(async () => {
      if (!this.session) {
        const session = new Session()
        own.add(session)
        session.connect()
        if (beforeStart) await beforeStart(session)
        await session.post('Profiler.enable')
        await session.post('Profiler.startPreciseCoverage', { ...mode })
        this.session = session
        this.mode = mode
      } else if ((mode.callCount && !this.mode.callCount) || (mode.detailed && !this.mode.detailed)) {
        // Changing the mode resets V8's counts: hand out what they hold first. From binary to count
        // coverage, V8 also stops reporting functions compiled before the change.
        await this.collect()
        for (const other of this.pending.keys()) if (other !== consumer) this.changedUnder.add(other)
        this.mode = {
          callCount: this.mode.callCount || mode.callCount,
          detailed: this.mode.detailed || mode.detailed,
        }
        await this.session.post('Profiler.startPreciseCoverage', { ...this.mode })
      }
      if (!this.pending.has(consumer)) this.pending.set(consumer, [])
      return this.session
    })
  }

  /** Everything reported since the consumer's last take. */
  take(consumer: object): Promise<ScriptCoverage[]> {
    return this.serial(async () => {
      await this.collect()
      const out = this.pending.get(consumer) ?? []
      if (this.pending.has(consumer)) this.pending.set(consumer, [])
      return out
    })
  }

  /** Ends a consumer's coverage; the session stops once no consumer is left. */
  release(consumer: object): Promise<void> {
    return this.serial(async () => {
      this.pending.delete(consumer)
      this.changedUnder.delete(consumer)
      if (this.pending.size > 0 || !this.session) return
      const session = this.session
      this.session = null
      this.mode = { callCount: false, detailed: false }
      try {
        await session.post('Profiler.stopPreciseCoverage')
        await session.post('Profiler.disable')
      } catch {
        // Nothing to clean up if the session already failed.
      }
      session.disconnect()
    })
  }

  /**
   * Stops and restarts coverage in the same mode, releasing the functions V8 pinned for it, after
   * handing out what it reported. `beforeStart` runs in between.
   */
  restart(beforeStart?: (session: Session) => Promise<void>): Promise<void> {
    return this.serial(async () => {
      if (!this.session) return
      await this.collect()
      await this.session.post('Profiler.stopPreciseCoverage')
      if (beforeStart) await beforeStart(this.session)
      await this.session.post('Profiler.startPreciseCoverage', { ...this.mode })
    })
  }

  /**
   * Whether the coverage mode changed while the consumer held coverage, since it last asked: its
   * takes may then miss executions of functions compiled before the change.
   */
  disturbed(consumer: object): boolean {
    const changed = this.changedUnder.has(consumer)
    this.changedUnder.delete(consumer)
    return changed
  }

  /** Drops what was reported for a consumer since its last take, without taking. */
  discard(consumer: object): void {
    if (this.pending.has(consumer)) this.pending.set(consumer, [])
  }

  private async collect(): Promise<void> {
    if (!this.session) return
    const { result } = (await this.session.post('Profiler.takePreciseCoverage')) as {
      result: ScriptCoverage[]
    }
    if (result.length === 0) return
    for (const list of this.pending.values()) list.push(...result)
  }

  /** Serves a coverage call from another session, or returns null to let it through. */
  serve(session: object, method: string, params: unknown): Promise<unknown> | null {
    const p = (params ?? {}) as { callCount?: boolean; detailed?: boolean }
    switch (method) {
      case 'Profiler.startPreciseCoverage':
        return this.acquire(session, { callCount: p.callCount === true, detailed: p.detailed === true }).then(
          () => ({ timestamp: performance.now() / 1000 }),
        )
      case 'Profiler.takePreciseCoverage':
        return this.take(session).then((result) => ({ result, timestamp: performance.now() / 1000 }))
      case 'Profiler.stopPreciseCoverage':
        return this.release(session).then(() => ({}))
      default:
        return null
    }
  }
}

const HUB_KEY = Symbol.for('veyrum.coverageHub')

/** The isolate's hub; installing it routes other sessions' coverage calls through it. */
export function coverageHub(): CoverageHub {
  const g = globalThis as unknown as Record<symbol, CoverageHub | undefined>
  let hub = g[HUB_KEY]
  if (!hub) {
    hub = new CoverageHub()
    g[HUB_KEY] = hub
    route(hub)
  }
  return hub
}

type Callback = (error: Error | null, result?: unknown) => void

function route(hub: CoverageHub): void {
  // node:inspector/promises defines its own post, which calls the callback version it captured when
  // it loaded: both are replaced. A call handled by one never reaches the other.
  const callbackProto = inspector.Session.prototype as unknown as {
    post: (this: object, method: string, params?: unknown, callback?: Callback) => void
  }
  const callbackPost = callbackProto.post
  callbackProto.post = function (this: object, method: string, params?: unknown, callback?: Callback) {
    if (typeof params === 'function') {
      callback = params as Callback
      params = undefined
    }
    const served = own.has(this) ? null : hub.serve(this, method, params)
    if (!served) return callbackPost.call(this, method, params, callback)
    served.then(
      (result) => callback?.(null, result),
      (error: unknown) => callback?.(error instanceof Error ? error : new Error(String(error))),
    )
  }
  const promiseProto = Session.prototype as unknown as {
    post: (this: object, method: string, params?: unknown) => Promise<unknown>
  }
  const promisePost = promiseProto.post
  promiseProto.post = function (this: object, method: string, params?: unknown) {
    const served = own.has(this) ? null : hub.serve(this, method, params)
    return served ?? promisePost.call(this, method, params)
  }
}
