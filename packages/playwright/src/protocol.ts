import type { MainObservations } from '@veyrum/capture'

/**
 * What the Veyrum process and the processes of a Playwright run exchange. The preload (preload.ts)
 * is loaded into every Node process of the run through NODE_OPTIONS and takes its role from
 * ROLE_ENV: Playwright's main process, a worker, an app server, or nothing.
 */

/** Configuration handed to every process of the run (JSON). */
export interface PlaywrightCaptureConfig {
  readonly root: string
  /** The run's scratch directory (see the paths below). */
  readonly scratch: string
  /** Absolute path prefixes whose files are never recorded (Veyrum's own code, scratch, store). */
  readonly ignored: readonly string[]
}

export const CONFIG_ENV = 'VEYRUM_PLAYWRIGHT'
/**
 * `main` for the process Veyrum starts, `server` for programs Playwright's main process starts
 * (the webServer, and programs global setup starts), `child` for everything else. The main
 * process sets it to `child` for its own children, so only the process Veyrum started is main.
 */
export const ROLE_ENV = 'VEYRUM_PLAYWRIGHT_ROLE'
/** The main process's pid: Playwright's workers are its children. */
export const MAIN_PID_ENV = 'VEYRUM_PLAYWRIGHT_MAIN'

/** Called (on globalThis) by the reporter once Playwright's main process has loaded the tests. */
export const TESTS_LOADED = Symbol.for('veyrum.playwright.testsLoaded')

/** Files in the scratch directory. */
export const SCRATCH = {
  /** Capture output of workers (payloads/, blobs/, traces/), as capture's outDir. */
  capture: 'capture',
  /** Test groups that run without capture: `${projectId}\u0000${file}` per entry (JSON array). */
  uncaptured: 'uncaptured.json',
  /** One BrowserReport per worker process, named by pid. */
  browser: 'browser',
  /** Lines appended by app server processes: `L <port>` for a listening port, `C <path>` for code. */
  server: 'server',
  /** Lines `<port> <ancestor pids>` logged by other Node programs of the run that listen. */
  children: 'children',
  /** The native trace of every program the main process started as an app server. */
  serverTrace: 'server-trace.log',
  /** The native trace of every program the project's own code started in the main process. */
  setupTrace: 'setup-trace.log',
  /** One MainReport per main (or loader) process, named by pid. */
  main: 'main',
  /** What the outcome reporter writes. */
  outcomes: 'outcomes.json',
  /** What the list reporter writes. */
  list: 'list.json',
} as const

/** One network exchange of a browser, or a connection it tried. */
export interface BrowserExchange {
  readonly url: string
  readonly host: string
  readonly port: number
  /** A loopback address. */
  readonly local: boolean
  readonly resourceType?: string
  /**
   * Digest of the response body: absent when no body was read (no body, or a resource type whose
   * bodies are not compared), null when the body could not be read.
   */
  readonly body?: string | null
}

/** A script a page ran that was served from a loopback address. */
export interface BrowserScript {
  readonly url: string
  /** Digest of the script source; the source is in the capture blobs, named by it. */
  readonly code: string
  /**
   * Every execution of the script was observed by coverage (it was parsed after coverage started
   * and its page's coverage was taken): `executed` lists what ran. Otherwise the script counts whole.
   */
  readonly precise: boolean
  readonly executed: readonly (readonly [number, number])[]
}

/** What one process observed of the browsers it drove. */
export interface BrowserReport {
  readonly pid: number
  /** Worker: the test group's project id and file (absolute). */
  readonly projectId?: string
  readonly file?: string
  /** Browser executables launched (their binaries are inputs). */
  readonly executables: readonly string[]
  /** Browsers whose execution cannot be observed (not Chromium), by name. */
  readonly unobservedBrowsers: readonly string[]
  /** Why coverage may have missed an execution: then every script counts whole. */
  readonly incomplete: readonly string[]
  readonly exchanges: readonly BrowserExchange[]
  readonly scripts: readonly BrowserScript[]
  /** Ports this process listened on (a server the test started itself). */
  readonly listens: readonly number[]
  /** Errors in the observation itself: the file's evidence is then incomplete. */
  readonly errors: readonly string[]
}

/**
 * Programs Playwright's main process starts: app servers (its webServer plugin), whose inputs count
 * for the files that talked to them, and programs the project's own code starts (global setup),
 * whose inputs count for every file.
 */
export type Started = 'server' | 'setup'

export interface StartedPrograms {
  /** Programs that could not be traced. */
  readonly untraced: string[]
  /** Their environment, as far as it came from the main process's. */
  readonly env: readonly { readonly n: string; readonly h: string | null }[]
  /** The programs themselves, and the lookups that found them. */
  readonly paths: { readonly p: string; readonly kind: string; readonly type: string }[]
}

/** What Playwright's main process observed, beyond its reads (see MainObservations). */
export interface MainReport {
  readonly pid: number
  readonly observations: MainObservations
  readonly started: Readonly<Record<Started, StartedPrograms>>
  /** Ports servers inside the main process listened on (global setup can start one in process). */
  readonly listens: readonly number[]
  readonly browser: BrowserReport | null
}

/** What the outcome reporter writes. */
export interface ReportedRun {
  readonly status: string
  /** Errors outside any test (a webServer that failed to start, a failing global setup). */
  readonly errors: number
  readonly files: readonly ReportedFile[]
}

export interface ReportedFile {
  readonly file: string
  readonly project: string
  readonly durationMs: number
  readonly tests: readonly {
    readonly name: string
    readonly state: 'passed' | 'failed' | 'skipped' | 'pending'
    readonly durationMs: number
    readonly retries: number
    /** Playwright's outcome: expected, unexpected, flaky or skipped. */
    readonly outcome: string
  }[]
}

/** What the list reporter writes. */
export interface ListedRun {
  readonly version: string
  readonly configFile: string | null
  readonly projects: readonly { readonly id: string; readonly name: string }[]
  readonly tests: readonly { readonly file: string; readonly projectId: string; readonly project: string }[]
  readonly errors: readonly string[]
}
