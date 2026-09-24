import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite'
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib'
import { type Digest, digest } from './hash.ts'
import {
  type CheckRef,
  type ClosureEntry,
  type EvidenceRecord,
  FLAGS,
  type RecordChannels,
  type RunInfo,
  type TestOutcome,
} from './types.ts'

const SCHEMA_VERSION = 3

interface RecordRow {
  id: string
  check_path: string
  project: string
  run_id: string
  runtime_key: string
  verdict: string
  reusable: number
  created_at: string
  revision: string | null
  duration_ms: number
  flags: string
  /** Brotli-compressed JSON; plain JSON in rows written before schema 3. */
  tests: string | Uint8Array
  closure_digest: string
  channels: string
}

/**
 * Local evidence store. Everything in it is a digest, a repository-relative path, a test name, an
 * outcome or a duration: source code never enters the store.
 */
export class Store {
  readonly file: string
  private readonly db: DatabaseSyncType
  /**
   * Recently hydrated closures, least recently used first. Bounded: a long-lived process (the
   * benchmark rig, a server) must not accumulate every closure it ever read.
   */
  private readonly closureCache = new Map<string, readonly ClosureEntry[]>()
  private static readonly CLOSURE_CACHE_SIZE = 64
  /** Closure entries by id, and ids by entry JSON; each cleared when it grows past the bound. */
  private readonly entryCache = new Map<number, ClosureEntry>()
  private readonly entryIds = new Map<string, number>()
  private static readonly ENTRY_CACHE_SIZE = 200_000

  private constructor(file: string, db: DatabaseSyncType) {
    this.file = file
    this.db = db
  }

