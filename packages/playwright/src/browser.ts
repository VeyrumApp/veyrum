import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { unobserved } from '@veyrum/capture'
import { digest } from '@veyrum/core/hash'
import type { BrowserExchange, BrowserReport, BrowserScript } from './protocol.ts'

/** The parts of Playwright's client objects this uses. */
interface Request {
  url(): string
  method(): string
  resourceType(): string
}
interface Response {
  request(): Request
  status(): number
  serverAddr(): Promise<{ ipAddress: string; port: number } | null>
  body(): Promise<Buffer>
}
interface CDPSession {
  send(method: string, params?: object): Promise<any>
  on(event: string, listener: (event: any) => void): unknown
  detach(): Promise<void>
}
interface Routable {
  route?: (url: unknown, handler: RouteHandler, options?: unknown) => Promise<void>
  unroute?: (url: unknown, handler?: RouteHandler) => Promise<void>
}
type RouteHandler = (route: Route, request: Request) => unknown
interface Route {
  request(): Request
  [method: string]: unknown
}
interface Page extends Routable {
  on(event: string, listener: (...args: any[]) => void): unknown
  context(): Context
  close: (...args: unknown[]) => Promise<void>
}
interface Context extends Routable {
  browser(): Browser | null
  pages(): Page[]
  newPage: (...args: unknown[]) => Promise<Page>
  on(event: string, listener: (...args: any[]) => void): unknown
  newCDPSession(page: Page): Promise<CDPSession>
}
interface Browser {
  browserType(): { name(): string }
  contexts(): Context[]
  newBrowserCDPSession(): Promise<CDPSession>
  close: (...args: unknown[]) => Promise<void>
}

/** Playwright's client instrumentation, which Playwright Test itself uses to follow contexts. */
export interface PlaywrightCore {
  readonly _instrumentation: {
    addListener(listener: object): void
    removeListener(listener: object): void
  }
}

/**
 * The playwright-core instance Playwright's own code in this process uses: resolved from its
 * entry file (a worker's entry lives in the playwright package, the CLI in @playwright/test).
 */
export function loadPlaywrightCore(fromFile: string): PlaywrightCore | null {
  const attempts = [
    (): string => createRequire(fromFile).resolve('playwright-core'),
    (): string =>
      createRequire(createRequire(fromFile).resolve('playwright/package.json')).resolve('playwright-core'),
  ]
  for (const attempt of attempts) {
    try {
      const core = createRequire(fromFile)(attempt()) as PlaywrightCore
      if (core?._instrumentation) return core
    } catch {
      // Try the next way.
    }
  }
  return null
}

const LOOPBACK = /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|0\.0\.0\.0)$/i
const NETWORK = new Set(['http:', 'https:', 'ws:', 'wss:'])
/** Resource types whose bodies are never scripts or documents: not compared with repository files. */
const OPAQUE_TYPES = new Set(['image', 'media', 'font'])

export function isLoopback(host: string): boolean {
  return LOOPBACK.test(host)
}

/** Where a request went: by its URL, or by the address it reached when that is a loopback one. */
function locate(url: string, reached?: { ipAddress: string; port: number } | null): BrowserExchange | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!NETWORK.has(u.protocol)) return null
  const secure = u.protocol === 'https:' || u.protocol === 'wss:'
  const port = u.port ? Number(u.port) : secure ? 443 : 80
  const clean = `${u.origin}${u.pathname}${u.search}`
  if (isLoopback(u.hostname)) return { url: clean, host: u.hostname, port, local: true }
  // A name mapped to a loopback address (hosts file, resolver rules) reached a local server.
  if (reached && isLoopback(reached.ipAddress))
    return { url: clean, host: reached.ipAddress, port: reached.port, local: true }
  return { url: clean, host: u.hostname, port, local: false }
}

interface ScriptState {
  readonly url: string
  /** Parsed before coverage started: what ran before is unknown. */
  readonly early: boolean
  covered: boolean
  readonly executed: Map<string, [number, number]>
}

