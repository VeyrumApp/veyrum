import fs from 'node:fs'
import path from 'node:path'
import {
  type HookSink,
  type MainObservations,
  type PathKind,
  type PathType,
  type PayloadModule,
  parseTrace,
  replayTrace,
  type WorkerPayload,
} from '@veyrum/capture'
import { readPayloads } from '@veyrum/capture/assemble'
import { digest, isInside, normalizeAbsolute } from '@veyrum/core'
import type {
  BrowserExchange,
  BrowserReport,
  BrowserScript,
  MainReport,
  StartedPrograms,
} from './protocol.ts'
import { SCRATCH } from './protocol.ts'

/** A test file under one project: `${projectId}\u0000${absolute file}`. */
export type GroupKey = string

export function groupKey(projectId: string, file: string): GroupKey {
  return `${projectId}\u0000${normalizeAbsolute(file)}`
}

export interface Analysis {
  /** One payload per captured file and project, with the browser's and the server's inputs. */
  readonly payloads: ReadonlyMap<GroupKey, WorkerPayload>
  /** Flags the payload cannot carry, with what they were about. */
  readonly flags: ReadonlyMap<GroupKey, { browser: string[]; server: string[] }>
  /** What Playwright's main process read, without the modules test files load themselves. */
  readonly main: MainObservations | null
}

/** What programs the main process started did, from their trace. */
interface Traced {
  readonly reads: Map<string, { p: string; kind: PathKind; type: PathType }>
  readonly writes: Set<string>
  readonly net: Map<string, { host: string; port: number | null; local: boolean }>
  /** Programs they started that the tracer could not follow. */
  readonly untraceable: Set<string>
  /** Programs that could not be traced at all (no native tracer). */
  readonly untraced: Set<string>
  readonly env: Map<string, string | null>
}

/** What the Node processes of app servers logged (see server-process.ts). */
interface ServerLogs {
  readonly ports: Set<number>
  readonly code: Set<string>
  readonly reasons: Set<string>
}

const NODE_MODULES = `${path.sep}node_modules${path.sep}`

function readJsonDir<T>(dir: string): T[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir).sort()
  } catch {
    return []
  }
  const out: T[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as T)
    } catch {
      // A torn report: the process was killed while writing it, and its file has no payload either.
    }
  }
  return out
}

/** Collects what traced programs did (see replayTrace), with how the main process started them. */
function traced(trace: string, programs: readonly StartedPrograms[]): Traced {
  const out: Traced = {
    reads: new Map(),
    writes: new Set(),
    net: new Map(),
    untraceable: new Set(),
    untraced: new Set(),
    env: new Map(),
  }
  const sink: HookSink = {
    path(absolute, kind, type) {
      const key = `${kind}\u0000${absolute}`
      if (!out.reads.has(key)) out.reads.set(key, { p: absolute, kind, type })
    },
    write(absolute) {
      out.writes.add(absolute)
    },
    env() {},
    envEnumerated() {},
    envWrite() {},
    net(host, port, local) {
      out.net.set(`${host}:${port ?? ''}`, { host, port: port ?? null, local })
    },
    spawn(command) {
      out.untraceable.add(command)
    },
    packageName() {},
    dlopen() {},
    sourceObserved() {},
  }
  let text = ''
  try {
    text = fs.readFileSync(trace, 'utf8')
  } catch {
    // Nothing was started, or nothing traced.
  }
  replayTrace(parseTrace(text), sink)
  for (const started of programs) {
    for (const command of started.untraced) out.untraced.add(command)
    for (const e of started.env) if (!out.env.has(e.n)) out.env.set(e.n, e.h)
    for (const entry of started.paths)
      sink.path(entry.p, entry.kind as PathKind, entry.type as PathType, 'other')
  }
  return out
}

function serverLogs(scratch: string, mains: readonly MainReport[]): ServerLogs {
  const out: ServerLogs = { ports: new Set(), code: new Set(), reasons: new Set() }
  for (const main of mains) for (const port of main.listens) out.ports.add(port)
  let names: string[] = []
  try {
    names = fs.readdirSync(path.join(scratch, SCRATCH.server))
  } catch {
    // No Node server ran.
  }
  for (const name of names) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(scratch, SCRATCH.server, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.startsWith('L ')) out.ports.add(Number(line.slice(2)))
      else if (line.startsWith('C ')) out.code.add(normalizeAbsolute(line.slice(2)))
      else if (line.startsWith('U ')) out.reasons.add(`an app server's ${line.slice(2)}`)
    }
  }
  return out
}

