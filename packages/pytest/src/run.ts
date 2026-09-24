import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MainRecorder, rawFs, unobserved, VOLATILE_ENV } from '@veyrum/capture'
import { assemble, type CheckOutcome } from '@veyrum/capture/assemble'
import { storeFiles, veyrumDirs } from '@veyrum/capture/host'
import {
  type CheckOutcomeSummary,
  type CheckRef,
  CurrentState,
  checkKey,
  type Decision,
  digest,
  forcedDecisions,
  fromRepoPath,
  isInside,
  listRepoFiles,
  needsPlan,
  plan,
  type RunOptions,
  type RunResult,
  recordEvidence,
  recordUncapturedFailures,
  recordVerifications,
  runtimeFacts,
  runtimeKeyOf,
  type Store,
  selectExecution,
  selectFiles,
  toRepoPath,
} from '@veyrum/core'
import {
  type CollectedTests,
  PYTEST_CAPTURE_ENV,
  type PytestCaptureConfig,
  type ReportedFile,
} from './protocol.ts'
import { createTransformer } from './transformer.ts'

export interface PytestRunOptions extends RunOptions {
  /** The Python interpreter that runs pytest (default `python3`). */
  readonly python?: string
  /** Test files run at once, each in its own process. */
  readonly maxWorkers?: number
  /** pytest configuration file (pytest's `-c`); by default pytest finds it. */
  readonly config?: string
}

/**
 * Files that configure pytest wherever they are found above the test files; the one pytest uses
 * is an input of every file, and the others are inputs as absent or unused, at the root.
 */
const CONFIG_FILES = ['pytest.ini', '.pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg']

/** Python's own environment variables, and those pytest reads before any plugin loads. */
const PYTHON_ENV = /^(PYTHON.*|PYTEST_ADDOPTS|PYTEST_PLUGINS|PYTEST_DISABLE_PLUGIN_AUTOLOAD)$/

/** pytest's exit statuses that mean every collected test passed (5: nothing was collected). */
const PASSING_EXIT = new Set([0, 5])

interface PythonInfo {
  readonly ok: boolean
  readonly version: string
  readonly implementation: string
  readonly platform: string
  readonly pytest: string | null
}

