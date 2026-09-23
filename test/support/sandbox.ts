import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Decision } from '@veyrum/core'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const cli = path.join(repoRoot, 'packages/cli/dist/main.js')
/** Runner installs the sandboxes link to (dev dependencies of the adapter packages). */
const runnerModules = {
  vitest: path.join(repoRoot, 'node_modules', 'vitest'),
  jest: path.join(repoRoot, 'packages', 'jest', 'node_modules', 'jest'),
}

export interface SandboxOptions {
  /** Parent directory (default: the repository's .sandbox directory). */
  readonly base?: string
  readonly runner?: 'vitest' | 'jest'
  /** Worker count passed to the runner (Jest runs in the main process with one worker). */
  readonly workers?: number
  /** Packages from the repository's own node_modules to link in, for example a DOM environment. */
  readonly modules?: readonly string[]
}

export interface CliResult {
  readonly code: number
  readonly output: string
  readonly decisions: readonly Decision[]
}

/**
 * A throwaway Vitest or Jest project driven through the real Veyrum CLI. Lives under the
 * repository's .sandbox directory (not the OS temp directory) unless a base is given.
 */
export class Sandbox {
  readonly dir: string
  readonly runner: 'vitest' | 'jest'
  private readonly workers: number

  constructor(name: string, options: SandboxOptions = {}) {
    this.runner = options.runner ?? 'vitest'
    this.workers = options.workers ?? 1
    const base = options.base ?? path.join(repoRoot, '.sandbox')
    this.dir = path.join(base, `${name}-${crypto.randomBytes(4).toString('hex')}`)
    fs.mkdirSync(path.join(this.dir, 'node_modules'), { recursive: true })
    fs.symlinkSync(runnerModules[this.runner], path.join(this.dir, 'node_modules', this.runner))
    for (const name of options.modules ?? [])
      fs.symlinkSync(path.join(repoRoot, 'node_modules', name), path.join(this.dir, 'node_modules', name))
    if (this.runner === 'vitest') {
      this.write('package.json', JSON.stringify({ name, private: true, type: 'module' }, null, 2))
      this.write(
        'vitest.config.ts',
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: {} })\n",
      )
    } else {
      this.write('package.json', JSON.stringify({ name, private: true }, null, 2))
      this.write('jest.config.js', "module.exports = { testEnvironment: 'node' }\n")
    }
  }

  write(rel: string, content: string): this {
    const file = path.join(this.dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    return this
  }

  read(rel: string): string {
    return fs.readFileSync(path.join(this.dir, rel), 'utf8')
  }

  edit(rel: string, from: string | RegExp, to: string): this {
    const before = this.read(rel)
    const after = before.replace(from, to)
    if (after === before) throw new Error(`edit of ${rel} changed nothing (pattern ${String(from)})`)
    return this.write(rel, after)
  }

  remove(rel: string): this {
    fs.rmSync(path.join(this.dir, rel), { recursive: true, force: true })
    return this
  }

  /** Runs the CLI as a user would (without --strict) and returns only its exit code and output. */
  raw(args: readonly string[], env: Record<string, string> = {}): { code: number; output: string } {
    const result = spawnSync(process.execPath, [cli, ...args, '--max-workers', String(this.workers)], {
      cwd: this.dir,
      encoding: 'utf8',
      env: this.childEnv(env),
      timeout: 120_000,
    })
    return { code: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  private childEnv(env: Record<string, string>): NodeJS.ProcessEnv {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env }
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('VITEST') || key.startsWith('JEST') || key === 'NODE_ENV' || key === 'TEST')
        if (!(key in env)) delete childEnv[key]
    }
    // Scenarios decide snapshot behavior themselves; CI systems set CI=true, which forbids writes.
    if (!('CI' in env)) delete childEnv.CI
    if (!('GITHUB_ACTIONS' in env)) delete childEnv.GITHUB_ACTIONS
    return childEnv
  }

  cli(args: readonly string[], env: Record<string, string> = {}): CliResult {
    const json = path.join(this.dir, '.veyrum', `out-${crypto.randomBytes(4).toString('hex')}.json`)
    fs.mkdirSync(path.dirname(json), { recursive: true })
    // The child must not inherit this test runner's own Vitest variables.
    const childEnv = this.childEnv(env)
    const result = spawnSync(
      process.execPath,
      [cli, ...args, '--quiet', '--strict', '--max-workers', String(this.workers), '--json', json],
      {
        cwd: this.dir,
        encoding: 'utf8',
        env: childEnv,
        timeout: 120_000,
      },
    )
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    let decisions: Decision[] = []
    if (args[0] === 'stats') return { code: result.status ?? -1, output, decisions }
    try {
      decisions = (JSON.parse(fs.readFileSync(json, 'utf8')) as { decisions: Decision[] }).decisions
    } catch {
      throw new Error(`veyrum ${args.join(' ')} produced no JSON (exit ${result.status}):\n${output}`)
    }
    return { code: result.status ?? -1, output, decisions }
  }

  /** Runs every test file and records evidence; fails the calling test if the run fails. */
  capture(env: Record<string, string> = {}): CliResult {
    const result = this.cli(['run', '--full'], env)
    if (result.code !== 0) throw new Error(`capture run failed:\n${result.output}`)
    return result
  }

  /** Decisions keyed by test file path. */
  plan(env: Record<string, string> = {}): Record<string, Decision> {
    const result = this.cli(['plan'], env)
    return Object.fromEntries(result.decisions.map((d) => [d.check.path, d]))
  }

  /** Just the action per test file, for compact assertions. */
  actions(env: Record<string, string> = {}): Record<string, 'run' | 'skip'> {
    return Object.fromEntries(Object.entries(this.plan(env)).map(([k, d]) => [k, d.action]))
  }

  dispose(): void {
    fs.rmSync(this.dir, { recursive: true, force: true })
  }
}
