/**
 * Wraps each test environment jest-runner loads (see preload.cts), configured or named by a
 * docblock, and captures the inputs of every test file it hosts. Jest constructs one environment
 * per test file, calls setup before the file's setup files and modules run, and teardown after its
 * tests: that window is the file's capture.
 *
 * The run copies this file under a node_modules directory in the project, and the preload loads it
 * through Node's native loader: no project transform touches it or Veyrum's capture modules. It
 * must therefore stay self-contained: no relative imports.
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

function captureOptions(): CaptureWorker.WorkerCaptureOptions {
  const { index } = loadCapture()
  return {
    root: config.root,
    outDir: config.outDir,
    ignoredPrefixes: config.ignored,
    volatileEnv: index.VOLATILE_ENV,
    layout: 'jest',
    ...(config.projectCoverage ? { projectCoverage: true } : {}),
  }
}

/**
 * Called before jest-runner loads an environment: with the hooks installed first, the modules the
 * environment loads are recorded as toolchain inputs of the run, so editing a custom environment
 * (configured, or named by a docblock) invalidates the files that ran in it.
 */
function prepare(): void {
  loadCapture().worker.prepareWorkerHooks(captureOptions())
}

const wrapped = new WeakMap<EnvironmentClass, EnvironmentClass>()

/**
 * The environment class jest-runner loaded, wrapped: constructing it returns the environment's own
 * instance with setup and teardown wrapped, so everything else (globals, export conditions, test
 * event handlers) is the project's own environment, untouched. Anything that is not an
 * environment class is returned as it is.
 */
function wrap(loaded: unknown): unknown {
  if (
    typeof loaded !== 'function' ||
    typeof (loaded.prototype as { getVmContext?: unknown })?.getVmContext !== 'function'
  )
    return loaded
  const Base = loaded as EnvironmentClass
  let Wrapped = wrapped.get(Base)
  if (!Wrapped) {
    Wrapped = function VeyrumEnvironment(envConfig: EnvironmentConfig, context: EnvironmentContext) {
      return captured(Base, envConfig, context)
    } as unknown as EnvironmentClass
    Wrapped.prototype = Base.prototype
    wrapped.set(Base, Wrapped)
  }
  return Wrapped
}

function captured(
  Base: EnvironmentClass,
  envConfig: EnvironmentConfig,
  context: EnvironmentContext,
): JestEnvironmentLike {
  const { index, worker } = loadCapture()
  const options = captureOptions()
  // Hooks first: the environment copies `process` (and its environment) into the test context.
  worker.prepareWorkerHooks(options)
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

module.exports = { prepare, wrap }
