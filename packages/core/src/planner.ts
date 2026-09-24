import { configScope, isConfigLike, listRepoFiles } from './files.ts'
import { TOP_UNIT } from './fingerprint.ts'
import { type Digest, digest } from './hash.ts'
import { fromRepoPath, stem } from './paths.ts'
import { DEFAULT_POLICY, type Policy, STRICT_SOURCE_FLAGS } from './policy.ts'
import { CurrentState, type StateFs } from './state.ts'
import type { Store } from './store.ts'
import type { CheckRef, ClosureEntry, Decision, EvidenceRecord, RunInfo } from './types.ts'

/** Produces the transformed code the runner would execute for a module, for unit fingerprinting. */
export interface ModuleTransformer {
  /**
   * Returns unit fingerprints of the module as it would execute now, or null when the module
   * cannot be transformed (the check then runs).
   */
  units(absolutePath: string, env: string, project: string): Promise<Readonly<Record<string, Digest>> | null>
}

export interface PlanOptions {
  readonly root: string
  readonly store: Store
  readonly checks: readonly CheckRef[]
  readonly runtimeKey: Digest
  readonly transformer?: ModuleTransformer
  readonly policy?: Policy
  /** Current repository file list (from listRepoFiles), for detecting added files. */
  readonly files?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  /** fs implementation for reading current state (unpatched when capture hooks are active). */
  readonly fs?: StateFs
}

const MAX_DETAILS = 5
const NO_INJECTED_ENV: Readonly<Record<string, Digest | null>> = Object.freeze({})

/**
 * The skip rule. A check is skipped only when a prior passing, reusable record exists whose every
 * closure input, every shared runner input and the runtime key are unchanged, and whose flags are
 * all allowed by policy. Anything unknown, missing or failing means the check runs.
 */
