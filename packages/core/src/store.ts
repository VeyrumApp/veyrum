import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib'
import { type Digest, digest } from './hash.ts'
import type { CheckRef, ClosureEntry, EvidenceRecord, RunInfo, TestOutcome } from './types.ts'

const SCHEMA_VERSION = 1

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
  tests: string
  closure_digest: string
}

/**
 * Local evidence store. Everything in it is a digest, a repository-relative path, a test name, an
 * outcome or a duration: source code never enters the store.
 */
export class Store {
  readonly file: string
  private readonly db: DatabaseSync
  private readonly closureCache = new Map<string, readonly ClosureEntry[]>()

  private constructor(file: string, db: DatabaseSync) {
    this.file = file
    this.db = db
  }

  static open(file: string): Store {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, revision TEXT, runtime_key TEXT NOT NULL, info BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blobs (digest TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, check_path TEXT NOT NULL, project TEXT NOT NULL, run_id TEXT NOT NULL,
        runtime_key TEXT NOT NULL, verdict TEXT NOT NULL, reusable INTEGER NOT NULL, created_at TEXT NOT NULL,
        revision TEXT, duration_ms REAL NOT NULL, flags TEXT NOT NULL, tests TEXT NOT NULL,
        closure_digest TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_by_check ON records (check_path, project, created_at DESC);
      CREATE TABLE IF NOT EXISTS stat_cache (
        path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL, ino INTEGER NOT NULL, digest TEXT
      );
      CREATE TABLE IF NOT EXISTS unit_cache (key TEXT PRIMARY KEY, units TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verifications (
        run_id TEXT NOT NULL, check_path TEXT NOT NULL, project TEXT NOT NULL, record_id TEXT NOT NULL,
        kind TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, check_path, project)
      );
    `)
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema') as
      | { value: string }
      | undefined
    if (!row) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION))
    else if (Number(row.value) !== SCHEMA_VERSION) {
      throw new Error(
        `Veyrum store ${file} has schema ${row.value}, expected ${SCHEMA_VERSION}. Delete it to rebuild.`,
      )
    }
    return new Store(file, db)
  }

  close(): void {
    this.db.close()
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
    this.db
      .prepare(
        'INSERT OR REPLACE INTO runs (id, created_at, revision, runtime_key, info) VALUES (?, ?, ?, ?, ?)',
      )
      .run(run.id, run.createdAt, run.revision, run.runtimeKey, pack(run))
  }

  getRun(id: string): RunInfo | undefined {
    const row = this.db.prepare('SELECT info FROM runs WHERE id = ?').get(id) as
      | { info: Uint8Array }
      | undefined
    return row ? (unpack(row.info) as RunInfo) : undefined
  }

  putRecord(record: EvidenceRecord): void {
    const closureJson = JSON.stringify(record.closure)
    const closureDigest = digest(closureJson)
    // Unchanged checks produce identical closures run after run; store each distinct one once.
    const known = this.db.prepare('SELECT 1 FROM blobs WHERE digest = ?').get(closureDigest)
    if (!known)
      this.db
        .prepare('INSERT INTO blobs (digest, data) VALUES (?, ?)')
        .run(closureDigest, compress(closureJson))
    this.db
      .prepare(
        `INSERT OR REPLACE INTO records (id, check_path, project, run_id, runtime_key, verdict, reusable, created_at,
          revision, duration_ms, flags, tests, closure_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
        JSON.stringify(record.tests),
        closureDigest,
      )
  }

  /** Records for a check, newest first. */
  /**
   * Deletes every run recorded at a revision, with its records and verifications. Returns the
   * number of runs deleted. Content-addressed closures are left for garbage collection.
   */
  forgetRevision(revision: string): number {
    let runs = 0
    this.transaction(() => {
      this.db
        .prepare('DELETE FROM verifications WHERE run_id IN (SELECT id FROM runs WHERE revision = ?)')
        .run(revision)
      this.db.prepare('DELETE FROM records WHERE revision = ?').run(revision)
      runs = Number(this.db.prepare('DELETE FROM runs WHERE revision = ?').run(revision).changes)
    })
    return runs
  }

  recordsFor(check: CheckRef, limit = 20): EvidenceRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM records WHERE check_path = ? AND project = ? ORDER BY created_at DESC, id LIMIT ?',
      )
      .all(check.path, check.project, limit) as unknown as RecordRow[]
    return rows.map((r) => this.hydrate(r))
  }

  getRecord(id: string): EvidenceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined
    return row ? this.hydrate(row) : undefined
  }

  checks(): CheckRef[] {
    const rows = this.db
      .prepare('SELECT DISTINCT check_path, project FROM records ORDER BY check_path')
      .all() as {
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
    this.db
      .prepare(
        `INSERT OR REPLACE INTO verifications (run_id, check_path, project, record_id, kind, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, check.path, check.project, recordId, kind, outcome, new Date().toISOString())
  }

  /** The escape record: how many reuse decisions were verified, and how many would have been wrong. */
  verificationStats(): {
    verified: number
    escapes: number
    byKind: Record<string, { verified: number; escapes: number }>
  } {
    const rows = this.db
      .prepare('SELECT kind, outcome, COUNT(*) AS n FROM verifications GROUP BY kind, outcome')
      .all() as { kind: string; outcome: string; n: number }[]
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

  stats(): { runs: number; records: number; closures: number; bytes: number } {
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    const bytes = this.file === ':memory:' ? 0 : fileSize(this.file) + fileSize(`${this.file}-wal`)
    return { runs: count('runs'), records: count('records'), closures: count('blobs'), bytes }
  }

  getStat(p: string): { size: number; mtimeNs: string; ino: number; digest: Digest | null } | undefined {
    const row = this.db.prepare('SELECT size, mtime_ns, ino, digest FROM stat_cache WHERE path = ?').get(p) as
      | { size: number; mtime_ns: string; ino: number; digest: string | null }
      | undefined
    return row ? { size: row.size, mtimeNs: row.mtime_ns, ino: row.ino, digest: row.digest } : undefined
  }

  putStat(p: string, size: number, mtimeNs: string, ino: number, value: Digest | null): void {
    this.db
      .prepare('INSERT OR REPLACE INTO stat_cache (path, size, mtime_ns, ino, digest) VALUES (?, ?, ?, ?, ?)')
      .run(p, size, mtimeNs, ino, value)
  }

  getUnits(key: string): Record<string, Digest> | undefined {
    const row = this.db.prepare('SELECT units FROM unit_cache WHERE key = ?').get(key) as
      | { units: string }
      | undefined
    return row ? (JSON.parse(row.units) as Record<string, Digest>) : undefined
  }

  putUnits(key: string, units: Record<string, Digest>): void {
    this.db
      .prepare('INSERT OR REPLACE INTO unit_cache (key, units) VALUES (?, ?)')
      .run(key, JSON.stringify(units))
  }

  /** Raw cached text (for example serialized module units keyed by code digest). */
  getCached(key: string): string | undefined {
    const row = this.db.prepare('SELECT units FROM unit_cache WHERE key = ?').get(key) as
      | { units: string }
      | undefined
    return row?.units
  }

  putCached(key: string, text: string): void {
    this.db.prepare('INSERT OR REPLACE INTO unit_cache (key, units) VALUES (?, ?)').run(key, text)
  }

  private hydrate(row: RecordRow): EvidenceRecord {
    let closure = this.closureCache.get(row.closure_digest)
    if (!closure) {
      const blob = this.db.prepare('SELECT data FROM blobs WHERE digest = ?').get(row.closure_digest) as
        | { data: Uint8Array }
        | undefined
      closure = blob ? (JSON.parse(brotliDecompressSync(blob.data).toString('utf8')) as ClosureEntry[]) : []
      this.closureCache.set(row.closure_digest, closure)
    }
    return {
      id: row.id,
      check: row.check_path,
      project: row.project,
      runId: row.run_id,
      runtimeKey: row.runtime_key,
      verdict: row.verdict === 'pass' ? 'pass' : 'fail',
      reusable: row.reusable === 1,
      flags: JSON.parse(row.flags) as string[],
      tests: JSON.parse(row.tests) as TestOutcome[],
      durationMs: row.duration_ms,
      closure,
      createdAt: row.created_at,
      revision: row.revision,
    }
  }
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

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}