/** What a traced program read, as inputs: not what it wrote itself, nor Veyrum's own files. */
function readsOf(
  programs: Traced,
  ignored: (p: string) => boolean,
): { p: string; kind: PathKind; type: PathType }[] {
  return [...programs.reads.values()].filter((e) => !programs.writes.has(e.p) && !ignored(e.p))
}

/** Ports other Node programs of the run listened on, by each of their ancestor processes. */
function portsOfChildren(scratch: string): Map<number, number[]> {
  const dir = path.join(scratch, SCRATCH.children)
  const out = new Map<number, number[]>()
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const [port, ...ancestors] = line.split(' ').map(Number)
      if (!port) continue
      for (const pid of ancestors) out.set(pid, [...(out.get(pid) ?? []), port])
    }
  }
  return out
}

/** Digests of a candidate client file, as bytes (response bodies) and as text (script sources). */
interface ClientFile {
  readonly path: string
  readonly bytes: string
  readonly text: string
}

/**
 * Files the server read and may have sent as they are: repository files outside node_modules that
 * no server process loaded as code or wrote.
 */
function clientCandidates(
  root: string,
  server: Traced,
  code: ReadonlySet<string>,
  ignored: (p: string) => boolean,
): ClientFile[] {
  const out: ClientFile[] = []
  for (const { p, kind, type } of server.reads.values()) {
    if (kind !== 'read' || type !== 'file') continue
    if (!isInside(root, p) || p.includes(NODE_MODULES) || ignored(p)) continue
    if (code.has(p) || server.writes.has(p)) continue
    try {
      const bytes = fs.readFileSync(p)
      out.push({ path: p, bytes: digest(bytes), text: digest(bytes.toString('utf8')) })
    } catch {
      // Gone since: it stays a shared input of the server.
    }
  }
  return out
}

/** Where a script was served from (scripts are recorded only when served from a loopback address). */
function scriptOrigin(script: BrowserScript): BrowserExchange {
  const u = new URL(script.url)
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
  return { url: script.url, host: u.hostname, port, local: true }
}

/**
 * The candidates some browser of the run received byte for byte from the server: only those leave
 * the server's inputs, to count for the files that received them. A candidate whose content another
 * candidate shares stays a server input, since which of them was sent cannot be told.
 */
function clientFiles(
  candidates: readonly ClientFile[],
  reports: readonly BrowserReport[],
  isServerPort: (e: BrowserExchange) => boolean,
): ClientFile[] {
  const count = new Map<string, number>()
  for (const c of candidates) {
    count.set(c.bytes, (count.get(c.bytes) ?? 0) + 1)
    if (c.text !== c.bytes) count.set(c.text, (count.get(c.text) ?? 0) + 1)
  }
  const received = new Set<string>()
  for (const report of reports) {
    for (const e of report.exchanges) if (isServerPort(e) && e.body) received.add(e.body)
    for (const script of report.scripts) if (isServerPort(scriptOrigin(script))) received.add(script.code)
  }
  return candidates.filter(
    (c) =>
      count.get(c.bytes) === 1 && count.get(c.text) === 1 && (received.has(c.bytes) || received.has(c.text)),
  )
}