interface PageState {
  readonly page: Page
  /** Its coverage is collected (a Chromium page, in a test worker). */
  readonly coverage: boolean
  readonly scripts: Map<string, ScriptState>
  session: CDPSession | null
  ready: boolean
  taken: boolean
  closed: boolean
  /** Documents committed per frame before coverage started. */
  readonly early: Map<unknown, number>
  /** Settles once coverage started (or failed to). */
  started: Promise<void>
}

/**
 * Follows the browsers a process drives, through Playwright's client instrumentation: every browser
 * context from its creation, every page from its creation. It records where each request went and
 * digests the bodies of local responses (what the browser received from a server), and, with a
 * blob directory, collects each Chromium page's JavaScript coverage over its own DevTools session:
 * which functions of which served scripts ran.
 *
 * Coverage misses what ran before it started, and what ran in another renderer process (a
 * cross-site frame, a worker, a page whose process changed) or in a page closed without it being
 * taken: such cases mark the observation incomplete, and every served script then counts whole.
 */
export class BrowserObserver {
  private readonly blobDir: string | null
  private readonly exchanges: BrowserExchange[] = []
  private readonly scripts: BrowserScript[] = []
  private readonly incomplete = new Set<string>()
  private readonly unobservedBrowsers = new Set<string>()
  private readonly errors: string[] = []
  private readonly executables = new Set<string>()
  private readonly listens = new Set<number>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly pages = new Set<PageState>()
  private readonly browsers = new WeakSet<object>()
  private readonly contexts = new WeakSet<object>()
  /** Requests a route handler answered or aborted: they never reached the network. */
  private readonly handled = new WeakSet<object>()
  /** Requests not yet answered: at the end, they count as reaching their URL. */
  private readonly open = new Set<Request>()

  constructor(options: { readonly blobDir: string | null }) {
    this.blobDir = options.blobDir
  }

  readonly listener = {
    runAfterCreateBrowserContext: async (context: Context): Promise<void> => {
      await this.guard(() => this.observeContext(context))
    },
    runBeforeCloseBrowserContext: async (context: Context): Promise<void> => {
      await this.guard(async () => {
        for (const page of this.pages) if (page.page.context() === context) await this.take(page)
        // Response bodies can no longer be read once their context is closed.
        await this.settle()
      })
    },
  }

  fail(message: string): void {
    this.errors.push(message)
  }

  executable(file: string): void {
    this.executables.add(file)
  }

  listening(port: number): void {
    this.listens.add(port)
  }

  /** Takes the coverage of every page still open and waits for pending observations. */
  async finish(): Promise<void> {
    for (const page of this.pages) await this.guard(() => this.take(page))
    await this.settle()
    for (const request of this.open) if (!this.handled.has(request)) this.exchange(locate(request.url()))
    this.open.clear()
  }

  report(identity: { pid: number; projectId?: string; file?: string }): BrowserReport {
    return {
      ...identity,
      executables: [...this.executables],
      unobservedBrowsers: [...this.unobservedBrowsers],
      incomplete: [...this.incomplete],
      exchanges: this.exchanges,
      scripts: this.scripts,
      listens: [...this.listens],
      errors: this.errors,
    }
  }