  static open(file: string): Store {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new (sqlite().DatabaseSync)(file)
    // A store that fails to open is closed again: Windows cannot move aside a file still open.
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY, created_at TEXT NOT NULL, revision TEXT, runtime_key TEXT NOT NULL, info BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS blobs (digest TEXT PRIMARY KEY, data BLOB NOT NULL, base TEXT);
        CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, digest TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS records (
          id TEXT PRIMARY KEY, check_path TEXT NOT NULL, project TEXT NOT NULL, run_id TEXT NOT NULL,
          runtime_key TEXT NOT NULL, verdict TEXT NOT NULL, reusable INTEGER NOT NULL, created_at TEXT NOT NULL,
          revision TEXT, duration_ms REAL NOT NULL, flags TEXT NOT NULL, tests TEXT NOT NULL,
          closure_digest TEXT NOT NULL, channels TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS records_by_check ON records (check_path, project, created_at DESC);
        CREATE INDEX IF NOT EXISTS records_by_runtime ON records (check_path, project, runtime_key, created_at DESC);
        CREATE TABLE IF NOT EXISTS stat_cache (
          path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL, ino INTEGER NOT NULL, digest TEXT
        );
        CREATE TABLE IF NOT EXISTS unit_cache (
          key TEXT PRIMARY KEY, units TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS verifications (
          run_id TEXT NOT NULL, check_path TEXT NOT NULL, project TEXT NOT NULL, record_id TEXT NOT NULL,
          kind TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, check_path, project)
        );
      `)
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema') as
        | { value: string }
        | undefined
      if (row && !(Number(row.value) >= 1 && Number(row.value) <= SCHEMA_VERSION))
        throw new Error(
          `Veyrum store ${file} has schema ${row.value}, expected ${SCHEMA_VERSION}. Delete it to rebuild.`,
        )
      // Columns added since schema 1, added in place to tables an older schema created. Checked on
      // every open: cheap, and a store an interrupted upgrade left behind is completed.
      // Schema 2 names the unobserved channels a record used; older records have none recorded.
      addColumn(db, 'records', 'channels', `TEXT NOT NULL DEFAULT '{}'`)
      // Schema 3 notes the last run that used each cached module, so unused ones can be pruned,
      // and stores closures as entry ids, as deltas against another closure (see putClosure).
      addColumn(db, 'unit_cache', 'used', 'INTEGER NOT NULL DEFAULT 0')
      addColumn(db, 'blobs', 'base', 'TEXT')
      if (row?.value !== String(SCHEMA_VERSION))
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
          'schema',
          String(SCHEMA_VERSION),
        )
      return new Store(file, db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  private readonly statements = new Map<string, StatementSync>()

  /** A prepared statement, compiled once per store: statements run once per file or record. */
  private sql(text: string): StatementSync {
    let statement = this.statements.get(text)
    if (!statement) {
      statement = this.db.prepare(text)
      this.statements.set(text, statement)
    }
    return statement
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  putRun(run: RunInfo): void {
    this.sql(
      'INSERT OR REPLACE INTO runs (id, created_at, revision, runtime_key, info) VALUES (?, ?, ?, ?, ?)',
    ).run(run.id, run.createdAt, run.revision, run.runtimeKey, pack(run))
  }

  getRun(id: string): RunInfo | undefined {
    const row = this.sql('SELECT info FROM runs WHERE id = ?').get(id) as { info: Uint8Array } | undefined
    return row ? (unpack(row.info) as RunInfo) : undefined
  }

  putRecord(record: EvidenceRecord): void {
    const closureDigest = this.putClosure(record)
    this.sql(
      `INSERT OR REPLACE INTO records (id, check_path, project, run_id, runtime_key, verdict, reusable, created_at,
          revision, duration_ms, flags, tests, closure_digest, channels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.check,
      record.project,
      record.runId,
      record.runtimeKey,
      record.verdict,
      record.reusable ? 1 : 0,
      record.createdAt,
      record.revision,
      record.durationMs,
      JSON.stringify(record.flags),
      pack(record.tests),
      closureDigest,
      JSON.stringify(record.channels ?? {}),
    )
  }

  /**
   * Stores a record's closure once per distinct content (unchanged checks produce identical
   * closures run after run) and returns its digest. Closures of different checks share most of
   * their entries (dependencies, configuration), so each distinct entry is stored once and a
   * closure is a list of entry ids. A check's closures differ from one record to the next in a
   * few entries, so a new one is stored as a delta against a full list of the same check (a
   * keyframe): ranges of the keyframe's ids, and the ids it lacks. A delta that grows past a
   * quarter of the entries starts a new keyframe.
   */
  private putClosure(record: EvidenceRecord): Digest {
    const texts = record.closure.map((entry) => JSON.stringify(entry))
    const closureDigest = digest(`[${texts.join(',')}]`)
    if (this.sql('SELECT 1 FROM blobs WHERE digest = ?').get(closureDigest)) return closureDigest
    const ids = this.internEntries(texts)
    const previous = this.sql(
      `SELECT b.digest, b.base FROM records r JOIN blobs b ON b.digest = r.closure_digest
         WHERE r.check_path = ? AND r.project = ? ORDER BY r.created_at DESC, r.id LIMIT 1`,
    ).get(record.check, record.project) as { digest: string; base: string | null } | undefined
    const keyframe = previous ? (previous.base ?? previous.digest) : null
    const base = keyframe ? this.itemsOf(keyframe) : null
    const ops = keyframe && base ? closureDelta(base, ids) : null
    this.sql('INSERT INTO blobs (digest, data, base) VALUES (?, ?, ?)').run(
      closureDigest,
      compress(JSON.stringify(ops ?? ids)),
      ops ? keyframe : null,
    )
    return closureDigest
  }

  /** The ids of entries (as JSON texts), adding the entries this store does not have yet. */
  private internEntries(texts: readonly string[]): number[] {
    if (this.entryIds.size > Store.ENTRY_CACHE_SIZE) this.entryIds.clear()
    const missing = [...new Set(texts.filter((t) => !this.entryIds.has(t)))]
    if (missing.length > 0) {
      const digests = missing.map((t) => digest(t))
      const found = new Map(
        (
          this.sql('SELECT id, digest FROM entries WHERE digest IN (SELECT value FROM json_each(?))').all(
            JSON.stringify(digests),
          ) as { id: number; digest: string }[]
        ).map((row) => [row.digest, Number(row.id)]),
      )
      const insert = this.sql('INSERT INTO entries (digest, data) VALUES (?, ?)')
      missing.forEach((text, i) => {
        const d = digests[i]!
        const id = found.get(d) ?? Number(insert.run(d, text).lastInsertRowid)
        this.entryIds.set(text, id)
      })
    }
    return texts.map((t) => this.entryIds.get(t)!)
  }

  /**
   * A stored closure's items: entry ids, or entries themselves in stores written before schema 3.
   * Null when the closure or its base is missing.
   */
  private itemsOf(digest: string): readonly Item[] | null {
    const blob = this.sql('SELECT data, base FROM blobs WHERE digest = ?').get(digest) as
      | { data: Uint8Array; base: string | null }
      | undefined
    if (!blob) return null
    const data = unpack(blob.data) as Item[]
    if (!blob.base) return data
    const base = this.itemsOf(blob.base)
    return base ? applyDelta(base, data as unknown as DeltaOp[]) : null
  }

  /** The entries items stand for, or null if one is missing. */
  private resolve(items: readonly Item[]): ClosureEntry[] | null {
    if (this.entryCache.size > Store.ENTRY_CACHE_SIZE) this.entryCache.clear()
    const missing = [
      ...new Set(items.filter((i): i is number => typeof i === 'number' && !this.entryCache.has(i))),
    ]
    if (missing.length > 0) {
      const rows = this.sql('SELECT id, data FROM entries WHERE id IN (SELECT value FROM json_each(?))').all(
        JSON.stringify(missing),
      ) as { id: number; data: string }[]
      for (const row of rows) this.entryCache.set(Number(row.id), JSON.parse(row.data) as ClosureEntry)
    }
    const out: ClosureEntry[] = []
    for (const item of items) {
      const entry = typeof item === 'number' ? this.entryCache.get(item) : item
      if (!entry) return null
      out.push(entry)
    }
    return out
  }

  /**
   * Deletes entries no stored closure refers to. Every closure has to be read to know, so this
   * runs only once the entries have doubled since the last sweep.
   */
  private sweepEntries(): void {
    const count = (this.sql('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n
    const row = this.sql('SELECT value FROM meta WHERE key = ?').get('entries_swept') as
      | { value: string }
      | undefined
    if (count <= 2 * Number(row?.value ?? 0) + 10_000) return
    const live = new Set<number>()
    for (const blob of this.sql('SELECT data FROM blobs').iterate() as Iterable<{ data: Uint8Array }>) {
      for (const item of unpack(blob.data) as unknown[]) if (typeof item === 'number') live.add(item)
    }
    this.sql('DELETE FROM entries WHERE id NOT IN (SELECT value FROM json_each(?))').run(
      JSON.stringify([...live]),
    )
    this.sql('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('entries_swept', String(live.size))
    this.entryCache.clear()
    this.entryIds.clear()
  }

  /**
   * Deletes every run recorded at a revision, with its records and verifications. Returns the
   * number of runs deleted. Content-addressed closures are left for garbage collection.
   */
  forgetRevision(revision: string): number {
    let runs = 0
    this.transaction(() => {
      this.sql('DELETE FROM verifications WHERE run_id IN (SELECT id FROM runs WHERE revision = ?)').run(
        revision,
      )
      this.sql('DELETE FROM records WHERE revision = ?').run(revision)
      runs = Number(this.sql('DELETE FROM runs WHERE revision = ?').run(revision).changes)
    })
    return runs
  }

  /**
   * The most recent records for a check made on a runtime, newest first, each hydrated only when
   * reached: a planner that stops at the first reusable record never decompresses the others.
   * Records of other runtimes can never be reused; when there is none for this one, the newest
   * record of any runtime is returned alone, so the decision can say the runtime changed.
   */
  *candidates(check: CheckRef, runtimeKey: string, limit = 20): Generator<EvidenceRecord> {
    let rows = this.sql(
      `SELECT * FROM records WHERE check_path = ? AND project = ? AND runtime_key = ?
         ORDER BY created_at DESC, id LIMIT ?`,
    ).all(check.path, check.project, runtimeKey, limit) as unknown as RecordRow[]
    if (rows.length === 0)
      rows = this.sql(
        'SELECT * FROM records WHERE check_path = ? AND project = ? ORDER BY created_at DESC, id LIMIT 1',
      ).all(check.path, check.project) as unknown as RecordRow[]
    for (const row of rows) yield this.hydrate(row)
  }

  recordsFor(check: CheckRef, limit = 20): EvidenceRecord[] {
    const rows = this.sql(
      'SELECT * FROM records WHERE check_path = ? AND project = ? ORDER BY created_at DESC, id LIMIT ?',
    ).all(check.path, check.project, limit) as unknown as RecordRow[]
    return rows.map((r) => this.hydrate(r))
  }

  getRecord(id: string): EvidenceRecord | undefined {
    const row = this.sql('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined
    return row ? this.hydrate(row) : undefined
  }

  checks(): CheckRef[] {
    const rows = this.sql('SELECT DISTINCT check_path, project FROM records ORDER BY check_path').all() as {
      check_path: string
      project: string
    }[]
    return rows.map((r) => ({ path: r.check_path, project: r.project }))
  }

  /**
   * Records that a reuse decision was checked by running the file anyway. A failing outcome is an
   * escape: the file would have been reused although it fails.
   */
  putVerification(
    runId: string,
    check: CheckRef,
    recordId: string,
    kind: string,
    outcome: 'pass' | 'fail',
  ): void {
    this.sql(
      `INSERT OR REPLACE INTO verifications (run_id, check_path, project, record_id, kind, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, check.path, check.project, recordId, kind, outcome, new Date().toISOString())
  }

  /** The escape record: how many reuse decisions were verified, and how many would have been wrong. */
  verificationStats(): {
    verified: number
    escapes: number
    byKind: Record<string, { verified: number; escapes: number }>
  } {
    const rows = this.sql(
      'SELECT kind, outcome, COUNT(*) AS n FROM verifications GROUP BY kind, outcome',
    ).all() as { kind: string; outcome: string; n: number }[]
    const byKind: Record<string, { verified: number; escapes: number }> = {}
    let verified = 0
    let escapes = 0
    for (const r of rows) {
      const k = byKind[r.kind] ?? { verified: 0, escapes: 0 }
      byKind[r.kind] = k
      k.verified += r.n
      verified += r.n
      if (r.outcome === 'fail') {
        k.escapes += r.n
        escapes += r.n
      }
    }
    return { verified, escapes, byKind }
  }

  stats(): { runs: number; records: number; closures: number; entries: number; bytes: number } {
    const count = (table: string): number =>
      (this.sql(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    const bytes = this.file === ':memory:' ? 0 : fileSize(this.file) + fileSize(`${this.file}-wal`)
    return {
      runs: count('runs'),
      records: count('records'),
      closures: count('blobs'),
      entries: count('entries'),
      bytes,
    }
  }

  getStat(p: string): { size: number; mtimeNs: string; ino: number; digest: Digest | null } | undefined {
    const statement = this.sql('SELECT size, mtime_ns, ino, digest FROM stat_cache WHERE path = ?')
    // Windows file IDs exceed 2^53: read as bigint, then converted as fs.Stats converts them.
    statement.setReadBigInts(true)
    const row = statement.get(p) as
      | { size: bigint; mtime_ns: string; ino: bigint; digest: string | null }
      | undefined
    return row
      ? { size: Number(row.size), mtimeNs: row.mtime_ns, ino: Number(row.ino), digest: row.digest }
      : undefined
  }

  putStat(p: string, size: number, mtimeNs: string, ino: number, value: Digest | null): void {
    this.sql(
      'INSERT OR REPLACE INTO stat_cache (path, size, mtime_ns, ino, digest) VALUES (?, ?, ?, ?, ?)',
    ).run(p, size, mtimeNs, ino, value)
  }

  getUnits(key: string): Record<string, Digest> | undefined {
    const text = this.getCached(key)
    return text === undefined ? undefined : (JSON.parse(text) as Record<string, Digest>)
  }

  putUnits(key: string, units: Record<string, Digest>): void {
    this.putCached(key, JSON.stringify(units))
  }

  /** Raw cached text (for example serialized module units keyed by code digest). */
  getCached(key: string): string | undefined {
    const row = this.sql('SELECT units FROM unit_cache WHERE key = ?').get(key) as
      | { units: string }
      | undefined
    // Marking the entry used is deferred to prune: a write per lookup would slow planning.
    if (row) this.usedKeys.add(key)
    return row?.units
  }

  putCached(key: string, text: string): void {
    this.sql('INSERT OR REPLACE INTO unit_cache (key, units, used) VALUES (?, ?, ?)').run(
      key,
      text,
      this.generation(),
    )
    this.usedKeys.add(key)
  }

  /** Cache keys read since the last prune. */
  private readonly usedKeys = new Set<string>()

  /** The number of prunes so far: cached entries note the generation that last used them. */
  private generation(): number {
    const row = this.sql('SELECT value FROM meta WHERE key = ?').get('generation') as
      | { value: string }
      | undefined
    return row ? Number(row.value) : 0
  }

  /**
   * Keeps the store from growing without bound. Per check and runtime, only the records the
   * planner still reads (the newest `keepRecords`) are kept, then runs and closures no record
   * refers to, and cached module units no run has used in `keepUnitsFor` runs, are deleted.
   * Verifications, the escape record, are kept. Returns the number of records deleted.
   */
  prune(options: { keepRecords: number; keepUnitsFor?: number }): number {
    const keepUnitsFor = options.keepUnitsFor ?? 50
    let deleted = 0
    this.transaction(() => {
      const generation = this.generation() + 1
      this.sql('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('generation', String(generation))
      const touch = this.sql('UPDATE unit_cache SET used = ? WHERE key = ?')
      for (const key of this.usedKeys) touch.run(generation, key)
      this.usedKeys.clear()
      this.sql('DELETE FROM unit_cache WHERE used < ?').run(generation - keepUnitsFor)
      deleted = Number(
        this.sql(
          `DELETE FROM records WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (
                 PARTITION BY check_path, project, runtime_key ORDER BY created_at DESC, id
               ) AS n FROM records
             ) WHERE n > ?
           )`,
        ).run(options.keepRecords).changes,
      )
      this.sql('DELETE FROM runs WHERE id NOT IN (SELECT run_id FROM records)').run()
      // A closure is kept while a record refers to it, directly or as the base of its delta.
      this.sql(
        `WITH RECURSIVE live(digest) AS (
           SELECT closure_digest FROM records
           UNION SELECT b.base FROM blobs b JOIN live ON b.digest = live.digest WHERE b.base IS NOT NULL
         )
         DELETE FROM blobs WHERE digest NOT IN (SELECT digest FROM live)`,
      ).run()
      this.sweepEntries()
    })
    this.closureCache.clear()
    // Deleted rows leave free pages; give them back once they are a large share of the file.
    const pages = (this.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
    const free = (this.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
    if (pages > 256 && free > pages / 4) this.db.exec('VACUUM')
    return deleted
  }

  /**
   * Adds another store's evidence to this one: runs, records, closures and verifications (the
   * stores of parallel CI jobs, for example). Rows this store already has are kept. Returns the
   * number of records added.
   */
  merge(file: string): number {
    const other = Store.open(file)
    const verifications = 'run_id, check_path, project, record_id, kind, outcome, created_at'
    let added = 0
    try {
      this.transaction(() => {
        const has = this.sql('SELECT 1 FROM runs WHERE id = ?')
        for (const { id } of other.sql('SELECT id FROM runs').all() as { id: string }[])
          if (!has.get(id)) this.putRun(other.getRun(id)!)
        // Entry ids differ between stores, so records are added one by one, oldest first, and
        // their closures stored anew.
        const known = this.sql('SELECT 1 FROM records WHERE id = ?')
        const ids = other.sql('SELECT id FROM records ORDER BY created_at, id').all() as { id: string }[]
        for (const { id } of ids) {
          if (known.get(id)) continue
          this.putRecord(other.getRecord(id)!)
          added++
        }
        const insert = this.sql(
          `INSERT OR IGNORE INTO verifications (${verifications}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const v of other.sql(`SELECT ${verifications} FROM verifications`).all() as Record<
          string,
          string
        >[])
          insert.run(v.run_id!, v.check_path!, v.project!, v.record_id!, v.kind!, v.outcome!, v.created_at!)
        const generation = this.generation()
        const unit = this.sql('INSERT OR IGNORE INTO unit_cache (key, units, used) VALUES (?, ?, ?)')
        for (const u of other.sql('SELECT key, units FROM unit_cache').all() as {
          key: string
          units: string
        }[])
          unit.run(u.key, u.units, generation)
      })
    } finally {
      other.close()
    }
    return added
  }

  /** A stored closure, or null when it is missing (a record without one is never evidence). */
  private closure(digest: string): readonly ClosureEntry[] | null {
    const cached = this.closureCache.get(digest)
    if (cached) {
      this.closureCache.delete(digest)
      this.closureCache.set(digest, cached)
      return cached
    }
    const items = this.itemsOf(digest)
    const closure = items ? this.resolve(items) : null
    if (!closure) return null
    this.closureCache.set(digest, closure)
    if (this.closureCache.size > Store.CLOSURE_CACHE_SIZE) {
      const oldest = this.closureCache.keys().next().value
      if (oldest !== undefined) this.closureCache.delete(oldest)
    }
    return closure
  }

  private hydrate(row: RecordRow): EvidenceRecord {
    const closure = this.closure(row.closure_digest)
    const channels = JSON.parse(row.channels) as RecordChannels
    const flags = JSON.parse(row.flags) as string[]
    return {
      id: row.id,
      check: row.check_path,
      project: row.project,
      runId: row.run_id,
      runtimeKey: row.runtime_key,
      verdict: row.verdict === 'pass' ? 'pass' : 'fail',
      reusable: row.reusable === 1 && closure !== null,
      flags: closure ? flags : [...new Set([...flags, FLAGS.captureIncomplete])],
      tests: (typeof row.tests === 'string' ? JSON.parse(row.tests) : unpack(row.tests)) as TestOutcome[],
      durationMs: row.duration_ms,
      closure: closure ?? [],
      createdAt: row.created_at,
      revision: row.revision,
      ...(Object.keys(channels).length > 0 ? { channels } : {}),
    }
  }
}

/** A stored closure item: an entry id, or (before schema 3) the entry itself. */
type Item = number | ClosureEntry

/** A delta between closures: a range [start, length] of the base's items, or an item. */
type DeltaOp = readonly [number, number] | Item

/**
 * The items as ranges of the base's items and their own items, or null when too much of them is
 * new for a delta to pay. Closures are sorted, so a single forward pass over the base finds the
 * shared items; an exact reconstruction does not depend on that, only the delta's size does.
 */
export function closureDelta(base: readonly Item[], items: readonly Item[]): DeltaOp[] | null {
  const keyOf = (item: Item): number | string => (typeof item === 'number' ? item : JSON.stringify(item))
  const positions = new Map<number | string, number>()
  base.forEach((item, i) => {
    const key = keyOf(item)
    if (!positions.has(key)) positions.set(key, i)
  })
  const ops: DeltaOp[] = []
  let literals = 0
  let run: [number, number] | null = null
  for (const item of items) {
    const at = positions.get(keyOf(item))
    if (at !== undefined && run && run[0] + run[1] === at) {
      run[1]++
      continue
    }
    if (at !== undefined) {
      run = [at, 1]
      ops.push(run)
      continue
    }
    run = null
    ops.push(item)
    literals++
  }
  return literals * 4 > items.length || ops.length * 8 > items.length + 8 ? null : ops
}

/** The items a delta describes, or null if it does not fit its base. */
function applyDelta(base: readonly Item[], ops: readonly DeltaOp[]): Item[] | null {
  const out: Item[] = []
  for (const op of ops) {
    if (Array.isArray(op)) {
      const [start, length] = op as readonly [number, number]
      if (start < 0 || start + length > base.length) return null
      for (let i = start; i < start + length; i++) out.push(base[i]!)
    } else out.push(op as Item)
  }
  return out
}

/** Fast Brotli: the default quality (11) costs a fraction of a second per closure. */
const BROTLI_FAST = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }

function compress(text: string): Uint8Array {
  return brotliCompressSync(text, BROTLI_FAST)
}

function pack(value: unknown): Uint8Array {
  return compress(JSON.stringify(value))
}

function unpack(data: Uint8Array): unknown {
  return JSON.parse(brotliDecompressSync(data).toString('utf8'))
}

/**
 * node:sqlite, loaded when a store opens rather than when this module loads: Node 22 warns that it
 * is experimental as it loads, and the CLI can only silence that once its own code runs.
 */
function sqlite(): typeof import('node:sqlite') {
  return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
}

/** Adds a column a table created by an older schema lacks (tables created since have it). */
function addColumn(db: DatabaseSyncType, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!columns.some((c) => c.name === column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}