function mergePayloads(list: readonly WorkerPayload[]): WorkerPayload {
  const [first, ...rest] = list
  if (!first) throw new Error('no payload to merge')
  if (rest.length === 0) return first
  const union = <T>(items: readonly T[], key: (t: T) => string): T[] => {
    const seen = new Map<string, T>()
    for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item)
    return [...seen.values()]
  }
  const all = <K extends keyof WorkerPayload>(k: K): WorkerPayload[K][] => list.map((p) => p[k])
  return {
    ...first,
    // Each worker ran only this file: several workers are parts of one file, not a shared worker.
    isolateReused: list.some((p) => p.isolateReused),
    modules: list.flatMap((p) => p.modules),
    natives: [...new Set(all('natives').flat())],
    wholeModules: [...new Set(list.flatMap((p) => p.wholeModules ?? []))],
    paths: union(
      list.flatMap((p) => p.paths),
      (e) => `${e.kind}\u0000${e.p}`,
    ),
    writes: [...new Set(all('writes').flat())],
    env: union(
      list.flatMap((p) => p.env),
      (e) => `${e.n}\u0000${e.h}`,
    ),
    envEnumerated: list.some((p) => p.envEnumerated),
    envWritten: [...new Set(all('envWritten').flat())],
    net: union(
      list.flatMap((p) => p.net),
      (n) => `${n.host}:${n.port}`,
    ),
    spawns: [...new Set(all('spawns').flat())],
    dlopen: [...new Set(all('dlopen').flat())],
    evalScripts: list.reduce((sum, p) => sum + p.evalScripts, 0),
    sourceObserved: list.some((p) => p.sourceObserved),
    ...(list.every((p) => !p.sourceObserved || p.observedSources)
      ? { observedSources: [...new Set(list.flatMap((p) => p.observedSources ?? []))] }
      : { observedSources: undefined }),
    captureErrors: list.flatMap((p) => p.captureErrors),
  } as WorkerPayload
}

interface Attribution {
  /** Client files the browser ran with every execution observed: their executed functions. */
  readonly precise: Map<string, PayloadModule[]>
  /** Client files whose whole content is an input. */
  readonly whole: Set<string>
}

export interface AnalyzeInput {
  readonly root: string
  readonly scratch: string
  readonly ignored: readonly string[]
  /** Test files of the run (absolute). */
  readonly testFiles: ReadonlySet<string>
}

/**
 * Combines what the processes of a Playwright run observed into one payload per test file and
 * project (see docs/design/soundness.md, Playwright):
 *
 * - the worker's own capture (the test process, node layout), with repository modules compared by
 *   their source, since Playwright compiles them with its own transform;
 * - the browser: remote requests, requests to local servers nobody observed, browsers that cannot
 *   be observed, and the client files its pages received or ran;
 * - the app server, for files that talked to it: everything it read, except client files, which
 *   count only for the files whose pages received them.
 */