  private async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  private async guard(fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn()
    } catch (error) {
      this.errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
    }
  }

  private track(promise: Promise<unknown>): void {
    const settled = promise.catch((error: unknown) => {
      this.errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
    })
    this.pending.add(settled)
    void settled.finally(() => this.pending.delete(settled))
  }

  private exchange(entry: BrowserExchange | null): void {
    if (entry) this.exchanges.push(entry)
  }

  private browserName(context: Context): string {
    const browser = context.browser()
    if (browser) return browser.browserType().name()
    // A persistent context has no browser object; its type is kept on the context.
    const type = (context as unknown as { _browserType?: { name(): string } })._browserType
    return type?.name() ?? 'unknown'
  }

  private async observeContext(context: Context): Promise<void> {
    if (this.contexts.has(context)) return
    this.contexts.add(context)
    const name = this.browserName(context)
    const coverage = this.blobDir !== null && name === 'chromium'
    if (name !== 'chromium') this.unobservedBrowsers.add(name)
    this.patchRoutes(context)
    context.on('request', (request: Request) => {
      if (this.blobDir === null) this.exchange(locate(request.url()))
      else this.open.add(request)
    })
    if (this.blobDir !== null) {
      context.on('response', (response: Response) => this.track(this.onResponse(response)))
      context.on('requestfailed', (request: Request) => {
        this.open.delete(request)
        if (!this.handled.has(request)) this.exchange(locate(request.url()))
      })
    }
    context.on('page', (page: Page) => this.observePage(page, coverage))
    for (const page of context.pages()) this.observePage(page, coverage)
    // A page the test opens runs nothing before its coverage starts (a popup a page opens may).
    const newPage = context.newPage
    if (coverage && typeof newPage === 'function')
      context.newPage = async (...args: unknown[]) => {
        const page = await newPage.apply(context, args)
        await [...this.pages].find((p) => p.page === page)?.started
        return page
      }
    const browser = context.browser()
    if (coverage && browser) await this.observeBrowser(browser)
    else if (coverage)
      this.incomplete.add('a persistent browser context (its workers and frames are not followed)')
  }

  private async onResponse(response: Response): Promise<void> {
    const request = response.request()
    this.open.delete(request)
    const reached = await response.serverAddr().catch(() => null)
    // No address: a route handler, the cache or a service worker answered, not the network.
    if (!reached) return
    const entry = locate(request.url(), reached)
    if (!entry) return
    const status = response.status()
    const hasBody =
      request.method() !== 'HEAD' && status >= 200 && status !== 204 && (status < 300 || status >= 400)
    const type = request.resourceType()
    if (!entry.local || !hasBody || OPAQUE_TYPES.has(type)) {
      this.exchanges.push({ ...entry, resourceType: type })
      return
    }
    const body = await response.body().then(
      (bytes) => digest(bytes),
      () => null,
    )
    this.exchanges.push({ ...entry, resourceType: type, body })
  }

  /** Routes answered by the test never reach the network: route handlers are told apart. */
  private patchRoutes(target: Routable): void {
    const route = target.route
    const unroute = target.unroute
    if (typeof route !== 'function') return
    const wrapped = new WeakMap<RouteHandler, RouteHandler>()
    const observer = this
    target.route = function (this: unknown, url: unknown, handler: RouteHandler, options?: unknown) {
      let inner = wrapped.get(handler)
      if (!inner) {
        inner = (r: Route, request: Request) => handler(observer.tapRoute(r), request)
        wrapped.set(handler, inner)
      }
      return route.call(target, url, inner, options)
    }
    if (typeof unroute === 'function')
      target.unroute = function (this: unknown, url: unknown, handler?: RouteHandler) {
        return unroute.call(target, url, handler ? (wrapped.get(handler) ?? handler) : handler)
      }
  }

  private tapRoute(route: Route): Route {
    for (const method of ['abort', 'fulfill']) {
      const original = route[method]
      if (typeof original !== 'function') continue
      route[method] = (...args: unknown[]) => {
        this.handled.add(route.request())
        return (original as (...a: unknown[]) => unknown).apply(route, args)
      }
    }
    return route
  }

  private async observeBrowser(browser: Browser): Promise<void> {
    if (this.browsers.has(browser)) return
    this.browsers.add(browser)
    const close = browser.close
    browser.close = async (...args: unknown[]) => {
      await this.guard(async () => {
        for (const page of this.pages) await this.take(page)
      })
      return close.apply(browser, args)
    }
    // Every target of the browser: frames in other processes and workers run code coverage of the
    // page's own process does not see.
    const session = await browser.newBrowserCDPSession()
    session.on('Target.targetCreated', (event: { targetInfo: { type: string; url: string } }) => {
      const { type, url } = event.targetInfo
      if (type !== 'page' && type !== 'browser' && type !== 'tab')
        this.incomplete.add(`a ${type.replace(/_/g, ' ')} ran (${url || 'no URL'})`)
    })
    await session.send('Target.setDiscoverTargets', { discover: true })
  }

  private observePage(page: Page, coverage: boolean): void {
    if ([...this.pages].some((p) => p.page === page)) return
    const state: PageState = {
      page,
      coverage,
      scripts: new Map(),
      session: null,
      ready: false,
      taken: false,
      closed: false,
      early: new Map(),
      started: Promise.resolve(),
    }
    this.pages.add(state)
    this.patchRoutes(page)
    page.on('websocket', (socket: { url(): string }) => this.exchange(locate(socket.url())))
    if (!coverage) return
    page.on('framenavigated', (frame: { url(): string }) => {
      if (state.ready || frame.url().startsWith('about:')) return
      const documents = (state.early.get(frame) ?? 0) + 1
      state.early.set(frame, documents)
      if (documents > 1) this.incomplete.add('a page navigated before its coverage started')
    })
    page.on('close', () => {
      state.closed = true
      if (!state.taken) this.incomplete.add('a page closed before its coverage was taken')
    })
    const close = page.close
    page.close = async (...args: unknown[]) => {
      await this.guard(() => this.take(state))
      return close.apply(page, args)
    }
    state.started = this.startCoverage(state)
    this.track(state.started)
  }

  private async startCoverage(state: PageState): Promise<void> {
    let session: CDPSession
    try {
      session = await state.page.context().newCDPSession(state.page)
    } catch (error) {
      if (!state.closed) this.incomplete.add(`coverage of a page could not start (${String(error)})`)
      return
    }
    state.session = session
    let enabling = true
    session.on('Debugger.scriptParsed', (event: { scriptId: string; url: string }) => {
      if (state.scripts.has(event.scriptId)) {
        // The same id twice: the page runs in a new renderer process, whose earlier coverage is lost.
        this.incomplete.add('a page changed renderer process')
        return
      }
      state.scripts.set(event.scriptId, {
        url: event.url,
        early: enabling,
        covered: false,
        executed: new Map(),
      })
    })
    // A `debugger` statement must not stop the page: nothing here pauses it on purpose.
    session.on('Debugger.paused', () => void session.send('Debugger.resume').catch(() => {}))
    try {
      await session.send('Profiler.enable')
      await session.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
      // Reports the scripts already parsed first: they ran before coverage started.
      await session.send('Debugger.enable')
      enabling = false
      await session.send('Debugger.setSkipAllPauses', { skip: true })
      state.ready = true
    } catch (error) {
      if (!state.closed) this.incomplete.add(`coverage of a page could not start (${String(error)})`)
    }
  }

  private async take(state: PageState): Promise<void> {
    if (state.taken || !state.coverage) return
    state.taken = true
    await state.started
    const session = state.session
    if (!session || !state.ready) {
      if (session || !state.closed) this.incomplete.add('coverage of a page never started')
      return
    }
    try {
      const { result } = (await session.send('Profiler.takePreciseCoverage')) as {
        result: {
          scriptId: string
          url: string
          functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[]
        }[]
      }
      for (const entry of result) {
        const script = state.scripts.get(entry.scriptId)
        if (!script || script.url !== entry.url) continue
        script.covered = true
        for (const fn of entry.functions) {
          const range = fn.ranges[0]
          if (!range || range.count === 0) continue
          script.executed.set(`${range.startOffset}:${range.endOffset}`, [range.startOffset, range.endOffset])
        }
      }
      for (const [scriptId, script] of state.scripts) {
        const where = locate(script.url)
        if (!where?.local) continue
        const { scriptSource } = (await session.send('Debugger.getScriptSource', { scriptId })) as {
          scriptSource: string
        }
        const code = digest(scriptSource)
        this.writeBlob(code, scriptSource)
        this.scripts.push({
          url: where.url,
          code,
          precise: !script.early && script.covered,
          executed: script.covered ? [...script.executed.values()] : [],
        })
      }
    } catch (error) {
      this.incomplete.add(`the coverage of a page could not be taken (${String(error)})`)
    }
    await session.detach().catch(() => {})
  }

  private writeBlob(code: string, source: string): void {
    const dir = this.blobDir
    if (!dir) return
    unobserved(() => {
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${code}.js`)
      if (!fs.existsSync(file)) fs.writeFileSync(file, source)
    })
  }
}
