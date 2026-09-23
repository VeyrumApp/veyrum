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

function execOnce(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = { cwd: process.cwd() },
): ExecResult {
  const started = performance.now()
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: Math.round(options.timeoutMs ?? 60 * 60 * 1000),
  })
  return {
    code: result.status ?? -1,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ms: performance.now() - started,
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
  return env
}
