import path from 'node:path'

export const SPAWN_FUNCTIONS = [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
] as const
export type SpawnFunction = (typeof SPAWN_FUNCTIONS)[number]

/**
 * Flags Playwright launches its browsers with, to drive them over a pipe: Chromium's, Firefox's
 * (Juggler) and WebKit's.
 */
const BROWSER_FLAGS = ['--remote-debugging-pipe', '-juggler-pipe', '--inspector-pipe']
const BROWSER_CACHE = `${path.sep}ms-playwright${path.sep}`
const PLAYWRIGHT_PACKAGE = /[\\/]node_modules[\\/](playwright|playwright-core|@playwright[\\/][^\\/]+)[\\/]/

export interface SpawnedProgram {
  /** A browser Playwright launches (or a helper it installed with them, such as ffmpeg). */
  readonly browser: boolean
  /** The program, as started (a browser's executable). */
  readonly file: string
  /** One of Playwright's own processes: a worker or test loader. */
  readonly playwright: boolean
  readonly options: Record<string, unknown> | undefined
  /** The call's arguments, with the environment replaced by setEnv. */
  readonly args: unknown[]
  setEnv(env: NodeJS.ProcessEnv): void
}

function isOptions(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What a child_process call starts, read from its arguments. */
export function spawnedProgram(name: SpawnFunction, args: unknown[]): SpawnedProgram {
  const file = String(args[0] ?? '')
  const shell = name === 'exec' || name === 'execSync'
  const list = !shell && Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : []
  const at = shell ? 1 : Array.isArray(args[1]) ? 2 : 1
  let current = [...args]
  const options = isOptions(args[at]) ? args[at] : undefined
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
  const browser =
    !shell &&
    (list.some((a) => BROWSER_FLAGS.includes(a)) ||
      file.includes(BROWSER_CACHE) ||
      (browsersPath !== undefined &&
        browsersPath !== '0' &&
        file.startsWith(path.resolve(browsersPath) + path.sep)))
  const playwright = name === 'fork' && PLAYWRIGHT_PACKAGE.test(file)
  return {
    browser,
    file,
    playwright,
    options,
    get args() {
      return current
    },
    setEnv(env) {
      const next = [...current]
      if (options) next[at] = { ...options, env }
      else if (shell || !Array.isArray(args[1])) next.splice(1, 0, { env })
      else next.splice(2, 0, { env })
      current = next
    },
  }
}