export async function plan(options: PlanOptions): Promise<Decision[]> {
  const policy = options.policy ?? DEFAULT_POLICY
  const state = new CurrentState(options.root, options.store, options.env, options.fs)
  const runs = new Map<string, RunInfo | undefined>()
  const sharedVerdicts = new Map<string, readonly string[]>()
  const addedSince = new Map<string, readonly string[]>()
  const currentFiles = options.files ? new Set(options.files) : undefined
  let fileList: readonly string[] | undefined
  const listFiles = (): readonly string[] => {
    fileList ??= options.files ?? listRepoFiles(options.root)
    return fileList
  }
  const unitMemo = new Map<string, Promise<Readonly<Record<string, Digest>> | null>>()

  const getRun = (id: string): RunInfo | undefined => {
    if (!runs.has(id)) runs.set(id, options.store.getRun(id))
    return runs.get(id)
  }

  const sharedChanges = (run: RunInfo): readonly string[] => {
    const cached = sharedVerdicts.get(run.id)
    if (cached) return cached
    const changes: string[] = []
    for (const entry of run.shared) {
      // Shared inputs were read by the runner's main process, which sees the environment as is.
      const change = checkPlainEntry(entry, state, listFiles, NO_INJECTED_ENV)
      if (change) {
        changes.push(`runner input ${change}`)
        if (changes.length >= MAX_DETAILS) break
      }
    }
    if (currentFiles) {
      for (const added of addedFiles(run)) {
        if (isConfigLike(added) && configScope(added) === null) {
          changes.push(`new configuration-like file ${added}`)
          if (changes.length >= MAX_DETAILS) break
        }
      }
    }
    sharedVerdicts.set(run.id, changes)
    return changes
  }

  /** New configuration-like files that only affect files below their directory, by directory. */
  const scopedCache = new Map<string, readonly { path: string; dir: string }[]>()
  const scopedAdditions = (run: RunInfo): readonly { path: string; dir: string }[] => {
    if (!currentFiles) return []
    const cached = scopedCache.get(run.id)
    if (cached) return cached
    const out: { path: string; dir: string }[] = []
    for (const added of addedFiles(run)) {
      const dir = isConfigLike(added) ? configScope(added) : null
      if (dir !== null) out.push({ path: added, dir })
    }
    scopedCache.set(run.id, out)
    return out
  }

  const addedFiles = (run: RunInfo): readonly string[] => {
    const cached = addedSince.get(run.id)
    if (cached) return cached
    const before = new Set(run.files)
    const added = currentFiles ? [...currentFiles].filter((f) => !before.has(f)) : []
    addedSince.set(run.id, added)
    return added
  }

  const currentUnits = (
    entry: Extract<ClosureEntry, { k: 'mod' }>,
    project: string,
    srcNow: Digest,
    run: RunInfo,
  ): Promise<Readonly<Record<string, Digest>> | null> => {
    const transformer = options.transformer
    if (!transformer) return Promise.resolve(null)
    const key = `${entry.p}\u0000${srcNow}\u0000${entry.env}\u0000${project}\u0000${run.runtimeKey}\u0000${sharedDigest(run)}`
    let pending = unitMemo.get(key)
    if (!pending) {
      const cached = options.store.getUnits(key)
      pending = cached
        ? Promise.resolve(cached)
        : transformer
            .units(fromRepoPath(options.root, entry.p), entry.env, project)
            .then((units) => {
              if (units && !entry.dyn) options.store.putUnits(key, { ...units })
              return units
            })
            .catch(() => null)
      unitMemo.set(key, pending)
    }
    return pending
  }

  const evaluate = async (record: EvidenceRecord, check: CheckRef): Promise<string[]> => {
    const changes: string[] = []
    if (record.runtimeKey !== options.runtimeKey)
      return ['runtime changed (Node, platform, runner or locale)']
    const run = getRun(record.runId)
    if (!run) return ['run metadata missing']
    changes.push(...sharedChanges(run))
    if (changes.length > 0) return changes
    const scoped = scopedAdditions(run)
    if (scoped.length > 0) {
      const under = (p: string, dir: string): boolean => p === dir || p.startsWith(`${dir}/`)
      for (const { path: added, dir } of scoped) {
        if (under(check.path, dir) || record.closure.some((e) => 'p' in e && under(e.p, dir)))
          changes.push(`new configuration-like file ${added}`)
      }
      if (changes.length > 0) return changes
    }

    const strict = record.flags.some((f) => STRICT_SOURCE_FLAGS.has(f))
    const modStems = new Map<string, string>()
    for (const entry of record.closure) {
      if (entry.k === 'mod') {
        modStems.set(stem(entry.p), entry.p)
        const change = await checkModule(entry, check.project, strict || entry.raw === true, run)
        if (change) changes.push(change)
      } else {
        const change = checkPlainEntry(entry, state, listFiles, run.injectedEnv, run.injectedVaryingEnv)
        if (change) changes.push(change)
      }
      if (changes.length >= MAX_DETAILS) return changes
    }
    for (const added of addedFiles(run)) {
      const shadowed = modStems.get(stem(added))
      if (shadowed && shadowed !== added) {
        changes.push(`new file ${added} may shadow ${shadowed} during module resolution`)
        if (changes.length >= MAX_DETAILS) break
      }
    }
    return changes
  }

  const checkModule = async (
    entry: Extract<ClosureEntry, { k: 'mod' }>,
    project: string,
    strict: boolean,
    run: RunInfo,
  ): Promise<string | null> => {
    const srcNow = state.fileDigest(entry.p)
    if (srcNow === null) return `${entry.p} was removed`
    if (srcNow === entry.src && !entry.dyn) return null
    if (strict)
      return `${entry.p} changed (raw source compared because the test observes source text or positions)`
    const now = await currentUnits(entry, project, srcNow, run)
    if (!now) return `${entry.p} changed and could not be re-fingerprinted`
    const changed: string[] = []
    for (const [unit, fp] of Object.entries(entry.units)) {
      if (now[unit] !== fp) changed.push(unit === TOP_UNIT ? 'module top level' : describeUnit(unit))
    }
    if (changed.length === 0) return null
    const shown = changed.slice(0, 3).join(', ')
    const more = changed.length > 3 ? ` and ${changed.length - 3} more` : ''
    return `${entry.p}: ${shown}${more} changed`
  }

  const decide = async (check: CheckRef): Promise<Decision> => {
    let latest: EvidenceRecord | undefined
    let firstRejection: { reason: Decision['reason']; record: EvidenceRecord; details: string[] } | undefined
    const reject = (reason: Decision['reason'], record: EvidenceRecord, details: string[]): void => {
      if (!firstRejection) firstRejection = { reason, record, details }
    }
    for (const record of options.store.candidates(check, options.runtimeKey, policy.maxCandidates)) {
      latest ??= record
      if (record.verdict !== 'pass') {
        reject('no-evidence', record, ['the most recent evidence is a failure'])
        // A failure at identical inputs means the check still fails; never skip past it.
        if (record === latest) break
        continue
      }
      if (!record.reusable) {
        reject('not-reusable', record, [`the passing run is not evidence (${record.flags.join(', ')})`])
        continue
      }
      const blocked = record.flags.filter((f) => policy.blockingFlags.has(f))
      if (blocked.length > 0) {
        reject('blocked-flag', record, [
          `the check uses channels Veyrum does not observe: ${blocked.map((f) => describeChannel(f, record)).join(', ')}`,
        ])
        continue
      }
      const changes = await evaluate(record, check)
      if (changes.length === 0) {
        return decision(
          check,
          'skip',
          'reused',
          record,
          [],
          record.closure.length,
          record.flags,
          record.durationMs,
        )
      }
      const reason: Decision['reason'] = changes[0]?.startsWith('runtime changed')
        ? 'runtime-changed'
        : changes[0]?.startsWith('runner input') || changes[0]?.startsWith('new configuration-like')
          ? 'shared-inputs-changed'
          : 'inputs-changed'
      reject(reason, record, changes)
    }
    if (!latest || !firstRejection)
      return decision(check, 'run', 'no-evidence', null, ['no evidence recorded for this check'], 0, [], 0)
    const r = firstRejection
    return decision(
      check,
      'run',
      r.reason,
      r.record,
      r.details,
      r.record.closure.length,
      [],
      latest.durationMs,
    )
  }

  // Bounded concurrency: checks wait on transforms, but each holds its candidate records in memory.
  const out: Decision[] = new Array(options.checks.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < options.checks.length; i = next++) out[i] = await decide(options.checks[i]!)
  }
  await Promise.all(Array.from({ length: Math.min(PLAN_CONCURRENCY, options.checks.length) }, worker))
  return out
}

