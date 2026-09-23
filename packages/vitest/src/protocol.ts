/** Configuration handed from the Veyrum main process to Vitest workers via VEYRUM_CAPTURE. */
export interface CaptureConfig {
  readonly root: string
  readonly outDir: string
  /** Absolute path prefixes whose files are never recorded (Veyrum's own code). */
  readonly ignored: readonly string[]
  /** File URL of the target project's `vitest` entry, so hooks register on the right runner. */
  readonly vitestEntry: string
}

export const CAPTURE_ENV = 'VEYRUM_CAPTURE'

export const PENDING_KEY = Symbol.for('veyrum.vitest.pending')

export function readCaptureConfig(): CaptureConfig | null {
  const raw = process.env[CAPTURE_ENV]
  if (!raw) return null
  try {
    return JSON.parse(raw) as CaptureConfig
  } catch {
    return null
  }
}
