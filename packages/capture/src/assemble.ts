import fs from 'node:fs'
import path from 'node:path'
import {
  type ClosureEntry,
  CurrentState,
  type Digest,
  deserializeUnits,
  digest,
  type EvidenceRecord,
  FINGERPRINT_VERSION,
  FLAGS,
  fingerprintModule,
  isInside,
  type ModuleUnits,
  normalizeAbsolute,
  OPAQUE_UNIT,
  type RunInfo,
  SKIP_DIRS,
  type Store,
  serializeUnits,
  type TestOutcome,
  TOP_UNIT,
  toRepoPath,
} from '@veyrum/core'
import type { RawFs } from './hooks.ts'
import type { MainObservations } from './main.ts'
import type { WorkerPayload } from './payload.ts'

/** A test file's result as the runner reported it. */
export interface CheckOutcome {
  /** Absolute path of the test file. */
  readonly file: string
  readonly project: string
  /** Transform environment the file's modules ran in (used to re-transform them at plan time). */
  readonly env: string
  readonly verdict: 'pass' | 'fail'
  readonly tests: readonly TestOutcome[]
  readonly durationMs: number
  readonly retries: number
  /** Snapshot writes reported by the runner, when the worker cannot observe them. */
  readonly snapshot?: { readonly added: number; readonly updated: number }
  /** On failure, the first failing test and its first error message (for diagnostics). */
  readonly failure?: string
}

export interface AssembleInput {
  readonly root: string
  readonly runId: string
  readonly runtimeKey: Digest
  readonly runtime: Readonly<Record<string, string>>
  readonly revision: string | null
  readonly createdAt: string
  readonly outDir: string
  readonly outcomes: Iterable<CheckOutcome>
  readonly main: MainObservations
  readonly files: readonly string[]
  readonly store: Store
  readonly fs: RawFs
  readonly runner: RunInfo['runner']
  /** Projects whose configuration disables per-file isolation. */
  readonly sharedWorkerProjects: ReadonlySet<string>
  /** Absolute path prefixes of Veyrum's own files and scratch space. */
  readonly ignored: readonly string[]
  /**
   * Files every check depends on that the runner reads in native code, invisible to fs hooks
   * (Vite bundles its config and resolves tsconfig in Rust): config files, their dependencies,
   * and TypeScript/JavaScript project configs.
   */
  readonly configFiles: readonly string[]
  /**
   * Every test file the runner found, absolute, whether it ran captured, uncaptured or not at all.
   * The runner reads test files to schedule them; each is its own check's input, never shared.
   */
  readonly testFiles?: readonly string[]
  /**
   * Those of `configFiles` that are project configurations only the runner's native tsconfig
   * discovery reads. Recorded as scoped (see `RunInfo.projectConfigs`) unless the main process
   * also read, checked or loaded them in JavaScript, which could be for any purpose.
   */
  readonly projectConfigs?: readonly string[]
  /**
   * Package manifests every check depends on through the fields the toolchain reads from them
   * (for example Jest, Babel and Browserslist configuration). Compared as manifests: dependency
   * version ranges and scripts are left out.
   */
  readonly manifestFiles?: readonly string[]
}

export interface Assembled {
  readonly run: RunInfo
  readonly records: readonly EvidenceRecord[]
}

/** A snapshot line such as `src/a.ts:12:3` means the test observes source positions. */
const POSITION_PATTERN = /\.[cm]?[jt]sx?:\d+:\d+/

export function readPayloads(outDir: string): WorkerPayload[] {
  const dir = path.join(outDir, 'payloads')
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: WorkerPayload[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as WorkerPayload)
    } catch {
      // A torn payload means capture failed for that file; its record becomes non-reusable.
    }
  }
  return out
}

/** Dependency text kept in memory while assembling (see depText). */
const MAX_DEP_TEXT_BYTES = 64 * 1024 * 1024

