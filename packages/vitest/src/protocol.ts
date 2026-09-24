/** Configuration handed from the Veyrum main process to Vitest workers via VEYRUM_CAPTURE. */
export interface CaptureConfig {
  readonly root: string
  readonly outDir: string
  /** Absolute path prefixes whose files are never recorded (Veyrum's own code). */
  readonly ignored: readonly string[]
  /** File URL of the target project's `vitest` entry, so hooks register on the right runner. */
  readonly vitestEntry: string
  /** Absolute paths of Veyrum's capture modules, loaded natively by the setup file. */
  readonly captureIndex: string
  readonly captureWorker: string
  /** The project collects its own V8 coverage in this run (see WorkerCaptureOptions). */
  readonly projectCoverage?: boolean
}

export const CAPTURE_ENV = 'VEYRUM_CAPTURE'

export const PENDING_KEY = Symbol.for('veyrum.vitest.pending')

/**
 * The run's configuration, from the variable Veyrum's main process sets for its workers. In a
 * worker it is then removed from the environment, so tests and the programs they start see the
 * environment they would without Veyrum; later readers in this process, in any realm, get it from
 * `process`.
 */
function takeConfig(name: string): string | undefined {
  const holder = process as unknown as Record<symbol, unknown>
  const key = Symbol.for(`veyrum.config.${name}`)
  const taken = holder[key] as string | undefined
  if (taken !== undefined) return taken
  const raw = process.env[name]
  if (raw === undefined) return undefined
  holder[key] = raw
  if (!holder[Symbol.for('veyrum.main')]) delete process.env[name]
  return raw
}

/** Marks Veyrum's main process, which keeps the variable for the workers it starts. */
export const MAIN_KEY = Symbol.for('veyrum.main')

export function readCaptureConfig(): CaptureConfig | null {
  const raw = takeConfig(CAPTURE_ENV)
  if (!raw) return null
  try {
    return JSON.parse(raw) as CaptureConfig
  } catch {
    return null
  }
}