const PLAN_CONCURRENCY = 8

function decision(
  check: CheckRef,
  action: Decision['action'],
  reason: Decision['reason'],
  record: EvidenceRecord | null,
  details: readonly string[],
  closureSize: number,
  flagsRelied: readonly string[],
  durationMs: number,
): Decision {
  return {
    check,
    action,
    reason,
    recordId: record?.id ?? null,
    details,
    closureSize,
    flagsRelied,
    durationMs,
  }
}

/** Checks a non-module entry against the current state; returns a description of the change or null. */
function checkPlainEntry(
  entry: ClosureEntry,
  state: CurrentState,
  files: () => readonly string[],
  injected: Readonly<Record<string, Digest | null>>,
  injectedVarying: readonly string[] = [],
): string | null {
  switch (entry.k) {
    case 'dep':
    case 'file': {
      const now = state.fileDigest(entry.p)
      if (now === entry.h) return null
      if (entry.h === null) return `${entry.p} now exists`
      if (now === null) return `${entry.p} was removed`
      return `${entry.p} changed`
    }
    case 'manifest': {
      const now = state.manifestDigest(entry.p)
      if (now === entry.h) return null
      if (entry.h === null) return `${entry.p} now exists`
      if (now === null) return `${entry.p} was removed`
      return `${entry.p} changed`
    }
    case 'stat': {
      const now = state.statType(entry.p)
      return now === entry.t ? null : `${entry.p} is now ${now} (was ${entry.t})`
    }
    case 'dir': {
      const now = state.dirDigest(entry.p)
      return now === entry.h ? null : `directory listing of ${entry.p} changed`
    }
    case 'env': {
      if (injectedVarying.includes(entry.n)) return null
      const now = state.envDigest(entry.n, injected)
      return now === entry.h ? null : `environment variable ${entry.n} changed`
    }
    case 'pkgname':
      return state.packageNameDigest(entry.n, files) === entry.h
        ? null
        : `the repository packages named ${entry.n} changed`
    case 'mod':
      return `${entry.p} requires module comparison`
  }
}

const sharedDigestCache = new WeakMap<RunInfo, Digest>()
function sharedDigest(run: RunInfo): Digest {
  let d = sharedDigestCache.get(run)
  if (!d) {
    d = digest(JSON.stringify(run.shared))
    sharedDigestCache.set(run, d)
  }
  return d
}

/** A blocking flag with what it was about, when the record names it (`net-remote (host:443)`). */
function describeChannel(flag: string, record: EvidenceRecord): string {
  const channels = record.channels
  const named =
    flag === 'net-remote'
      ? channels?.net
      : flag === 'spawn'
        ? channels?.spawn
        : flag === 'browser-unobserved'
          ? channels?.browser
          : flag === 'server-unobserved'
            ? channels?.server
            : undefined
  if (!named || named.length === 0) return flag
  const more = named.length > 3 ? ` and ${named.length - 3} more` : ''
  return `${flag} (${named.slice(0, 3).join(', ')}${more})`
}

/** Renders `@top/fn:add#0/v:inner#0` as `add > inner`, dropping ordinals of 0. */
export function describeUnit(unit: string): string {
  return unit
    .split('/')
    .slice(1)
    .map((part) => {
      const [name, ordinal] = part.split('#')
      const bare = (name ?? part).replace(/^(fn|m|p|f|v|a|c):/, '')
      return ordinal && ordinal !== '0' ? `${bare}#${ordinal}` : bare
    })
    .join(' > ')
}
