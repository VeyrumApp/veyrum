/**
 * Loaded into Jest's worker processes (through the execArgv they inherit) and into the main
 * process for tests run in band. For every test file, jest-runner creates the project's script
 * transformer and loads the file's environment with it: the configured one, or the one a
 * `@jest-environment` docblock names. That load is Jest's own (a TypeScript or ESM environment is
 * transformed as usual); what it returns is then wrapped by Veyrum's environment wrapper
 * (environment.cts), which captures the file.
 *
 * Self-contained: no relative imports. Does nothing outside a Veyrum run.
 */
interface PreloadConfig {
  /** jest-resolve as jest-runner resolves it, which resolves docblock environments. */
  environmentResolver: string
  /** @jest/transform as jest-runner resolves it. */
  runnerTransform: string
  /** The environment wrapper, loaded natively (see environment.cts). */
  environmentPath: string
  /** The environments the projects configured. */
  environments: Record<string, string>
}

type Resolve = (options: { testEnvironment: string } & Record<string, unknown>) => string

interface Transformer {
  requireAndTranspileModule(moduleName: string, ...rest: unknown[]): Promise<unknown>
}
type CreateTransformer = (...args: unknown[]) => Promise<Transformer>

interface Wrapper {
  /** Installs capture's hooks, so the environment's own loads are recorded. */
  prepare(): void
  /** The environment class, wrapped; anything else as it is. */
  wrap(loaded: unknown): unknown
}

const PATCHED = Symbol.for('veyrum.jest.transformPatched')

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
  if (globals[PATCHED]) return
  require(config.runnerTransform)
  const cached = require.cache[config.runnerTransform]
  const original = (cached?.exports as { createScriptTransformer?: CreateTransformer } | undefined)
    ?.createScriptTransformer
  if (!cached || typeof original !== 'function') return
  globals[PATCHED] = true
  // The modules jest-runner loads as environments: the configured ones, and those docblocks name,
  // noted as jest-runner resolves them (just before it loads them).
  const environments = new Set(Object.values(config.environments))
  noteDocblockEnvironments(config.environmentResolver, environments)
  let wrapper: Wrapper | null = null
  const loadWrapper = (): Wrapper => {
    wrapper ??= require(config.environmentPath) as Wrapper
    return wrapper
  }
  // @jest/transform's exports are getters that cannot be redefined. jest-runner requires the
  // module lazily, on its first test, so a copy put in the module cache now is what it gets.
  const { createScriptTransformer: _, ...descriptors } = Object.getOwnPropertyDescriptors(cached.exports)
  const patched = Object.defineProperties({}, descriptors)
  Object.defineProperty(patched, 'createScriptTransformer', {
    enumerable: true,
    configurable: true,
    value: async (...args: unknown[]): Promise<Transformer> => {
      const transformer = await original(...args)
      const load = transformer.requireAndTranspileModule.bind(transformer)
      transformer.requireAndTranspileModule = async (moduleName: string, ...rest: unknown[]) => {
        if (!environments.has(moduleName)) return load(moduleName, ...rest)
        const w = loadWrapper()
        w.prepare()
        return w.wrap(await load(moduleName, ...rest))
      }
      return transformer
    },
  })
  cached.exports = patched
}

/** Notes the environments docblocks name, as jest-runner resolves them; the result is unchanged. */
function noteDocblockEnvironments(resolver: string, environments: Set<string>): void {
  require(resolver)
  const cached = require.cache[resolver]
  const original = (cached?.exports as { resolveTestEnvironment?: Resolve } | undefined)
    ?.resolveTestEnvironment
  if (!cached || typeof original !== 'function') return
  // Same as for @jest/transform: a copy of the exports, in the module cache before jest-runner's
  // first test requires it.
  const { resolveTestEnvironment: _, ...descriptors } = Object.getOwnPropertyDescriptors(cached.exports)
  const patched = Object.defineProperties({}, descriptors)
  Object.defineProperty(patched, 'resolveTestEnvironment', {
    enumerable: true,
    configurable: true,
    value: (options: Parameters<Resolve>[0]): string => {
      const resolved = original(options)
      environments.add(resolved)
      return resolved
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
