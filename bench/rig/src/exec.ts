import { spawnSync } from 'node:child_process'
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

/**
 * Runs a command synchronously; the rig is deliberately sequential so timings are comparable.
 * A run killed from outside (an out-of-memory killer on a shared machine) is retried after a pause,
 * since its result says nothing about the code under test. Timeouts are not retried.
 */
export function exec(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = { cwd: process.cwd() },
): ExecResult {
  let result = execOnce(command, args, options)
  for (
    let attempt = 1;
    attempt <= 3 && killed(result) && result.ms < (options.timeoutMs ?? Infinity) * 0.95;
    attempt++
  ) {
    process.stderr.write(
      `[rig] ${path.basename(command)} was killed (${result.signal ?? result.code}); retrying\n`,
    )
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
    result = execOnce(command, args, options)
  }
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
