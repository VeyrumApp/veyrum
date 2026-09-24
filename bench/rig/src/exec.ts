import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ExecResult {
  readonly code: number
  /** Signal that ended the process, if any (for example SIGKILL from an out-of-memory kill). */
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly ms: number
}

/** A process ended by a signal or a shell reporting one (137 SIGKILL, 143 SIGTERM). */
function killed(r: ExecResult): boolean {
  return r.signal === 'SIGKILL' || r.signal === 'SIGTERM' || r.code === 137 || r.code === 143
}

/** A run killed from outside even after retries: the replay can resume later (see main.ts). */
export class KilledError extends Error {}

/** Exit code of a replay stopped by KilledError (EX_TEMPFAIL): bench/replay.sh resumes it. */
export const EXIT_KILLED = 75

const RETRIES = 6
/** Memory to wait for before retrying a killed run, and how long to wait for it at most. */
const WANTED_AVAILABLE_BYTES = 1.5 * 1024 ** 3
const MAX_WAIT_MS = 10 * 60 * 1000

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function availableMemory(): number {
  try {
    const line = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m)
    return line ? Number(line[1]) * 1024 : os.freemem()
  } catch {
    return os.freemem()
  }
}

/** Waits (up to MAX_WAIT_MS) until the machine has room for another test run. */
function waitForMemory(): void {
  const started = Date.now()
  sleep(30_000)
  while (availableMemory() < WANTED_AVAILABLE_BYTES && Date.now() - started < MAX_WAIT_MS) sleep(15_000)
}

/**
 * Runs a command synchronously; the rig is deliberately sequential so timings are comparable.
 * A run killed from outside (an out-of-memory killer on a shared machine) says nothing about the
 * code under test: it is retried once memory is available again. Timeouts are not retried.
 */
export function exec(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = { cwd: process.cwd() },
): ExecResult {
  let result = execOnce(command, args, options)
  const retriable = (r: ExecResult): boolean => killed(r) && r.ms < (options.timeoutMs ?? Infinity) * 0.95
  for (let attempt = 1; attempt <= RETRIES && retriable(result); attempt++) {
    process.stderr.write(
      `[rig] ${path.basename(command)} was killed (${result.signal ?? result.code}); retrying when memory allows\n`,
    )
    waitForMemory()
    result = execOnce(command, args, options)
  }
  if (retriable(result))
    throw new KilledError(
      `${path.basename(command)} was killed ${RETRIES + 1} times (${result.signal ?? result.code})`,
    )
  return result
}

/** Default limit for one command: generous for installs and full suites, finite for hangs. */
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000
/** Grace between the diagnostic signal at the time limit and the kill. */
const KILL_AFTER_SECONDS = 60

/**
 * Runs one command under coreutils `timeout`, which gives it its own process group. At the time
 * limit the whole group gets SIGUSR2: with RIG_REPORT_DIR set, every Node process in it (runner,
 * workers, children) writes a diagnostic report with JavaScript and native stacks, and the group
 * is killed a minute later. Output goes to files, not pipes, so a leftover grandchild holding a
 * pipe open cannot keep the rig waiting; whatever the command left running is killed afterwards.
 */
let coreutilsTimeout: boolean | undefined
/** Whether `timeout` is GNU coreutils' (Windows has an unrelated timeout.exe). */
function hasCoreutilsTimeout(): boolean {
  coreutilsTimeout ??= /coreutils/i.test(
    spawnSync('timeout', ['--version'], { encoding: 'utf8' }).stdout ?? '',
  )
  return coreutilsTimeout
}

function execOnce(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = { cwd: process.cwd() },
): ExecResult {
  if (!hasCoreutilsTimeout())
    throw new Error('the benchmark rig needs coreutils `timeout` (Linux) to bound every command')
  const started = performance.now()
  const timeoutMs = Math.round(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-exec-'))
  const outFile = path.join(dir, 'stdout')
  const errFile = path.join(dir, 'stderr')
  const env = { ...(options.env ?? process.env) }
  const reports = process.env.RIG_REPORT_DIR
  if (reports) {
    env.NODE_OPTIONS = [
      env.NODE_OPTIONS,
      '--report-on-signal',
      '--report-signal=SIGUSR2',
      `--report-directory=${reports}`,
    ]
      .filter(Boolean)
      .join(' ')
  }
  const out = fs.openSync(outFile, 'w')
  const err = fs.openSync(errFile, 'w')
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(
      'timeout',
      [
        '--signal=USR2',
        `--kill-after=${KILL_AFTER_SECONDS}`,
        `${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
        command,
        ...args,
      ],
      { cwd: options.cwd, env, stdio: ['ignore', out, err] },
    )
  } finally {
    fs.closeSync(out)
    fs.closeSync(err)
  }

  if (result.pid) {
    try {
      process.kill(-result.pid, 'SIGKILL')
    } catch {
      // Nothing left in the group.
    }
  }
  const read = (file: string): string => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
  const stdout = read(outFile)
  const stderr = read(errFile)
  fs.rmSync(dir, { recursive: true, force: true })
  const ms = performance.now() - started
  // timeout exits 124 at the limit, or 137 when the kill that follows was needed.
  const timedOut = result.status === 124 || (result.status === 137 && ms >= timeoutMs)
  return {
    code: timedOut ? 124 : (result.status ?? -1),
    signal: timedOut
      ? 'timeout'
      : result.status === 137
        ? 'SIGKILL'
        : result.status === 143
          ? 'SIGTERM'
          : null,
    stdout,
    stderr: timedOut ? `${stderr}\n[rig] timed out after ${Math.round(timeoutMs / 1000)}s\n` : stderr,
    ms,
  }
}

export function git(cwd: string, ...args: string[]): string {
  const r = exec('git', args, { cwd })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

const here = path.dirname(fileURLToPath(import.meta.url))
/** The Veyrum CLI from this checkout. */
export const VEYRUM_CLI = path.resolve(here, '../../../packages/cli/dist/main.js')

/** Environment for child test runs: never inherit an outer Vitest's variables. */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST') || key.startsWith('JEST') || key === 'NODE_ENV' || key === 'TEST')
      delete env[key]
  }
  // Snapshots must never be written by benchmark runs.
  env.CI = 'true'
  // Diagnostics: CPU profiles of every Node process of the runs being profiled (see replay.ts).
  const profileDir = process.env.RIG_NODE_PROFILE_DIR
  if (profileDir && profiling) {
    env.NODE_OPTIONS = [env.NODE_OPTIONS, '--cpu-prof', `--cpu-prof-dir=${path.join(profileDir, profiling)}`]
      .filter(Boolean)
      .join(' ')
  }
  return env
}

let profiling: string | null = null
/** Profiles the runs made during fn under RIG_NODE_PROFILE_DIR/<name> (no-op when unset). */
export function profiled<T>(name: string, fn: () => T): T {
  profiling = name
  try {
    return fn()
  } finally {
    profiling = null
  }
}
