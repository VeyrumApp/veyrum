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

function install(): void {
  const raw = process.env.VEYRUM_JEST_CAPTURE
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