export function analyze(input: AnalyzeInput): Analysis {
  const { root, scratch } = input
  const ignored = (p: string): boolean => input.ignored.some((prefix) => p.startsWith(prefix))
  const captureDir = path.join(scratch, SCRATCH.capture)
  const payloads = readPayloads(captureDir)
  const reports = readJsonDir<BrowserReport>(path.join(scratch, SCRATCH.browser))
  const mains = readJsonDir<MainReport>(path.join(scratch, SCRATCH.main))
  const server = traced(
    path.join(scratch, SCRATCH.serverTrace),
    mains.map((m) => m.started.server),
  )
  const setup = traced(
    path.join(scratch, SCRATCH.setupTrace),
    mains.map((m) => m.started.setup),
  )
  const logs = serverLogs(scratch, mains)
  const serverReasons = new Set(logs.reasons)
  for (const command of server.untraced)
    serverReasons.add(
      `the app server "${command}" could not be traced: following the programs a server runs needs Veyrum's native tracer, built for Linux`,
    )
  const isServerPort = (e: { local: boolean; port: number | null }): boolean =>
    e.local && e.port !== null && logs.ports.has(e.port)
  const clients = clientFiles(clientCandidates(root, server, logs.code, ignored), reports, isServerPort)
  const byBytes = new Map(clients.map((c) => [c.bytes, [c.path]]))
  const byText = new Map(clients.map((c) => [c.text, [c.path]]))

  // Where each client file was received, in any file: a response whose body was not read at such a
  // URL counts as receiving it.
  const atUrl = new Map<string, Set<string>>()
  const noteUrl = (url: string, files: readonly string[] | undefined): void => {
    if (!files) return
    const set = atUrl.get(url) ?? new Set()
    for (const f of files) set.add(f)
    atUrl.set(url, set)
  }
  for (const report of reports) {
    for (const e of report.exchanges) if (isServerPort(e) && e.body) noteUrl(e.url, byBytes.get(e.body))
    for (const s of report.scripts) if (isServerPort(scriptOrigin(s))) noteUrl(s.url, byText.get(s.code))
  }

  // Playwright's main process: its browsers (global setup) and what it read.
  const mainBrowser = mains.map((m) => m.browser).filter((b): b is BrowserReport => b !== null)
  const mainExchanges = mainBrowser.flatMap((b) => b.exchanges)
  const mainTalked = mainExchanges.some(isServerPort)

  const childPorts = portsOfChildren(scratch)
  const reportsByPid = new Map(reports.map((r) => [r.pid, r]))
  const grouped = new Map<GroupKey, { payloads: WorkerPayload[]; reports: BrowserReport[] }>()
  for (const payload of payloads) {
    const report = reportsByPid.get(payload.pid)
    const key = groupKey(report?.projectId ?? '', payload.testFile)
    const group = grouped.get(key) ?? { payloads: [], reports: [] }
    group.payloads.push(
      report
        ? payload
        : { ...payload, captureErrors: [...payload.captureErrors, 'the browser observation is missing'] },
    )
    if (report) group.reports.push(report)
    grouped.set(key, group)
  }

  const out = new Map<GroupKey, WorkerPayload>()
  const flags = new Map<GroupKey, { browser: string[]; server: string[] }>()
  const allModules = new Set<string>()
  for (const [key, group] of grouped) {
    const merged = mergePayloads(group.payloads)
    const reasons = { browser: new Set<string>(), server: new Set<string>() }
    // Ports the test process served, or a program it started (a test's own server).
    const own = new Set(group.reports.flatMap((r) => [...r.listens, ...(childPorts.get(r.pid) ?? [])]))
    const exchanges = [...group.reports.flatMap((r) => r.exchanges), ...mainExchanges]
    const net = [...merged.net]
    const paths = [...merged.paths]
    const env = [...merged.env]
    const spawns = [...merged.spawns]
    const captureErrors = [...merged.captureErrors, ...group.reports.flatMap((r) => r.errors)]

    // The test process compiled repository modules with Playwright's transform: they are compared by
    // their source (their code stays, to locate function source the test read).
    const wholeModules = new Set(merged.wholeModules ?? [])
    for (const m of merged.modules) {
      allModules.add(m.path)
      if (isInside(root, m.path) && !m.path.includes(NODE_MODULES)) wholeModules.add(m.path)
    }

    let talked = mainTalked
    let unknownContent = mainTalked
    const unobservedLocal = (where: string, port: number | null): void => {
      reasons.server.add(`${where}: no observed program listened on port ${port ?? '?'}`)
    }
    for (const e of exchanges) {
      if (!e.local) net.push({ host: e.host, port: e.port, local: false })
      else if (isServerPort(e)) {
        talked = true
        if (e.body === null) unknownContent = true
      } else if (!own.has(e.port)) unobservedLocal(new URL(e.url).origin, e.port)
    }
    // The test process's own connections: to the server it may read anything the server sends.
    for (const n of merged.net) {
      if (!n.local || n.port === null) continue
      if (isServerPort(n)) {
        talked = true
        unknownContent = true
      } else if (!own.has(n.port)) unobservedLocal(`${n.host}:${n.port}`, n.port)
    }

    // What the project's own code started from the main process (global setup) counts for every
    // file; an app server's inputs, for the files that talked to it.
    const include = (programs: Traced, skip: ReadonlySet<string>): void => {
      for (const n of programs.net.values()) if (!n.local) net.push(n)
      for (const command of [...programs.untraceable, ...programs.untraced]) spawns.push(command)
      for (const [n, h] of programs.env) if (!env.some((x) => x.n === n)) env.push({ n, h })
      for (const entry of readsOf(programs, ignored))
        if (!(entry.kind === 'read' && skip.has(entry.p))) paths.push(entry)
    }
    include(setup, new Set())
    const attribution: Attribution = { precise: new Map(), whole: new Set() }
    if (talked) {
      for (const reason of serverReasons) reasons.server.add(reason)
      attribute(attribution, group.reports, clients, byBytes, byText, atUrl, isServerPort, unknownContent)
      include({ ...server, untraced: new Set() }, new Set(clients.map((c) => c.path)))
      for (const file of attribution.whole) paths.push({ p: file, kind: 'read', type: 'file' })
    }
    const modules = [...merged.modules, ...[...attribution.precise.values()].flat()]

    for (const report of group.reports)
      for (const name of report.unobservedBrowsers) reasons.browser.add(name)
    for (const b of mainBrowser) for (const name of b.unobservedBrowsers) reasons.browser.add(name)
    const natives = [...new Set([...merged.natives, ...group.reports.flatMap((r) => r.executables)])]
    // Playwright writes a missing snapshot and, when configured to, passes: that pass is not evidence.
    const snapshots = merged.writes.filter((w) => isInside(root, w) && /-snapshots[\\/]/.test(w)).length

    out.set(key, {
      ...merged,
      modules,
      natives,
      wholeModules: [...wholeModules],
      paths,
      env,
      net: [...new Map(net.map((n) => [`${n.host}:${n.port}:${n.local}`, n])).values()],
      spawns: [...new Set(spawns)],
      captureErrors,
      snapshot: { added: merged.snapshot.added + snapshots, updated: merged.snapshot.updated },
    })
    flags.set(key, { browser: [...reasons.browser], server: [...reasons.server] })
  }

  return { payloads: out, flags, main: mainObservations(mains, allModules, input.testFiles) }
}