export function assemble(input: AssembleInput): Assembled {
  const { root } = input
  const state = new CurrentState(root, input.store, process.env, input.fs)
  const payloads = readPayloads(input.outDir)
  const byTestFile = new Map<string, WorkerPayload[]>()
  // Runners spell paths their own way (Vitest on Windows: `C:/x/y`); compared in one spelling.
  for (const p of payloads) {
    const file = normalizeAbsolute(p.testFile)
    const list = byTestFile.get(file)
    if (list) list.push(p)
    else byTestFile.set(file, [p])
  }

  const moduleCache = new Map<string, ModuleUnits>()
  // Unit fingerprints depend only on the executed code (and the root, which is normalized away),
  // so they are cached across runs by code digest: unchanged modules are never parsed again.
  const unitsFor = (codeDigest: string): ModuleUnits => {
    let m = moduleCache.get(codeDigest)
    if (!m) {
      const key = `code\u0000${FINGERPRINT_VERSION}\u0000${codeDigest}`
      const cached = input.store.getCached(key)
      if (cached) {
        m = deserializeUnits(cached)
      } else {
        const code = fs.readFileSync(path.join(input.outDir, 'blobs', `${codeDigest}.js`), 'utf8')
        m = fingerprintModule(code, { root })
        input.store.putCached(key, serializeUnits(m))
      }
      moduleCache.set(codeDigest, m)
    }
    return m
  }
  const codeCache = new Map<string, string>()
  const codeOf = (codeDigest: string): string => {
    let code = codeCache.get(codeDigest)
    if (code === undefined) {
      try {
        code = fs.readFileSync(path.join(input.outDir, 'blobs', `${codeDigest}.js`), 'utf8')
      } catch {
        code = ''
      }
      codeCache.set(codeDigest, code)
    }
    return code
  }
  // Dependency text, for locating function source a test read. Files share dependencies, so their
  // text is cached, within a bound: dependencies can be large.
  const depTexts = new Map<string, string>()
  let depTextBytes = 0
  const depText = (absolute: string): string => {
    let text = depTexts.get(absolute)
    if (text !== undefined) return text
    try {
      text = input.fs.readFileSync(absolute, 'utf8') as string
    } catch {
      text = ''
    }
    depTexts.set(absolute, text)
    depTextBytes += text.length
    for (const [key, old] of depTexts) {
      if (depTextBytes <= MAX_DEP_TEXT_BYTES || key === absolute) break
      depTexts.delete(key)
      depTextBytes -= old.length
    }
    return text
  }
  /** The dependency each observed source text was last found in: files read the same functions. */
  const textFoundIn = new Map<string, string>()
  const inDependency = (text: string, natives: ReadonlySet<string>): boolean => {
    const hint = textFoundIn.get(text)
    if (hint !== undefined && natives.has(hint) && depText(hint).includes(text)) return true
    for (const dep of natives) {
      if (dep === hint || ignored(dep) || !depText(dep).includes(text)) continue
      textFoundIn.set(text, dep)
      return true
    }
    return false
  }
  const dynCache = new Map<string, boolean>()
  const isDynamic = (absolute: string): boolean => {
    let d = dynCache.get(absolute)
    if (d === undefined) {
      try {
        d = input.fs.readFileSync(absolute, 'utf8').includes('import.meta.glob')
      } catch {
        d = false
      }
      dynCache.set(absolute, d)
    }
    return d
  }
  const ignored = (absolute: string): boolean => input.ignored.some((p) => absolute.startsWith(p))

  const allModulePaths = new Set<string>()
  const records: EvidenceRecord[] = []

  // package.json files govern module format ("type") and resolution ("exports", "imports") for
  // every file below them. Collected per directory, up to the repository root or package root.
  const manifestCache = new Map<string, string[]>()
  const manifestsFor = (absoluteFile: string): string[] => {
    const dir = path.dirname(absoluteFile)
    const cached = manifestCache.get(dir)
    if (cached) return cached
    const out: string[] = []
    const candidate = path.join(dir, 'package.json')
    let exists = false
    try {
      exists = input.fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() ?? false
    } catch {
      exists = false
    }
    if (exists) out.push(candidate)
    const inDeps = dir.includes(`${path.sep}node_modules${path.sep}`)
    // Inside node_modules the nearest package.json is the package's own; stop there.
    const parent = path.dirname(dir)
    if (!(inDeps && exists) && parent !== dir && (inDeps || parent.startsWith(root)))
      out.push(...manifestsFor(path.join(parent, 'x')))
    manifestCache.set(dir, out)
    return out
  }

  const outcomes = [...input.outcomes]
  // Files a test created during the run (fixture output such as a generated site or module) are
  // its own products, derived from its code: not inputs of that test, nor of the runner's main
  // process when it reads them afterwards. So is what the main process created (global setup's
  // caches and generated files), derived from shared inputs of every test. A path that existed
  // when the run started stays an input, since it may have been read before a test changed it.
  const pathsAtStart = new Set<string>()
  for (const file of input.files)
    for (let p = file; p !== '.' && !pathsAtStart.has(p); p = path.posix.dirname(p)) pathsAtStart.add(p)
  /** Every written path and the directories above it (a write under a directory created it too). */
  const withAncestors = (writes: Iterable<string>): Set<string> => {
    const out = new Set<string>()
    for (const w of writes)
      for (let dir = w; dir !== path.dirname(dir) && !out.has(dir); dir = path.dirname(dir)) out.add(dir)
    return out
  }
  /** A repository path absent when the run started (dependency and VCS directories never count). */
  const newDuringRun = (absolute: string): boolean => {
    if (!isInside(root, absolute)) return false
    const rel = toRepoPath(root, absolute)
    return !pathsAtStart.has(rel) && !rel.split('/').some((s) => SKIP_DIRS.has(s))
  }
  const createdDuringRun = (writes: ReadonlySet<string>, absolute: string): boolean => {
    if (writes.size === 0 || !newDuringRun(absolute)) return false
    for (let dir = absolute; dir !== path.dirname(dir); dir = path.dirname(dir)) {
      if (writes.has(dir)) return true
      if (dir === root) break
    }
    return false
  }
  const mainWrites = input.main.writes ?? []
  const testWrites = new Set(payloads.flatMap((p) => p.writes))
  const mainCreated = withAncestors(mainWrites)
  // What any test created. Whether another test's product exists when a test lists a directory
  // depends on how the runner scheduled them, not on the repository, and a fresh checkout never
  // holds it: a listing leaves such entries out (reading their content is still an input).
  const runCreated = new Set([...withAncestors(testWrites), ...mainCreated])
  const runWrites = new Set([...testWrites, ...mainWrites])
  const testFiles = new Set(
    [...outcomes.map((o) => o.file), ...(input.testFiles ?? [])].map(normalizeAbsolute),
  )

  /** The closure entry for a path the main process read, or null when it is not an input. */
  const mainPathEntry = (obs: MainObservations['paths'][number]): ClosureEntry | null => {
    if (ignored(obs.p) || obs.kind === 'dir') return null
    if (createdDuringRun(testWrites, obs.p)) return null
    // Reads inside node_modules are resolution metadata. Each check records the manifests of the
    // packages it loaded, and the toolchain's own packages are recorded below by module load.
    if (obs.p.includes(`${path.sep}node_modules${path.sep}`)) return null
    if (testFiles.has(obs.p)) return null
    const p = toRepoPath(root, obs.p)
    if ((obs.kind === 'read' || obs.kind === 'manifest') && (obs.type === 'file' || obs.type === 'absent')) {
      // The toolchain reads manifests for module format, resolution and dependency names. A
      // configuration file that imports a manifest records its full content as well, below.
      const k = path.basename(p) === 'package.json' ? 'manifest' : 'file'
      if (obs.type === 'absent') return { k, p, h: null }
      return k === 'manifest' ? { k, p, h: state.manifestDigest(p) } : { k, p, h: state.fileDigest(p) }
    }
    return { k: 'stat', p, t: obs.type }
  }

  for (const outcome of outcomes) {
    const check = toRepoPath(root, outcome.file)
    const flags = new Set<string>()
    if (declaresAlwaysRun(input.fs, outcome.file)) flags.add(FLAGS.alwaysRun)
    const closure: ClosureEntry[] = []
    const candidates = byTestFile.get(normalizeAbsolute(outcome.file)) ?? []
    // A file can run more than once in a run (repeats); the last payload describes the final attempt.
    const payload = candidates[candidates.length - 1]
    if (!payload || !input.main.loadsObserved) flags.add(FLAGS.captureIncomplete)
    if (candidates.length > 1) flags.add(FLAGS.sharedWorker)

    if (payload) {
      if (payload.captureErrors.length > 0) flags.add(FLAGS.captureIncomplete)
      if (payload.isolateReused || input.sharedWorkerProjects.has(outcome.project))
        flags.add(FLAGS.sharedWorker)
      if (payload.envEnumerated) flags.add(FLAGS.envEnumerated)
      if (payload.random) flags.add(FLAGS.random)
      if (payload.evalScripts > 0) flags.add(FLAGS.evalCode)
      if (payload.spawns.length > 0) flags.add(FLAGS.spawn)
      if (payload.dlopen.length > 0) flags.add(FLAGS.native)
      for (const n of payload.net) flags.add(n.local ? FLAGS.netLocal : FLAGS.netRemote)
      if (payload.snapshot.added > 0 || payload.snapshot.updated > 0) flags.add(FLAGS.snapshotWritten)
      if (payload.writes.some((w) => !ignored(w))) flags.add(FLAGS.writesFs)

      const seen = new Set<string>()
      const add = (key: string, entry: ClosureEntry): void => {
        if (seen.has(key)) return
        seen.add(key)
        closure.push(entry)
      }

      const modulesByPath = new Map<
        string,
        {
          code: string
          executed: (readonly [number, number])[]
          units?: Readonly<Record<string, Digest>>
          src?: Digest
          env: string
        }[]
      >()
      for (const mod of payload.modules) {
        const list = modulesByPath.get(mod.path)
        const item = {
          code: mod.code,
          executed: [...mod.executed],
          ...(mod.units ? { units: mod.units } : {}),
          ...(mod.src ? { src: mod.src } : {}),
          env: mod.env ?? outcome.env,
        }
        if (list) list.push(item)
        else modulesByPath.set(mod.path, [item])
      }
      // Source text a test read pins the module it came from to raw comparison. Text found in a
      // dependency needs nothing more (dependencies are compared whole); text found nowhere
      // (compiled from a string, or too much to keep) pins every module.
      const rawModules = new Set<string>()
      if (payload.sourceObserved) {
        const natives = new Set(payload.natives)
        const texts = payload.observedSources
        let located = texts !== undefined && texts.length > 0
        for (const text of texts ?? []) {
          let found = false
          for (const [absolute, versions] of modulesByPath) {
            if (versions.some((v) => codeOf(v.code).includes(text))) {
              rawModules.add(absolute)
              found = true
            }
          }
          if (!found) found = inDependency(text, natives)
          if (!found) {
            located = false
            break
          }
        }
        if (!located) flags.add(FLAGS.sourceObserved)
      }
      const checkWrites = new Set(payload.writes)
      for (const [absolute, versions] of modulesByPath) {
        allModulePaths.add(absolute)
        if (createdDuringRun(checkWrites, absolute)) continue
        const repoPath = toRepoPath(root, absolute)
        const src = state.fileDigest(repoPath)
        if (src === null) {
          flags.add(FLAGS.captureIncomplete)
          continue
        }
        const units: Record<string, Digest> = {}
        for (const version of versions) {
          if (version.units) {
            // Fingerprinted by the runtime from the source it read: that must be the source now.
            if (version.src !== src) flags.add(FLAGS.captureIncomplete)
            Object.assign(units, version.units)
            continue
          }
          const m = unitsFor(version.code)
          const top = m.opaque ? OPAQUE_UNIT : TOP_UNIT
          units[top] = m.units.get(top)!.fp
          for (const [start, end] of version.executed) {
            const unit = m.locate(start, end)
            units[unit] = m.units.get(unit)!.fp
          }
        }
        // Code of one file from environments that compile it differently (a Playwright module the
        // test process loaded that a browser also ran) cannot be compiled again as one: it is
        // compared by its source.
        const envs = new Set(versions.map((v) => v.env))
        add(`mod:${repoPath}`, {
          k: 'mod',
          p: repoPath,
          src,
          units,
          env: envs.size === 1 ? versions[0]!.env : outcome.env,
          ...(isDynamic(absolute) ? { dyn: true as const } : {}),
          ...(rawModules.has(absolute)
            ? { raw: true as const }
            : payload.wholeModules?.includes(absolute) || envs.size > 1
              ? { raw: 'whole' as const }
              : {}),
        })
      }
      for (const absolute of payload.wholeModules ?? []) {
        allModulePaths.add(absolute)
        if (modulesByPath.has(absolute) || createdDuringRun(checkWrites, absolute)) continue
        const repoPath = toRepoPath(root, absolute)
        const src = state.fileDigest(repoPath)
        if (src === null) {
          flags.add(FLAGS.captureIncomplete)
          continue
        }
        add(`mod:${repoPath}`, { k: 'mod', p: repoPath, src, units: {}, env: outcome.env, raw: 'whole' })
      }
      for (const absolute of [...payload.natives, ...payload.dlopen]) {
        if (ignored(absolute)) continue
        const p = toRepoPath(root, absolute)
        add(`dep:${p}`, { k: 'dep', p, h: state.fileDigest(p) })
        for (const manifest of manifestsFor(absolute)) {
          const mp = toRepoPath(root, manifest)
          add(`dep:${mp}`, { k: 'dep', p: mp, h: state.fileDigest(mp) })
        }
      }
      // The manifests that govern each module's format and subpath imports. A test that imports
      // a manifest itself has it as a module, compared in full.
      for (const absolute of modulesByPath.keys()) {
        for (const manifest of manifestsFor(absolute)) {
          const mp = toRepoPath(root, manifest)
          add(`manifest:${mp}`, { k: 'manifest', p: mp, h: state.manifestDigest(mp) })
        }
      }
      const ownWrites = mainWrites.length === 0 ? checkWrites : new Set([...checkWrites, ...mainWrites])
      for (const obs of payload.paths) {
        if (ignored(obs.p)) continue
        // A path this test or the main process created is their product, whatever its kind.
        if (obs.type !== 'absent' && createdDuringRun(ownWrites, obs.p)) continue
        const p = toRepoPath(root, obs.p)
        if (obs.kind === 'dir') {
          if (obs.type !== 'dir') {
            add(`dir:${p}`, { k: 'dir', p, h: null })
            continue
          }
          // The listing of a directory another test created, like its entries below, depends on
          // scheduling.
          if (createdDuringRun(runWrites, obs.p)) continue
          // Entries the run created in a listed directory are left out of its listing.
          const x = (state.dirNames(p) ?? []).filter((n) => {
            const entry = path.join(obs.p, n)
            return runCreated.has(entry) && newDuringRun(entry)
          })
          add(
            `dir:${p}`,
            x.length > 0
              ? { k: 'dir', p, h: state.dirDigest(p, x), x }
              : { k: 'dir', p, h: state.dirDigest(p) },
          )
        } else if (obs.kind === 'manifest' && (obs.type === 'file' || obs.type === 'absent')) {
          add(`manifest:${p}`, {
            k: 'manifest',
            p,
            h: obs.type === 'absent' ? null : state.manifestDigest(p),
          })
        } else if (obs.kind === 'read' && (obs.type === 'file' || obs.type === 'absent')) {
          add(`file:${p}`, { k: 'file', p, h: obs.type === 'absent' ? null : state.fileDigest(p) })
        } else {
          add(`stat:${p}`, { k: 'stat', p, t: obs.type })
        }
      }
      for (const e of payload.env) add(`env:${e.n}`, { k: 'env', n: e.n, h: e.h })
      // What the main process read for this check's project alone (its global setup).
      const scoped = input.main.scoped?.[outcome.project]
      if (scoped) {
        for (const obs of scoped.paths) {
          const entry = modulesByPath.has(obs.p) ? null : mainPathEntry(obs)
          if (entry) add(entryKey(entry), entry)
        }
        for (const e of scoped.env) add(`env:${e.n}`, { k: 'env', n: e.n, h: e.h })
        for (const absolute of scoped.loadedFiles) {
          if (ignored(absolute) || !isInside(root, absolute) || modulesByPath.has(absolute)) continue
          const p = toRepoPath(root, absolute)
          add(`file:${p}`, { k: 'file', p, h: state.fileDigest(p) })
        }
      }
      for (const n of payload.packageNames ?? [])
        add(`pkgname:${n}`, { k: 'pkgname', n, h: state.packageNameDigest(n, () => input.files) })

      // Snapshots that embed source positions make formatting-only edits observable.
      for (const entry of closure) {
        if (entry.k !== 'file' || entry.h === null) continue
        if (!entry.p.endsWith('.snap') && entry.p !== check) continue
        try {
          if (POSITION_PATTERN.test(input.fs.readFileSync(path.join(root, entry.p), 'utf8'))) {
            flags.add(FLAGS.positionsObserved)
            break
          }
        } catch {
          // Unreadable snapshot: nothing to scan.
        }
      }
    }

    // Tripwire: a test file always executes itself. If it is missing from its own closure, capture
    // observed the wrong thing (for example, the project was ignored) and the pass is not evidence.
    if (!closure.some((e) => e.k === 'mod' && e.p === check)) flags.add(FLAGS.captureIncomplete)
    if (outcome.retries > 0) flags.add(FLAGS.flakySuspect)
    if (outcome.snapshot && (outcome.snapshot.added > 0 || outcome.snapshot.updated > 0))
      flags.add(FLAGS.snapshotWritten)
    const verdict = outcome.verdict
    const reusable =
      verdict === 'pass' &&
      !flags.has(FLAGS.flakySuspect) &&
      !flags.has(FLAGS.snapshotWritten) &&
      !flags.has(FLAGS.captureIncomplete)
    closure.sort((a, b) => entryKey(a).localeCompare(entryKey(b)))
    const remote = [
      ...new Set(
        (payload?.net ?? [])
          .filter((n) => !n.local)
          .map((n) => (n.port === null ? n.host : `${n.host}:${n.port}`)),
      ),
    ]
    const spawned = [...new Set(payload?.spawns ?? [])]
    records.push({
      id: digest(`${input.runId}\u0000${outcome.project}\u0000${check}`),
      check,
      project: outcome.project,
      runId: input.runId,
      runtimeKey: input.runtimeKey,
      verdict,
      reusable,
      flags: [...flags].sort(),
      tests: outcome.tests,
      durationMs: outcome.durationMs,
      closure,
      createdAt: input.createdAt,
      revision: input.revision,
      channels: {
        ...(remote.length > 0 ? { net: remote.sort().slice(0, 20) } : {}),
        ...(spawned.length > 0 ? { spawn: spawned.sort().slice(0, 20) } : {}),
      },
    })
  }

  // Shared inputs: what the main process read, minus the modules checks already track precisely.
  // Directory listings in the main process are test discovery (handled by the planner, since a new
  // test file simply has no evidence) or import.meta.glob (handled by re-transforming `dyn` modules).
  const shared: ClosureEntry[] = []
  const sharedSeen = new Set<string>()
  // Modules a project's runner executed in the main process are inputs of that project's checks
  // (added to their closures above); Vite reading and resolving them for it is not a shared input.
  const executedForProjects = new Set(Object.values(input.main.scoped ?? {}).flatMap((s) => s.loadedFiles))
  for (const obs of input.main.paths) {
    if (allModulePaths.has(obs.p) || executedForProjects.has(obs.p)) continue
    const entry = mainPathEntry(obs)
    if (!entry) continue
    const key = entryKey(entry)
    if (sharedSeen.has(key)) continue
    sharedSeen.add(key)
    shared.push(entry)
  }
  const toolchain = new Set(input.main.loadedPackages)
  for (const p of payloads) for (const manifest of p.toolchain ?? []) toolchain.add(manifest)
  for (const manifest of [...toolchain].sort()) {
    const p = toRepoPath(root, manifest)
    const entry: ClosureEntry = { k: 'dep', p, h: state.fileDigest(p) }
    const key = entryKey(entry)
    if (sharedSeen.has(key)) continue
    sharedSeen.add(key)
    shared.push(entry)
  }
  const toolchainFiles = payloads.flatMap((p) => p.toolchainFiles ?? [])
  const observedInJs = new Set(
    [...input.main.paths.map((o) => o.p), ...input.main.loadedFiles, ...toolchainFiles].map(
      normalizeAbsolute,
    ),
  )
  const projectConfigs = (input.projectConfigs ?? [])
    .filter(
      (absolute) =>
        !observedInJs.has(normalizeAbsolute(absolute)) && isInside(root, absolute) && !ignored(absolute),
    )
    .map((absolute) => toRepoPath(root, absolute))
    .sort()
  for (const absolute of [...input.configFiles, ...input.main.loadedFiles, ...toolchainFiles]) {
    if (ignored(absolute) || testFiles.has(absolute) || !isInside(root, absolute)) continue
    const p = toRepoPath(root, absolute)
    const entry: ClosureEntry = { k: 'file', p, h: state.fileDigest(p) }
    const key = entryKey(entry)
    if (sharedSeen.has(key)) continue
    sharedSeen.add(key)
    shared.push(entry)
  }
  for (const absolute of input.manifestFiles ?? []) {
    if (ignored(absolute) || !isInside(root, absolute)) continue
    const p = toRepoPath(root, absolute)
    const entry: ClosureEntry = { k: 'manifest', p, h: state.manifestDigest(p) }
    const key = entryKey(entry)
    if (sharedSeen.has(key)) continue
    sharedSeen.add(key)
    shared.push(entry)
  }

  // Variables the runner sets in workers: those whose value in some worker differs from the main
  // process's. When every worker saw the same value it is recorded; when workers saw different
  // values (Vitest's SSR differs by test environment), the value follows from each file's own
  // configuration, and the planner does not compare it. Values equal to the main process's count
  // too: a DOM file's SSR="" matches a main process that has SSR="" while server files see "1".
  const injected: Record<string, Digest | null> = {}
  const conflicting = new Set<string>()
  const names = new Set(payloads.flatMap((p) => Object.keys(p.envBaseline)))
  for (const n of names) {
    const main = input.main.envBaseline[n] ?? null
    const seen = new Set(payloads.map((p) => p.envBaseline[n] ?? null))
    if (![...seen].some((h) => h !== main)) continue
    if (seen.size > 1) conflicting.add(n)
    else injected[n] = [...seen][0] ?? null
  }

  // Environment the main process read, and (under Jest) what the runner and its toolchain read in
  // workers. Variables the runner injected into workers derive from the runner itself.
  const sharedEnv = new Map<string, Digest | null>()
  for (const e of input.main.env) sharedEnv.set(e.n, e.h)
  for (const p of payloads)
    for (const e of p.toolchainEnv ?? [])
      if (!sharedEnv.has(e.n) && !Object.hasOwn(injected, e.n) && !conflicting.has(e.n))
        sharedEnv.set(e.n, e.h)
  for (const [n, h] of sharedEnv) shared.push({ k: 'env', n, h })
  shared.sort((a, b) => entryKey(a).localeCompare(entryKey(b)))

  const run: RunInfo = {
    id: input.runId,
    createdAt: input.createdAt,
    revision: input.revision,
    runtimeKey: input.runtimeKey,
    runtime: input.runtime,
    shared,
    ...(projectConfigs.length > 0 ? { projectConfigs } : {}),
    injectedEnv: injected,
    ...(conflicting.size > 0 ? { injectedVaryingEnv: [...conflicting].sort() } : {}),
    files: input.files,
    runner: input.runner,
  }
  return { run, records }
}

function entryKey(e: ClosureEntry): string {
  return e.k === 'env' || e.k === 'pkgname' ? `${e.k}:${e.n}` : `${e.k}:${e.p}`
}

/** The comment by which a test file declares it must always run (see FLAGS.alwaysRun). */
const ALWAYS_RUN = /\bveyrum:\s*always-run\b/

function declaresAlwaysRun(fs: RawFs, file: string): boolean {
  try {
    return ALWAYS_RUN.test(String(fs.readFileSync(file, 'utf8')))
  } catch {
    return false
  }
}
