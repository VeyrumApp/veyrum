import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { Store } from '../src/store.ts'

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
    expect(record?.flags).toEqual(['spawn'])
    expect(record?.channels).toBeUndefined()
    store.putRecord({ ...record!, id: 'r2', channels: { spawn: ['/usr/bin/turbo'] } })
    expect(store.getRecord('r2')?.channels).toEqual({ spawn: ['/usr/bin/turbo'] })
  } finally {
    store.close()
  }
})
