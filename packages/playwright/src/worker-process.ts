import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { unobserved, VOLATILE_ENV } from '@veyrum/capture'
import { beginWorkerCapture, type WorkerCapture } from '@veyrum/capture/worker'
import { BrowserObserver, loadPlaywrightCore } from './browser.ts'
import { observeListening } from './listen.ts'
import { type PlaywrightCaptureConfig, SCRATCH } from './protocol.ts'
import { SPAWN_FUNCTIONS, spawnedProgram } from './spawn.ts'

interface Message {
  readonly method?: string
  readonly params?: {
    readonly id?: number
    readonly method?: string
    readonly params?: { readonly file?: string }
    readonly runnerParams?: { readonly workerIndex?: number; readonly projectId?: string }
  }
}

/**
 * In a Playwright worker: makes it run one test group (a file, or part of one) and captures that.
 *
 * Playwright reuses a worker for the next group of the same project. A worker that already ran a
 * group answers the next one as done without running any of its tests: the runner then queues those
 * tests again and starts a fresh worker for them (as it does after a failure). So each worker process
 * runs exactly one group, and everything it does belongs to that group's file.
 *
 * Capture starts when the group arrives, before the worker loads the configuration and the file, and
 * ends when the worker exits, after its worker fixtures were torn down.
 */
export function startWorker(config: PlaywrightCaptureConfig): void {
  const cp = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>
  const originals = new Map(SPAWN_FUNCTIONS.map((name) => [name, cp[name]!] as const))
  let projectId: string | undefined
  let group: 'none' | 'starting' | 'running' = 'none'
  const held: unknown[][] = []
  const emit = process.emit
  const deliver = (args: unknown[]): boolean => (emit as (...a: unknown[]) => boolean).apply(process, args)

  process.emit = function (this: NodeJS.Process, event: string | symbol, ...rest: unknown[]) {
    if (event !== 'message') return deliver([event, ...rest])
    const message = rest[0] as Message | undefined
    if (group === 'starting') {
      held.push([event, ...rest])
      return true
    }
    if (message?.method === '__init__') {
      const params = message.params?.runnerParams
      // Not a worker (Playwright's out-of-process test loader): nothing to capture.
      if (params?.workerIndex === undefined) process.emit = emit
      projectId = params?.projectId
    }
    if (message?.method === '__dispatch__' && message.params?.method === 'runTestGroup') {
      if (group !== 'none') {
        decline(message.params.id)
        return true
      }
      group = 'starting'
      const file = message.params.params?.file ?? ''
      void begin(config, projectId ?? '', file, originals).finally(() => {
        group = 'running'
        deliver([event, ...rest])
        for (const args of held.splice(0)) (process.emit as (...a: unknown[]) => boolean).apply(process, args)
      })
      return true
    }
    return deliver([event, ...rest])
  } as typeof process.emit
}

/** Answers a test group as done without running it; the runner runs it in a fresh worker. */
function decline(id: number | undefined): void {
  process.send?.({
    method: '__dispatch__',
    params: { method: 'done', params: { fatalErrors: [], skipTestsDueToSetupFailure: [] } },
  })
  if (id !== undefined) process.send?.({ method: '__dispatch__', params: { id, result: undefined } })
}

function uncaptured(config: PlaywrightCaptureConfig): Set<string> {
  return unobserved(() => {
    try {
      return new Set(
        JSON.parse(fs.readFileSync(path.join(config.scratch, SCRATCH.uncaptured), 'utf8')) as string[],
      )
    } catch {
      return new Set<string>()
    }
  })
}

async function begin(
  config: PlaywrightCaptureConfig,
  projectId: string,
  file: string,
  originals: ReadonlyMap<string, (...args: unknown[]) => unknown>,
): Promise<void> {
  if (!file || uncaptured(config).has(`${projectId}\u0000${file}`)) return
  const outDir = path.join(config.scratch, SCRATCH.capture)
  let capture: WorkerCapture
  try {
    capture = await beginWorkerCapture({
      root: config.root,
      outDir,
      ignoredPrefixes: config.ignored,
      volatileEnv: VOLATILE_ENV,
      layout: 'node',
    })
  } catch {
    // Without capture the file runs as usual and records nothing (it is then not reusable).
    return
  }
  const browser = new BrowserObserver({ blobDir: path.join(outDir, 'blobs') })
  observeListening((port) => browser.listening(port))

  // Browsers run outside capture's hooks: what they run is observed through the browser itself,
  // and their binaries are inputs.
  const cp = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const name of SPAWN_FUNCTIONS) {
    const hooked = cp[name]!
    const original = originals.get(name)!
    cp[name] = function (this: unknown, ...args: unknown[]) {
      const program = unobserved(() => spawnedProgram(name, args))
      if (!program.browser) return hooked.apply(this, args)
      browser.executable(program.file)
      return original.apply(this, args)
    }
  }
  syncBuiltinESMExports()

  const core = unobserved(() => loadPlaywrightCore(process.argv[1] ?? ''))
  if (core) core._instrumentation.addListener(browser.listener)
  else browser.fail('browsers could not be observed: playwright-core was not found')

  // Playwright's worker exits with process.exit once its fixtures are torn down; the payload is
  // written first. A worker that is killed writes none, and its file is not reusable.
  const exit = process.exit
  let finishing = false
  process.exit = ((code?: number | string | null) => {
    if (finishing) return undefined as never
    finishing = true
    void (async () => {
      try {
        await browser.finish()
        const report = browser.report({ pid: process.pid, projectId, file })
        unobserved(() => {
          const dir = path.join(config.scratch, SCRATCH.browser)
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify(report))
        })
        await capture.finish(file, { added: 0, updated: 0 })
      } catch {
        // A failure only loses this file's evidence (it is then not reusable), never the exit code.
      }
    })().finally(() => exit.call(process, code as number))
    return undefined as never
  }) as typeof process.exit
}
