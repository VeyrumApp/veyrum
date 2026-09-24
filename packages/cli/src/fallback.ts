import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Store } from '@veyrum/core'

/** What the fallback needs to run the project's tests the way Veyrum would have. */
export interface PlainRunOptions {
  readonly root: string
  readonly runner: 'vitest' | 'jest' | 'node-test' | 'pytest'
  readonly config?: string
  /** pytest: the Python interpreter (default python3). */
  readonly python?: string
  readonly projects: readonly string[]
  readonly maxWorkers?: number
  /** Repository-relative test files to run; everything when empty. */
  readonly only?: readonly string[]
  /** Coverage on or off; the project's configuration when absent. */
  readonly coverage?: boolean
  readonly quiet: boolean
}

function packageDir(root: string, name: string): string {
  return path.dirname(createRequire(path.join(root, 'package.json')).resolve(`${name}/package.json`))
}

/** The runner's own command line for the same selection of tests, projects and workers. */
export function plainRunnerCommand(options: PlainRunOptions): { command: string; args: string[] } {
  const files = options.only ?? []
  if (options.runner === 'pytest') {
    return {
      command: options.python ?? 'python3',
      args: [
        '-m',
        'pytest',
        ...(options.config ? ['-c', options.config] : []),
        ...(options.quiet ? ['-q'] : []),
        ...files,
      ],
    }
  }
  if (options.runner === 'node-test') {
    return {
      command: process.execPath,
      args: [
        ...process.execArgv,
        '--test',
        ...(options.maxWorkers ? [`--test-concurrency=${options.maxWorkers}`] : []),
        ...(options.quiet ? ['--test-reporter=dot'] : []),
        ...files,
      ],
    }
  }
  if (options.runner === 'jest') {
    const bin = path.join(packageDir(options.root, 'jest'), 'bin', 'jest.js')
    return {
      command: process.execPath,
      args: [
        ...process.execArgv,
        bin,
        ...(options.config ? ['--config', options.config] : []),
        ...options.projects.flatMap((p) => ['--selectProjects', p]),
        ...(options.maxWorkers ? [`--maxWorkers=${options.maxWorkers}`] : []),
        ...(options.quiet ? ['--silent'] : []),
        ...(options.coverage !== undefined ? [`--coverage=${options.coverage}`] : []),
        ...(files.length > 0 ? ['--runTestsByPath', ...files] : []),
      ],
    }
  }
  const bin = path.join(packageDir(options.root, 'vitest'), 'vitest.mjs')
  return {
    command: process.execPath,
    args: [
      ...process.execArgv,
      bin,
      'run',
      ...(options.config ? ['--config', options.config] : []),
      ...options.projects.flatMap((p) => ['--project', p]),
      ...(options.maxWorkers ? [`--maxWorkers=${options.maxWorkers}`] : []),
      ...(options.quiet ? ['--reporter=dot'] : []),
      ...(options.coverage !== undefined ? [`--coverage.enabled=${options.coverage}`] : []),
      ...files,
    ],
  }
}

/**
 * Runs the project's tests with its own runner, without Veyrum: what `veyrum run` falls back to when
 * Veyrum itself fails before any test ran. Returns the runner's exit code.
 */
export function runPlain(options: PlainRunOptions): number {
  const { command, args } = plainRunnerCommand(options)
  const result = spawnSync(command, args, { cwd: options.root, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  return result.status ?? 1
}

/**
 * Opens the evidence store. A store that cannot be opened (corrupt, or written by an incompatible
 * version) is moved aside and replaced by an empty one: losing evidence only means files run.
 */
export function openStoreOrReset(file: string): Store {
  try {
    return Store.open(file)
  } catch (error) {
    const aside = `${file}.unusable-${Date.now()}`
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `veyrum: the evidence store could not be opened (${message}); moved it to ${aside}\n`,
    )
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(`${file}${suffix}`)) fs.renameSync(`${file}${suffix}`, `${aside}${suffix}`)
    }
    return Store.open(file)
  }
}
