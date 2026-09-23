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
  environments: Record<string, string>
}

interface EnvironmentConfig {
  projectConfig: { id: string }
}

interface EnvironmentContext {
  testPath: string
}

interface JestEnvironmentLike {
  global: { process?: { env: Record<string, string | undefined> }; Function?: FunctionConstructor }
  setup(): Promise<void>
  teardown(): Promise<void>
}

type EnvironmentClass = new (config: EnvironmentConfig, context: EnvironmentContext) => JestEnvironmentLike

const raw = process.env.VEYRUM_JEST_CAPTURE
if (!raw) throw new Error('Veyrum: the Jest environment wrapper was loaded outside a Veyrum run')
const config = JSON.parse(raw) as CaptureConfig
const { createRequire } = require('node:module') as typeof import('node:module')
const nativeRequire = createRequire(__filename)

function interop(loaded: unknown): EnvironmentClass {
  const m = loaded as { __esModule?: boolean; default?: unknown }
  const candidate = typeof m === 'function' ? m : m?.default
  if (typeof candidate !== 'function')
    throw new Error('Veyrum: a configured Jest environment exports no class')
  return candidate as EnvironmentClass
}

const environments = new Map<string, EnvironmentClass>()
for (const [id, file] of Object.entries(config.environments)) environments.set(id, interop(require(file)))

let capture: { index: typeof Capture; worker: typeof CaptureWorker } | null = null
function loadCapture(): { index: typeof Capture; worker: typeof CaptureWorker } {
  capture ??= {
    index: nativeRequire(config.captureIndex) as typeof Capture,
    worker: nativeRequire(config.captureWorker) as typeof CaptureWorker,
  }
  return capture
}

/**
 * Constructed by Jest with `new`. Returns the configured environment's instance with setup and
 * teardown wrapped, so everything else (globals, export conditions, test event handlers) is the
 * project's own environment, untouched.
 */
function VeyrumEnvironment(envConfig: EnvironmentConfig, context: EnvironmentContext): JestEnvironmentLike {
  const Base = environments.get(envConfig.projectConfig.id)
  if (!Base) throw new Error(`Veyrum: no environment recorded for Jest project ${envConfig.projectConfig.id}`)
  const { index, worker } = loadCapture()
  const options: CaptureWorker.WorkerCaptureOptions = {
    root: config.root,
    outDir: config.outDir,
    ignoredPrefixes: config.ignored,
    volatileEnv: index.VOLATILE_ENV,
    layout: 'jest',
  }
  // Hooks first: the environment copies `process` (and its environment) into the test context.
  worker.prepareWorkerHooks(options)
  const env = new Base(envConfig, context)
  const testProcess = env.global.process
  // Test code reads the context's copy of process.env, not the worker's.
  if (testProcess) testProcess.env = index.observeEnv(testProcess.env, 'test')
  // Functions defined in the test context inherit that realm's Function.prototype.
  if (env.global.Function) index.observeSourceIn(env.global.Function)

  let pending: Promise<CaptureWorker.WorkerCapture> | null = null
  const setup = env.setup.bind(env)
  const teardown = env.teardown.bind(env)
  env.setup = async () => {
    pending = worker.beginWorkerCapture(options)
    await pending
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
