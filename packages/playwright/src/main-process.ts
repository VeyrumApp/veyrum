import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { MainRecorder, type PathKind, type PathType, unobserved, VOLATILE_ENV } from '@veyrum/capture'
import { hashEnvValue, normalizeAbsolute } from '@veyrum/core'
import { BrowserObserver, loadPlaywrightCore } from './browser.ts'
import { observeListening } from './listen.ts'
import {
  type ListedRun,
  type MainReport,
  type PlaywrightCaptureConfig,
  ROLE_ENV,
  SCRATCH,
  type Started,
  type StartedPrograms,
  TESTS_LOADED,
} from './protocol.ts'
import { SPAWN_FUNCTIONS, type SpawnFunction, spawnedProgram } from './spawn.ts'

/**
 * Records what Playwright's main process reads (configuration, its imports, environment files,
 * global setup): shared inputs of every test file. Programs it starts as app servers, or from the
 * project's own code, run traced, each kind into its own log; its workers, browsers and
 * Playwright's own helpers are left alone.
 */
class PlaywrightMainRecorder extends MainRecorder {
  /** What is being started now, outermost first (exec starts through execFile and spawn). */
  readonly starting: Started[] = []
  readonly started: Record<Started, Omit<StartedPrograms, 'env'> & { env: Map<string, string | null> }> = {
    server: { untraced: [], env: new Map(), paths: [] },
    setup: { untraced: [], env: new Map(), paths: [] },
  }
  private readonly traces: Record<Started, string>
  private readonly tests: ReadonlySet<string>
  private loading: 'before' | 'loading' | 'after' = 'before'
  private resume = (): void => {}

  constructor(
    options: ConstructorParameters<typeof MainRecorder>[0],
    traces: Record<Started, string>,
    tests: ReadonlySet<string>,
  ) {
    super(options)
    this.traces = traces
    this.tests = tests
  }

  /**
   * Playwright's main process loads the test files to list their tests, after global setup and
   * before any test runs. What that reads, each file's worker reads again and records for that file
   * alone: it is no shared input. Recording pauses from the first read of a test file (Playwright
   * reads each to compile it) until the reporter learns the tests (see reporter.ts).
   */
  testsLoaded(): void {
    if (this.loading === 'loading') this.resume()
    this.loading = 'after'
  }

  /** The kind of program being started now, or null. */
  private get current(): Started | null {
    return this.starting[0] ?? null
  }

  traceLog(): string | null {
    const current = this.current
    return current ? this.traces[current] : null
  }

  override path(absolute: string, kind: PathKind, type: PathType): void {
    if (this.loading === 'before' && kind === 'read' && this.tests.has(absolute)) {
      this.loading = 'loading'
      this.resume = this.pause()
    }
    const current = this.current
    if (current) this.started[current].paths.push({ p: absolute, kind, type })
    else super.path(absolute, kind, type)
  }

  override env(name: string, value: string | undefined, copying: boolean): void {
    const current = this.current
    if (!current) {
      super.env(name, value, copying)
      return
    }
    // Veyrum's own variables, and NODE_OPTIONS, which carries its preload (the project's own
    // NODE_OPTIONS is part of the runtime key).
    if (VOLATILE_ENV.test(name) || name === 'NODE_OPTIONS') return
    const env = this.started[current].env
    if (!env.has(name)) env.set(name, hashEnvValue(value))
  }

  override spawn(command?: string): void {
    const current = this.current
    if (current) this.started[current].untraced.push(command ?? '')
  }
}

/** Stack frames of Playwright's webServer plugin, which starts the configured app servers. */
const WEB_SERVER_FRAME = /webServerPlugin|WebServerPlugin/

/**
 * What a program the main process starts is: an app server Playwright's webServer plugin starts, a
 * program the project's own code starts (global setup, configuration), or neither: Playwright's
 * workers, its browsers and its other helpers (git for report metadata).
 */
