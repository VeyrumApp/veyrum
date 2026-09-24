/**
 * Jest test environment that wraps each project's own environment and captures the inputs of every
 * test file it hosts. Jest constructs one environment per test file, calls setup before the file's
 * setup files and modules run, and teardown after its tests: that window is the file's capture.
 *
 * The run copies this file into its scratch directory, under a node_modules directory so that no
 * project transform applies to it. It must therefore stay self-contained: no relative imports.
 *
 * Loading order is deliberate:
 * - the configured environments load at module load, inside Jest's transpiling require, exactly
 *   as Jest itself would load them (a TypeScript environment is transformed the same way);
 * - Veyrum's capture modules load later, from the constructor, through Node's native loader, so
 *   no project transform ever touches them.
 */
import type * as Capture from '@veyrum/capture' with { 'resolution-mode': 'import' }
import type * as CaptureWorker from '@veyrum/capture/worker' with { 'resolution-mode': 'import' }

interface CaptureConfig {
  root: string
  outDir: string
  ignored: string[]
  captureIndex: string
  captureWorker: string
  resolver: string
  environments: Record<string, string>
  preload: string
  projectCoverage?: boolean
}

interface EnvironmentConfig {
  projectConfig: { id: string; rootDir: string } & Record<string, unknown>
}

interface EnvironmentContext {
  testPath: string
  docblockPragmas?: Record<string, string | string[]>
}

interface JestEnvironmentLike {
  global: {
    process?: { env: Record<string, string | undefined>; execArgv?: string[] }
    Function?: FunctionConstructor
  }
  setup(): Promise<void>
  teardown(): Promise<void>
}

type EnvironmentClass = new (config: EnvironmentConfig, context: EnvironmentContext) => JestEnvironmentLike

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

const raw = takeConfig('VEYRUM_JEST_CAPTURE')
if (!raw) throw new Error('Veyrum: the Jest environment wrapper was loaded outside a Veyrum run')
const config = JSON.parse(raw) as CaptureConfig
const { createRequire } = require('node:module') as typeof import('node:module')
const nativeRequire = createRequire(__filename)

/** The files Veyrum has workers load (see run.ts): the configuration, then the preload. */
const OWN_FLAGS = new Set([config.preload, require('node:path').join(config.outDir, 'config.cjs')])

function withoutOwnFlags(execArgv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < execArgv.length; i++) {
    if (execArgv[i] === '--require' && OWN_FLAGS.has(execArgv[i + 1] ?? '')) i++
    else out.push(execArgv[i]!)
  }
  return out
}

function interop(loaded: unknown): EnvironmentClass {
  const m = loaded as { __esModule?: boolean; default?: unknown }
  const candidate = typeof m === 'function' ? m : m?.default
  if (typeof candidate !== 'function')
    throw new Error('Veyrum: a configured Jest environment exports no class')
  return candidate as EnvironmentClass
}

/**
 * Environments load on first use, after the worker's hooks are installed: the modules they load
 * are then recorded as toolchain inputs of the run, so editing a custom environment (configured,
 * or named by a docblock) invalidates the files that ran in it.
 */
const loadedEnvironments = new Map<string, EnvironmentClass>()
function loadEnvironment(file: string): EnvironmentClass {
  let loaded = loadedEnvironments.get(file)
  if (!loaded) {
    loaded = interop(require(file))
    loadedEnvironments.set(file, loaded)
  }
  return loaded
}

let capture: { index: typeof Capture; worker: typeof CaptureWorker } | null = null
function loadCapture(): { index: typeof Capture; worker: typeof CaptureWorker } {
  if (!capture) {
    capture = {
      index: nativeRequire(config.captureIndex) as typeof Capture,
      worker: nativeRequire(config.captureWorker) as typeof CaptureWorker,
    }
    const resolver = nativeRequire(config.resolver) as { default?: unknown }
    capture.worker.observeJestResolver(
      (resolver.default ?? resolver) as Parameters<typeof CaptureWorker.observeJestResolver>[0],
    )
  }
  return capture
}

/**
 * The environment a `@jest-environment` docblock names, resolved as Jest would (the preload made
 * Jest hand the file to this wrapper instead). Environments written in TypeScript would need
 * Jest's transform, which this native loader cannot apply.
 */
type Resolve = (options: Record<string, unknown>) => string
function docblockEnvironment(name: string, envConfig: EnvironmentConfig): EnvironmentClass {
  const resolve = (globalThis as Record<symbol, unknown>)[Symbol.for('veyrum.jest.resolveTestEnvironment')] as
    | Resolve
    | undefined
  if (!resolve) throw new Error('Veyrum: a docblock environment was requested without the Veyrum preload')
  // The preload only redirects JavaScript environments here.
  return loadEnvironment(
    resolve({
      ...envConfig.projectConfig,
      requireResolveFunction: (m: string) => require.resolve(m),
      testEnvironment: name,
    }),
  )
}

/**
 * Constructed by Jest with `new`. Returns the configured environment's instance with setup and
 * teardown wrapped, so everything else (globals, export conditions, test event handlers) is the
 * project's own environment, untouched.
 */
function VeyrumEnvironment(envConfig: EnvironmentConfig, context: EnvironmentContext): JestEnvironmentLike {
  const { index, worker } = loadCapture()
  const options: CaptureWorker.WorkerCaptureOptions = {
    root: config.root,
    outDir: config.outDir,
    ignoredPrefixes: config.ignored,
    volatileEnv: index.VOLATILE_ENV,
    layout: 'jest',
    ...(config.projectCoverage ? { projectCoverage: true } : {}),
  }
  // Hooks first: the environment module's loads are recorded, and the environment copies
  // `process` (and its environment) into the test context.
  worker.prepareWorkerHooks(options)
  const pragma = context.docblockPragmas?.['jest-environment']
  const configured = config.environments[envConfig.projectConfig.id]
  if (typeof pragma !== 'string' && !configured)
    throw new Error(`Veyrum: no environment recorded for Jest project ${envConfig.projectConfig.id}`)
  const Base =
    typeof pragma === 'string' ? docblockEnvironment(pragma, envConfig) : loadEnvironment(configured!)
  const env = new Base(envConfig, context)
  const testProcess = env.global.process
  // Tests see the execArgv they would without Veyrum. The context has a copy of this process's,
  // which keeps Veyrum's flags when it starts workers (tests run in band).
  if (testProcess?.execArgv) testProcess.execArgv = withoutOwnFlags(testProcess.execArgv)
  // Test code reads the context's copy of process.env, not the worker's.
  if (testProcess) testProcess.env = index.observeEnv(testProcess.env, 'test')
  // Functions defined in the test context inherit that realm's Function.prototype.
  if (env.global.Function) index.observeSourceIn(env.global.Function)

  let pending: Promise<CaptureWorker.WorkerCapture> | null = null
  const setup = env.setup.bind(env)
  const teardown = env.teardown.bind(env)
  // A file whose evidence is still valid runs plain: its record already describes this execution.
  // The coverage session kept across files ends, since it slows everything the worker runs.
  const plain = worker.uncapturedFiles(config.outDir).has(context.testPath)
  env.setup = async () => {
    if (plain) {
      await worker.endWorkerCapture()
    } else {
      pending = worker.beginWorkerCapture(options)
      await pending
    }
    await setup()
  }
  env.teardown = async () => {
    try {
      // Snapshot writes are reported by the runner's results, not observed here.
      if (pending) await (await pending).finish(context.testPath, { added: 0, updated: 0 })
    } finally {
      pending = null
      await teardown()
    }
  }
  return env
}

module.exports = VeyrumEnvironment
