import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly ms: number
}

/** Runs a command synchronously; the rig is deliberately sequential so timings are comparable. */
export function exec(
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
    if (key.startsWith('VITEST') || key === 'NODE_ENV' || key === 'TEST') delete env[key]
  }
  // Snapshots must never be written by benchmark runs.
  env.CI = 'true'
  return env
}