function startedAs(config: PlaywrightCaptureConfig): Started | null {
  const stack = new Error().stack ?? ''
  if (WEB_SERVER_FRAME.test(stack)) return 'server'
  const root = config.root + path.sep
  for (const line of stack.split('\n').slice(1)) {
    const match = /\(?((?:file:\/\/)?\/[^():]+|[A-Za-z]:\\[^():]+):\d+:\d+\)?$/.exec(line.trim())
    const file = match?.[1]?.replace(/^file:\/\//, '')
    if (!file?.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) continue
    if (config.ignored.some((p) => file.startsWith(p))) continue
    return 'setup'
  }
  return null
}

function startedPrograms(
  programs: Omit<StartedPrograms, 'env'> & { env: Map<string, string | null> },
): StartedPrograms {
  return {
    untraced: programs.untraced,
    env: [...programs.env].map(([n, h]) => ({ n, h })),
    paths: programs.paths,
  }
}

/** The test files Playwright was asked to run (listed before the run), as absolute paths. */
function listedTests(config: PlaywrightCaptureConfig): Set<string> {
  try {
    const text = unobserved(() => fs.readFileSync(path.join(config.scratch, SCRATCH.list), 'utf8'))
    return new Set((JSON.parse(text) as ListedRun).tests.map((t) => normalizeAbsolute(t.file)))
  } catch {
    return new Set()
  }
}

export function startMain(config: PlaywrightCaptureConfig): void {
  const originals = new Map<SpawnFunction, (...args: unknown[]) => unknown>()
  const cp = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const name of SPAWN_FUNCTIONS) originals.set(name, cp[name]!)

  const recorder = new PlaywrightMainRecorder(
    { root: config.root, ignoredPrefixes: config.ignored, volatileEnv: VOLATILE_ENV },
    {
      server: path.join(config.scratch, SCRATCH.serverTrace),
      setup: path.join(config.scratch, SCRATCH.setupTrace),
    },
    listedTests(config),
  )
  recorder.start()
  // Resumes recording once Playwright has loaded the tests (see PlaywrightMainRecorder.path).
  ;(globalThis as Record<symbol, unknown>)[TESTS_LOADED] = () => recorder.testsLoaded()
  const listens = new Set<number>()
  observeListening((port) => listens.add(port))

  // Wraps the hooked functions: servers and setup programs are started through them (traced),
  // browsers through the originals (their execution is observed through the browser instead),
  // everything else through the hooks, which report it to the recorder (which ignores it).
  for (const name of SPAWN_FUNCTIONS) {
    const hooked = cp[name]!
    const original = originals.get(name)!
    cp[name] = function (this: unknown, ...args: unknown[]) {
      const program = unobserved(() => spawnedProgram(name, args))
      if (program.browser) return original.apply(this, args)
      const kind = program.playwright ? null : unobserved(() => startedAs(config))
      if (!kind) return hooked.apply(this, args)
      const env = program.options?.env as NodeJS.ProcessEnv | undefined
      const restore = unobserved(() => {
        if (env) {
          program.setEnv({ ...env, [ROLE_ENV]: 'server' })
          return null
        }
        // The child inherits this process's environment.
        const before = process.env[ROLE_ENV]
        process.env[ROLE_ENV] = 'server'
        return before
      })
      // A setup program can start a server too: every program started here logs its ports.
      recorder.starting.push(kind)
      try {
        return hooked.apply(this, program.args)
      } finally {
        recorder.starting.pop()
        if (restore !== null)
          unobserved(() => {
            if (restore === undefined) delete process.env[ROLE_ENV]
            else process.env[ROLE_ENV] = restore
          })
      }
    }
  }
  syncBuiltinESMExports()

  // Browsers global setup drives: only where they connect (see BrowserObserver).
  const browser = new BrowserObserver({ blobDir: null })
  const core = unobserved(() => loadPlaywrightCore(process.argv[1] ?? ''))
  if (core) core._instrumentation.addListener(browser.listener)
  else browser.fail('the main process could not observe browsers')

  // Without this report no file's evidence is reusable (the main process's reads are unknown); it
  // never changes the exit code.
  process.on('exit', () => {
    try {
      const observations = recorder.stop()
      const report: MainReport = {
        pid: process.pid,
        observations,
        started: {
          server: startedPrograms(recorder.started.server),
          setup: startedPrograms(recorder.started.setup),
        },
        listens: [...listens],
        browser: browser.report({ pid: process.pid }),
      }
      const { mkdirSync, writeFileSync } = fs
      const dir = path.join(config.scratch, SCRATCH.main)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify(report))
    } catch {
      // The run's scratch directory is gone: nothing to record into.
    }
  })
}
