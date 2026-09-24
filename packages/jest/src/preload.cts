/**
 * Loaded into Jest's worker processes (through the execArgv they inherit) and into the main
 * process for tests run in band. A test file can pick its own environment with a
 * `@jest-environment` docblock, which Jest resolves with jest-resolve's resolveTestEnvironment in
 * place of the configured one: without this, such a file would bypass Veyrum's environment
 * wrapper and never be captured. Every environment resolution for a docblock now returns the
 * wrapper, and the wrapper loads the environment the docblock names (see environment.cts).
 *
 * Self-contained: no relative imports. Does nothing outside a Veyrum run.
 */
interface PreloadConfig {
  environmentResolver: string
  environmentPath: string
}

type Resolve = (options: { testEnvironment: string } & Record<string, unknown>) => string

const ORIGINAL = Symbol.for('veyrum.jest.resolveTestEnvironment')

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

function install(): void {
  const raw = takeConfig('VEYRUM_JEST_CAPTURE')
  if (!raw) return
  let config: PreloadConfig
  try {
    config = JSON.parse(raw) as PreloadConfig
  } catch {
    return
  }
  const globals = globalThis as Record<symbol, unknown>
  if (globals[ORIGINAL]) return
  require(config.environmentResolver)
  const cached = require.cache[config.environmentResolver]
  const exports = cached?.exports as { resolveTestEnvironment?: Resolve } | undefined
  const original = exports?.resolveTestEnvironment
  if (!cached || typeof original !== 'function') return
  globals[ORIGINAL] = original
  // jest-resolve's exports are getters that cannot be redefined. jest-runner requires the module
  // lazily, on its first test, so a copy put in the module cache now is what it gets.
  const { resolveTestEnvironment: _, ...descriptors } = Object.getOwnPropertyDescriptors(cached.exports)
  const patched = Object.defineProperties({}, descriptors)
  Object.defineProperty(patched, 'resolveTestEnvironment', {
    enumerable: true,
    configurable: true,
    value: (options: Parameters<Resolve>[0]): string => {
      const resolved = original(options)
      // The wrapper resolves the docblock's environment itself, with the original function. An
      // environment that needs Jest's transform (TypeScript) keeps Jest's own path: the file then
      // runs as it would without Veyrum, and is not captured.
      return /\.c?js$/.test(resolved) ? config.environmentPath : resolved
    },
  })
  cached.exports = patched
}

install()

// Tests see the execArgv they would without Veyrum, and the processes they fork do not load this.
if (!(process as unknown as Record<symbol, unknown>)[Symbol.for('veyrum.main')]) {
  const at = process.execArgv.indexOf(__filename)
  if (at > 0 && process.execArgv[at - 1] === '--require') process.execArgv.splice(at - 1, 2)
}
