import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { Store } from '../src/store.ts'
import type { EvidenceRecord, RunInfo } from '../src/types.ts'

let dir: string | undefined
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

test('a schema 1 store is migrated in place and keeps its records', () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-store-'))
  const file = path.join(dir, 'store.sqlite')
  // The schema 1 records table, before records named their unobserved channels.
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('schema', '1');
    CREATE TABLE records (
      id TEXT PRIMARY KEY, check_path TEXT NOT NULL, project TEXT NOT NULL, run_id TEXT NOT NULL,
      runtime_key TEXT NOT NULL, verdict TEXT NOT NULL, reusable INTEGER NOT NULL, created_at TEXT NOT NULL,
      revision TEXT, duration_ms REAL NOT NULL, flags TEXT NOT NULL, tests TEXT NOT NULL,
      closure_digest TEXT NOT NULL
    );
    INSERT INTO records VALUES ('r1', 'test/a.test.ts', '', 'run', 'key', 'pass', 1, '2026-09-23T00:00:00Z',
      NULL, 5, '["spawn"]', '[]', 'none');
  `)
  db.close()
  const store = Store.open(file)
  try {
    const record = store.getRecord('r1')
    expect(record?.channels).toBeUndefined()
    // Its closure was never stored: a record without one is not evidence.
    expect(record?.flags).toEqual(['spawn', 'capture-incomplete'])
    expect(record?.reusable).toBe(false)
    store.putRecord({ ...record!, id: 'r2', channels: { spawn: ['/usr/bin/turbo'] } })
    expect(store.getRecord('r2')?.channels).toEqual({ spawn: ['/usr/bin/turbo'] })
  } finally {
    store.close()
  }
})

const run = (id: string, runtimeKey = 'node24'): RunInfo => ({
  id,
  createdAt: '2026-09-24T00:00:00Z',
  revision: null,
  runtimeKey,
  runtime: {},
  shared: [],
  injectedEnv: {},
  files: [],
  runner: { name: 'vitest', version: '5.0.1', isolate: true, pool: 'forks' },
})

const record = (id: string, runId: string, minute: number, runtimeKey = 'node24'): EvidenceRecord => ({
  id,
  check: 'test/a.test.ts',
  project: '',
  runId,
  runtimeKey,
  verdict: 'pass',
  reusable: true,
  flags: [],
  tests: [],
  durationMs: 5,
  closure: [{ k: 'file', p: `fixtures/${id}.txt`, h: id }],
  createdAt: `2026-09-24T00:${String(minute).padStart(2, '0')}:00Z`,
  revision: null,
})

const openIn = (name: string): Store => {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-store-'))
  return Store.open(path.join(dir, name))
}

const ids = (store: Store, runtimeKey: string): string[] =>
  [...store.candidates({ path: 'test/a.test.ts', project: '' }, runtimeKey)].map((r) => r.id)

test('candidates are the records of the current runtime, or the newest of any to explain a change', () => {
  const store = openIn('store.sqlite')
  try {
    store.putRun(run('r22', 'node22'))
    store.putRun(run('r24'))
    store.putRecord(record('old24', 'r24', 1))
    store.putRecord(record('new22', 'r22', 2, 'node22'))
    expect(ids(store, 'node24')).toEqual(['old24'])
    expect(ids(store, 'node26')).toEqual(['new22'])
  } finally {
    store.close()
  }
})

test('pruning keeps the records the planner reads, per runtime, and what they refer to', () => {
  const store = openIn('store.sqlite')
  try {
    for (let i = 0; i < 5; i++) {
      store.putRun(run(`run${i}`))
      store.putRecord(record(`rec${i}`, `run${i}`, i))
    }
    store.putRun(run('run22', 'node22'))
    store.putRecord(record('rec22', 'run22', 0, 'node22'))
    store.putVerification('run0', { path: 'test/a.test.ts', project: '' }, 'rec0', 'audit', 'pass')
    expect(store.prune({ keepRecords: 2 })).toBe(3)
    expect(ids(store, 'node24')).toEqual(['rec4', 'rec3'])
    expect(ids(store, 'node22')).toEqual(['rec22'])
    expect(store.getRun('run0')).toBeUndefined()
    expect(store.getRun('run4')).toBeDefined()
    expect(store.stats()).toMatchObject({ runs: 3, records: 3, closures: 3 })
    expect(store.verificationStats().verified).toBe(1)
  } finally {
    store.close()
  }
})

test('cached module units are pruned once unused for a number of runs', () => {
  const store = openIn('store.sqlite')
  try {
    store.putCached('used', 'u')
    store.putCached('unused', 'x')
    store.prune({ keepRecords: 20, keepUnitsFor: 2 })
    for (let i = 0; i < 3; i++) {
      expect(store.getCached('used')).toBe('u')
      store.prune({ keepRecords: 20, keepUnitsFor: 2 })
    }
    expect(store.getCached('used')).toBe('u')
    expect(store.getCached('unused')).toBeUndefined()
  } finally {
    store.close()
  }
})

test('merging adds the other store evidence and keeps what this one has', () => {
  const a = openIn('a.sqlite')
  const b = openIn('b.sqlite')
  try {
    a.putRun(run('shared'))
    a.putRecord(record('shared-rec', 'shared', 1))
    b.putRun(run('shared'))
    b.putRecord({ ...record('shared-rec', 'shared', 1), durationMs: 99 })
    b.putRun(run('other'))
    b.putRecord(record('other-rec', 'other', 2))
    b.putVerification('other', { path: 'test/a.test.ts', project: '' }, 'other-rec', 'canary', 'fail')
    b.putCached('units', 'text')
    b.close()
    expect(a.merge(path.join(dir!, 'b.sqlite'))).toBe(1)
    expect(ids(a, 'node24')).toEqual(['other-rec', 'shared-rec'])
    expect(a.getRecord('shared-rec')?.durationMs).toBe(5)
    expect(a.getRecord('other-rec')?.closure).toEqual([
      { k: 'file', p: 'fixtures/other-rec.txt', h: 'other-rec' },
    ])
    expect(a.getRun('other')).toBeDefined()
    expect(a.verificationStats()).toMatchObject({ verified: 1, escapes: 1 })
    expect(a.getCached('units')).toBe('text')
  } finally {
    a.close()
  }
})

test('closure entries no stored closure refers to are swept once they pile up', () => {
  const store = openIn('store.sqlite')
  try {
    const wide = (id: string, runId: string, minute: number): EvidenceRecord => ({
      ...record(id, runId, minute),
      closure: Array.from({ length: 12_000 }, (_, i) => ({ k: 'file', p: `f/${i}.txt`, h: `${id}-${i}` })),
    })
    store.putRun(run('run1'))
    store.putRun(run('run2'))
    store.putRecord(wide('old', 'run1', 1))
    store.putRecord(wide('new', 'run2', 2))
    expect(store.stats().entries).toBe(24_000)
    store.prune({ keepRecords: 1 })
    expect(store.stats()).toMatchObject({ records: 1, closures: 1, entries: 12_000 })
    expect(store.getRecord('new')?.closure[11_999]).toEqual({ k: 'file', p: 'f/11999.txt', h: 'new-11999' })
  } finally {
    store.close()
  }
})