/**
 * Which client files a file's pages received, and which of them ran with every execution observed.
 * A client file counts whole when it was received as anything but a script, when a page ran it
 * before coverage started, or when the observation was incomplete in any way.
 */
function attribute(
  out: Attribution,
  reports: readonly BrowserReport[],
  clients: readonly ClientFile[],
  byBytes: ReadonlyMap<string, string[]>,
  byText: ReadonlyMap<string, string[]>,
  atUrl: ReadonlyMap<string, ReadonlySet<string>>,
  isServerPort: (e: BrowserExchange) => boolean,
  unknownContent: boolean,
): void {
  if (unknownContent) {
    for (const c of clients) out.whole.add(c.path)
    return
  }
  const complete = reports.every((r) => r.incomplete.length === 0)
  const received = new Set<string>()
  for (const report of reports) {
    for (const e of report.exchanges) {
      if (!isServerPort(e)) continue
      const files = e.body ? byBytes.get(e.body) : undefined
      const matched = files ?? [...(atUrl.get(e.url) ?? [])]
      for (const f of matched) {
        received.add(f)
        // Content received as data or a document is an input as a whole.
        if (e.resourceType !== 'script') out.whole.add(f)
      }
    }
  }
  const instances = new Map<string, BrowserScript[]>()
  for (const report of reports)
    for (const script of report.scripts) {
      if (!isServerPort(scriptOrigin(script))) continue
      for (const f of byText.get(script.code) ?? []) instances.set(f, [...(instances.get(f) ?? []), script])
    }
  for (const f of received) if (!instances.has(f)) out.whole.add(f)
  for (const [f, scripts] of instances) {
    if (!complete || scripts.some((s) => !s.precise)) {
      out.whole.add(f)
      continue
    }
    const byCode = new Map<string, Map<string, readonly [number, number]>>()
    for (const s of scripts) {
      const executed = byCode.get(s.code) ?? new Map<string, readonly [number, number]>()
      for (const range of s.executed) executed.set(`${range[0]}:${range[1]}`, range)
      byCode.set(s.code, executed)
    }
    out.precise.set(
      f,
      [...byCode].map(([code, executed]) => ({ path: f, code, executed: [...executed.values()] })),
    )
  }
}

/** The main process's reads, without what test files load (each file records its own). */
function mainObservations(
  mains: readonly MainReport[],
  modules: ReadonlySet<string>,
  testFiles: ReadonlySet<string>,
): MainObservations | null {
  if (mains.length === 0) return null
  const own = (p: string): boolean => modules.has(p) || testFiles.has(p)
  return {
    paths: mains.flatMap((m) => m.observations.paths).filter((o) => !own(o.p)),
    env: mains.flatMap((m) => m.observations.env),
    envBaseline: mains[0]!.observations.envBaseline,
    loadedPackages: [...new Set(mains.flatMap((m) => m.observations.loadedPackages))],
    loadedFiles: [...new Set(mains.flatMap((m) => m.observations.loadedFiles))].filter((f) => !own(f)),
    loadsObserved: mains.every((m) => m.observations.loadsObserved),
  }
}