export async function runPytest(options: PytestRunOptions): Promise<RunResult> {
  const started = performance.now()
  const root = path.resolve(options.root)
  const runId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const scratch = path.join(root, '.veyrum', 'tmp', runId)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const pythonDir = path.join(here, 'python')
  // A path (not a command name) is relative to where Veyrum was started, not to the root.
  const python =
    options.python && /[\\/]/.test(options.python)
      ? path.resolve(options.python)
      : (options.python ?? 'python3')
  const ignored = [...veyrumDirs(here), scratch + path.sep, ...storeFiles(options.store.file)]
  const recorder = new MainRecorder({ root, ignoredPrefixes: ignored, volatileEnv: VOLATILE_ENV })

  recorder.start()
  try {
    fs.mkdirSync(path.join(scratch, 'payloads'), { recursive: true })
    fs.mkdirSync(path.join(scratch, 'reports'), { recursive: true })
    const info = await pythonInfo(python, root)
    const facts = runtimeFacts({
      runner: 'pytest',
      pytest: info.pytest ?? '',
      python: info.version,
      pythonImplementation: info.implementation,
      pythonPlatform: info.platform,
      // Digested: the store never holds environment values.
      pythonEnv: digest(
        Object.entries(recorder.initialEnv)
          .filter(([n]) => PYTHON_ENV.test(n))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([n, v]) => `${n}=${v ?? ''}`)
          .join('\n'),
      ),
    })
    const runtimeKey = runtimeKeyOf(facts)
    const pythonPath = recorder.initialEnv.PYTHONPATH ?? null
    const collected = await collect(python, root, scratch, pythonDir, pythonPath, options.config)
    const files = listRepoFiles(root)

    const specs = collected.files
      .filter((f) => isInside(root, f))
      .map((f) => ({ check: { path: toRepoPath(root, f), project: '' }, file: path.resolve(f) }))
      .sort((a, b) => a.check.path.localeCompare(b.check.path))
    const selectedSpecs = selectFiles(specs, (s) => s.check.path, options)
    const checks = selectedSpecs.map((s) => s.check)

    const planStarted = performance.now()
    let decisions: Decision[]
    if (!needsPlan(options)) {
      decisions = forcedDecisions(checks)
    } else {
      const env = recorder.initialEnv as NodeJS.ProcessEnv
      const transformer = createTransformer(root, python, pythonDir)
      await transformer.prefetch(changedModules(root, options.store, checks, runtimeKey, env))
      decisions = await plan({
        root,
        store: options.store,
        checks,
        runtimeKey,
        transformer,
        files,
        fs: rawFs,
        env,
        ...(options.policy ? { policy: options.policy } : {}),
      })
    }
    const planMs = performance.now() - planStarted
    if (options.mode === 'plan') {
      return {
        runId,
        runtimeKey,
        decisions,
        records: [],
        ran: [],
        outcomes: [],
        verifications: [],
        ok: true,
        timings: { planMs, runMs: 0, recordMs: 0, totalMs: performance.now() - started },
      }
    }

    const execution = selectExecution(checks, decisions, options, runId)
    const selected = selectedSpecs.filter((s) => execution.toRun.has(checkKey(s.check)))
    const captured = (check: CheckRef): boolean => execution.capture.has(checkKey(check))
    const main = recorder.stop()

    const runStarted = performance.now()
    const config = options.config ?? collected.inipath
    const pytestArgs = [
      ...(config ? ['-c', config] : []),
      // The configuration and root directory of a whole run, not those found from one file.
      '--rootdir',
      collected.rootpath,
      // A test file runs alone in its process; pytest-xdist would start workers Veyrum cannot see.
      ...(collected.xdist ? ['-n', '0'] : []),
    ]
    const ranOutcomes: CheckOutcome[] = new Array(selected.length)
    let next = 0
    const workers = Math.max(1, options.maxWorkers ?? Math.max(1, os.availableParallelism() - 1))
    const worker = async (): Promise<void> => {
      for (let i = next++; i < selected.length; i = next++) {
        const spec = selected[i]!
        const payload = path.join(scratch, 'payloads', `${i}.json`)
        const report = path.join(scratch, 'reports', `${i}.json`)
        const fileStarted = performance.now()
        const { code, output } = await runFile(
          python,
          root,
          [...pytestArgs, '-o', `cache_dir=${path.join(scratch, 'cache', String(i))}`, spec.check.path],
          {
            mode: 'run',
            capture: captured(spec.check),
            root,
            ignored,
            testFile: spec.file,
            payload,
            report,
            volatileEnv: VOLATILE_ENV.source,
            pythonPath,
            pluginDir: pythonDir,
            children: path.join(scratch, 'children', String(i)),
          },
        )
        if (options.printTests) process.stdout.write(output)
        const reported = readJson<ReportedFile>(report)
        const passed = PASSING_EXIT.has(code) && reported?.verdict !== 'fail'
        ranOutcomes[i] = {
          file: spec.file,
          project: '',
          env: '',
          verdict: passed ? 'pass' : 'fail',
          tests: reported?.tests ?? [],
          durationMs: reported?.durationMs ?? performance.now() - fileStarted,
          retries: 0,
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(workers, selected.length) }, worker))
    const runMs = performance.now() - runStarted

    const outcomes: CheckOutcomeSummary[] = ranOutcomes.map((o) => {
      const check = { path: toRepoPath(root, o.file), project: '' }
      return { check, verdict: o.verdict, durationMs: o.durationMs, captured: captured(check) }
    })

    const recordStarted = performance.now()
    const configFiles = [
      ...CONFIG_FILES.map((f) => path.join(root, f)),
      ...(config ? [path.resolve(root, config)] : []),
    ]
    const recording = recordEvidence(options.strict, () => {
      const { run, records } = options.store.transaction(() =>
        assemble({
          root,
          runId,
          runtimeKey,
          runtime: facts,
          revision: options.revision ?? null,
          createdAt,
          outDir: scratch,
          outcomes: ranOutcomes.filter((o) => captured({ path: toRepoPath(root, o.file), project: '' })),
          main,
          files,
          store: options.store,
          fs: rawFs,
          runner: { name: 'pytest', version: info.pytest ?? '', isolate: true, pool: 'process' },
          sharedWorkerProjects: new Set(),
          ignored,
          configFiles,
        }),
      )
      options.store.transaction(() => {
        options.store.putRun(run)
        for (const record of records) options.store.putRecord(record)
      })
      recordUncapturedFailures(options.store, runId, options.revision ?? null, decisions, outcomes)
      return { records, verifications: recordVerifications(options.store, runId, execution, outcomes) }
    })
    const { records, verifications } = recording
    const recordMs = performance.now() - recordStarted
    const failed =
      outcomes.some((o) => o.verdict === 'fail') ||
      (recording.recorded && records.some((r) => r.verdict === 'fail'))
    return {
      runId,
      runtimeKey,
      decisions,
      records,
      ran: selected.map((s) => s.check),
      outcomes,
      verifications,
      ok: !failed,
      timings: { planMs, runMs, recordMs, totalMs: performance.now() - started },
    }
  } finally {
    recorder.stop()
    if (!options.keepScratch) fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Repository Python modules whose source changed since the latest evidence of the checks: the
 * planner asks for their fingerprints, which one process computes up front.
 */
function changedModules(
  root: string,
  store: Store,
  checks: readonly CheckRef[],
  runtimeKey: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const state = new CurrentState(root, store, env, rawFs)
  const out = new Set<string>()
  for (const check of checks) {
    for (const record of store.candidates(check, runtimeKey, 1)) {
      for (const entry of record.closure) {
        if (entry.k !== 'mod' || entry.raw || !entry.p.endsWith('.py')) continue
        const now = state.fileDigest(entry.p)
        if (now !== null && now !== entry.src) out.add(fromRepoPath(root, entry.p))
      }
    }
  }
  return [...out]
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** The environment of a pytest process Veyrum starts: the plugin importable, its config set. */
function pytestEnv(config: PytestCaptureConfig): NodeJS.ProcessEnv {
  const pythonPath = [config.pluginDir, ...(config.pythonPath ? [config.pythonPath] : [])]
  return {
    ...process.env,
    PYTHONPATH: pythonPath.join(path.delimiter),
    [PYTEST_CAPTURE_ENV]: JSON.stringify(config),
  }
}

/** Runs `python -m pytest -p veyrum_capture <args>`; resolves with its exit code and output. */
function runFile(
  python: string,
  root: string,
  args: readonly string[],
  config: PytestCaptureConfig,
): Promise<{ code: number; output: string }> {
  // Veyrum's own process starts the runner: nothing of that is a test's input.
  return unobserved(
    () =>
      new Promise((resolve, reject) => {
        const child = spawn(python, ['-m', 'pytest', '-p', 'veyrum_capture', ...args], {
          cwd: root,
          env: pytestEnv(config),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const chunks: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
        child.on('error', reject)
        child.on('close', (code, signal) =>
          resolve({ code: code ?? (signal ? 1 : 0), output: Buffer.concat(chunks).toString('utf8') }),
        )
      }),
  )
}

/** The test files pytest would run, as the project configures it (`pytest --collect-only`). */
async function collect(
  python: string,
  root: string,
  scratch: string,
  pythonDir: string,
  pythonPath: string | null,
  config: string | undefined,
): Promise<CollectedTests> {
  const collectFile = path.join(scratch, 'collected.json')
  const { code, output } = await runFile(
    python,
    root,
    [
      '--collect-only',
      '-q',
      ...(config ? ['-c', config] : []),
      '-o',
      `cache_dir=${path.join(scratch, 'cache', 'collect')}`,
    ],
    { mode: 'collect', collectFile, pythonPath, pluginDir: pythonDir },
  )
  const collected = readJson<CollectedTests>(collectFile)
  if (!collected) throw new Error(`pytest could not collect tests (exit ${code}):\n${output.trim()}`)
  return collected
}

/** The interpreter's version, platform and pytest version; fails unless it can capture. */
function pythonInfo(python: string, root: string): Promise<PythonInfo> {
  const program = [
    'import json, platform, sys, sysconfig',
    'try:',
    '    import pytest',
    '    version = pytest.__version__',
    'except ImportError:',
    '    version = None',
    'print(json.dumps({"ok": sys.version_info >= (3, 12), "version": sys.version,',
    '    "implementation": platform.python_implementation(), "platform": sysconfig.get_platform(),',
    '    "pytest": version}))',
  ].join('\n')
  return unobserved(
    () =>
      new Promise<PythonInfo>((resolve, reject) => {
        const child = spawn(python, ['-c', program], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
        const out: Buffer[] = []
        const err: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
        child.on('error', (error) => reject(new Error(`cannot run ${python}: ${error.message}`)))
        child.on('close', (code) => {
          let info: PythonInfo
          try {
            info = JSON.parse(Buffer.concat(out).toString('utf8')) as PythonInfo
          } catch {
            reject(new Error(`cannot run ${python} (exit ${code}): ${Buffer.concat(err).toString().trim()}`))
            return
          }
          if (!info.ok)
            reject(
              new Error(
                `${python} is Python ${info.version.split(' ')[0]}; capture needs Python 3.12 or later`,
              ),
            )
          else if (!info.pytest) reject(new Error(`pytest is not installed for ${python}`))
          else resolve(info)
        })
      }),
  )
}
