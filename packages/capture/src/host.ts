import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { rawFs } from './hooks.ts'

/** Helpers for runner adapters running in the main process. */

/** The nearest package.json above `file` whose name is `name`. */
export function packageJsonAbove(file: string, name: string): { version: string; dir: string } | null {
  let dir = path.dirname(file)
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json')
    try {
      const pkg = JSON.parse(rawFs.readFileSync(candidate, 'utf8') as string) as {
        name?: string
        version?: string
      }
      if (pkg.name === name) return { version: pkg.version ?? '', dir }
    } catch {
      // keep walking
    }
    dir = path.dirname(dir)
  }
  return null
}

/**
 * Directories holding the code Veyrum runs (the built output of the adapter, capture and core
 * packages), with and without symlinks resolved, as path prefixes. Nothing under them is recorded
 * as an input. Only built output is excluded, never whole packages: when the project under test is
 * Veyrum itself, its sources and tests are inputs like any other.
 */
export function veyrumDirs(adapterDist: string): string[] {
  const require = createRequire(import.meta.url)
  const dirs = new Set<string>([adapterDist])
  for (const pkg of ['@veyrum/capture', '@veyrum/core']) dirs.add(path.dirname(require.resolve(pkg)))
  const out: string[] = []
  for (const d of dirs) {
    out.push(d + path.sep)
    try {
      out.push(fs.realpathSync(d) + path.sep)
    } catch {
      // not a symlink
    }
  }
  return [...new Set(out)]
}

/** Path prefixes of a SQLite store's files (never its directory, which may contain the project). */
export function storeFiles(file: string): string[] {
  return ['', '-wal', '-shm', '-journal'].map((suffix) => `${file}${suffix}`)
}
