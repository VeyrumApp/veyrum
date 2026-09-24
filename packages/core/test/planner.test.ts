import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  type ClosureEntry,
  type Digest,
  type EvidenceRecord,
  hashEnvValue,
  hashFileBytes,
  type ModuleTransformer,
  plan,
  type RunInfo,
  Store,
  TOP_UNIT,
} from '../src/index.ts'

let root: string
let store: Store
const KEY = 'runtime-key'
const check = { path: 'test/a.test.ts', project: '' }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-planner-'))
  store = Store.open(':memory:')
})
afterEach(() => {
  store.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function write(rel: string, content: string): Digest {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return hashFileBytes(Buffer.from(content))
}

let seq = 0
function record(
  closure: ClosureEntry[],
  overrides: Partial<EvidenceRecord> = {},
  runOverrides: Partial<RunInfo> = {},
) {
  seq++
  const run: RunInfo = {
    id: `run-${seq}`,
    createdAt: new Date(2026, 0, 1, 0, seq).toISOString(),
    revision: null,
    runtimeKey: KEY,
    runtime: {},
    shared: [],
    injectedEnv: {},
    files: fs
      .readdirSync(root, { recursive: true })
      .map((f) => String(f).split(path.sep).join('/'))
      .sort(),
    runner: { name: 'test', version: '0', isolate: true, pool: 'forks' },
    ...runOverrides,
  }
  store.putRun(run)
  const rec: EvidenceRecord = {
    id: `rec-${seq}`,
    check: check.path,
    project: check.project,
    runId: run.id,
    runtimeKey: KEY,
    verdict: 'pass',
    reusable: true,
    flags: [],
    tests: [],
    durationMs: 10,
    closure,
    createdAt: run.createdAt,
    revision: null,
    ...overrides,
  }
  store.putRecord(rec)
  return rec
}

async function decide(options: { transformer?: ModuleTransformer; env?: NodeJS.ProcessEnv } = {}) {
  const [d] = await plan({
    root,
    store,
    checks: [check],
    runtimeKey: KEY,
    files: fs.readdirSync(root, { recursive: true }).map(String).sort(),
    env: options.env ?? {},
    ...(options.transformer ? { transformer: options.transformer } : {}),
  })
  return d!
}

describe('plan', () => {
  test('runs a check with no evidence', async () => {
    const d = await decide()
    expect(d.action).toBe('run')
    expect(d.reason).toBe('no-evidence')
  })

  test('reuses evidence whose inputs are unchanged, and names what changed otherwise', async () => {
    const h = write('fixtures/data.json', '{"a":1}')
    record([{ k: 'file', p: 'fixtures/data.json', h }])
    expect((await decide()).action).toBe('skip')
    write('fixtures/data.json', '{"a":2}')
    const d = await decide()
    expect(d.action).toBe('run')
    expect(d.reason).toBe('inputs-changed')
    expect(d.details).toEqual(['fixtures/data.json changed'])
  })

  test('treats a file that was absent and now exists as a change', async () => {
    record([{ k: 'file', p: 'optional.txt', h: null }])
    expect((await decide()).action).toBe('skip')
    write('optional.txt', 'x')
    expect((await decide()).details).toEqual(['optional.txt now exists'])
  })

  test('compares environment variables against the given environment', async () => {
    record([{ k: 'env', n: 'FLAG', h: hashEnvValue('on') }])
    expect((await decide({ env: { FLAG: 'on' } })).action).toBe('skip')
    expect((await decide({ env: { FLAG: 'off' } })).details).toEqual(['environment variable FLAG changed'])
    expect((await decide({ env: {} })).action).toBe('run')
  })

  test('uses runner-injected values for worker environment reads', async () => {
    record(
      [{ k: 'env', n: 'NODE_ENV', h: hashEnvValue('test') }],
      {},
      { injectedEnv: { NODE_ENV: hashEnvValue('test') } },
    )
    expect((await decide({ env: {} })).action).toBe('skip')
  })

  test('refuses evidence from a different runtime', async () => {
    record([], { runtimeKey: 'other' })
    const d = await decide()
    expect(d.action).toBe('run')
    expect(d.reason).toBe('runtime-changed')
  })

  test('never skips past a most recent failure', async () => {
    record([])
    record([], { verdict: 'fail' })
    expect((await decide()).action).toBe('run')
  })

  test('ignores passes that are not evidence', async () => {
    record([], { reusable: false, flags: ['flaky-suspect'] })
    const d = await decide()
    expect(d.action).toBe('run')
    expect(d.reason).toBe('not-reusable')
  })

  test('refuses records with blocking flags', async () => {
    record([], { flags: ['spawn'] })
    expect((await decide()).reason).toBe('blocked-flag')
  })

  test('reuses records with allowed flags and reports them', async () => {
    record([], { flags: ['net-local', 'eval'] })
    const d = await decide()
    expect(d.action).toBe('skip')
    expect(d.flagsRelied).toEqual(['net-local', 'eval'])
  })

  test('invalidates everything when a shared runner input changes', async () => {
    const h = write('vitest.config.ts', 'a')
    record([], {}, { shared: [{ k: 'file', p: 'vitest.config.ts', h }] })
    expect((await decide()).action).toBe('skip')
    write('vitest.config.ts', 'b')
    const d = await decide()
    expect(d.reason).toBe('shared-inputs-changed')
    expect(d.details[0]).toContain('vitest.config.ts')
  })

  test('falls back to an older record whose inputs match (a revert)', async () => {
    const h1 = write('src/x.ts', 'one')
    record([{ k: 'file', p: 'src/x.ts', h: h1 }])
    const h2 = write('src/x.ts', 'two')
    record([{ k: 'file', p: 'src/x.ts', h: h2 }])
    write('src/x.ts', 'one')
    const d = await decide()
    expect(d.action).toBe('skip')
    expect(d.recordId).toBe(`rec-${seq - 1}`)
  })
})

describe('modules', () => {
  function modRecord(units: Record<string, Digest>, flags: string[] = []) {
    const src = write('src/m.ts', 'export const v = 1')
    record([{ k: 'mod', p: 'src/m.ts', src, units, env: 'ssr' }], { flags })
  }
  const transformer = (units: Record<string, Digest> | null): ModuleTransformer => ({
    units: async () => units,
  })

  test('skips without transforming when the raw source is unchanged', async () => {
    modRecord({ [TOP_UNIT]: 'a' })
    let called = false
    const d = await decide({
      transformer: {
        units: async () => {
          called = true
          return null
        },
      },
    })
    expect(d.action).toBe('skip')
    expect(called).toBe(false)
  })

  test('runs when the source changed and cannot be re-fingerprinted', async () => {
    modRecord({ [TOP_UNIT]: 'a' })
    write('src/m.ts', 'export const v = 2')
    expect((await decide()).details[0]).toContain('could not be re-fingerprinted')
  })

  test('reuses when the source changed but every executed unit is identical', async () => {
    modRecord({ [TOP_UNIT]: 'a', '@top/fn:f#0': 'b' })
    write('src/m.ts', '// edited')
    expect(
      (
        await decide({
          transformer: transformer({ [TOP_UNIT]: 'a', '@top/fn:f#0': 'b', '@top/fn:g#0': 'c' }),
        })
      ).action,
    ).toBe('skip')
  })

  test('names the executed units that changed', async () => {
    modRecord({ [TOP_UNIT]: 'a', '@top/fn:f#0': 'b' })
    write('src/m.ts', '// edited')
    const d = await decide({ transformer: transformer({ [TOP_UNIT]: 'a', '@top/fn:f#0': 'changed' }) })
    expect(d.action).toBe('run')
    expect(d.details).toEqual(['src/m.ts: f changed'])
  })

  test('compares raw source when the check observes source text', async () => {
    modRecord({ [TOP_UNIT]: 'a' }, ['source-observed'])
    write('src/m.ts', '// edited')
    expect((await decide({ transformer: transformer({ [TOP_UNIT]: 'a' }) })).action).toBe('run')
  })

  test('a new file with the same stem as a module may shadow it', async () => {
    modRecord({ [TOP_UNIT]: 'a' })
    write('src/m.js', 'export const v = 3')
    expect((await decide()).details[0]).toContain('may shadow src/m.ts')
  })
})

describe('store', () => {
  test('stores each distinct closure once', () => {
    record([{ k: 'env', n: 'A', h: null }])
    record([{ k: 'env', n: 'A', h: null }])
    expect(store.stats()).toMatchObject({ records: 2, closures: 1, runs: 2 })
  })

  test('forgets everything recorded at one revision', () => {
    record([], { revision: 'aaa' }, { revision: 'aaa' })
    record([], { revision: 'bbb' }, { revision: 'bbb' })
    expect(store.forgetRevision('bbb')).toBe(1)
    expect(store.forgetRevision('bbb')).toBe(0)
    expect(store.stats()).toMatchObject({ records: 1, runs: 1 })
    expect(store.recordsFor(check)[0]?.revision).toBe('aaa')
  })

  test('round-trips runs and records', () => {
    const rec = record(
      [{ k: 'dir', p: 'fixtures', h: 'x' }],
      {},
      { shared: [{ k: 'env', n: 'CI', h: null }] },
    )
    expect(store.getRecord(rec.id)).toEqual(rec)
    expect(store.getRun(rec.runId)?.shared).toEqual([{ k: 'env', n: 'CI', h: null }])
    expect(store.checks()).toEqual([check])
  })
})
