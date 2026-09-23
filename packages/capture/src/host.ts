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
 * Directories holding Veyrum's own code (the adapter, capture and core packages), with and without
 * symlinks resolved, as path prefixes. Nothing under them is ever recorded as an input.
 */
export function veyrumDirs(adapterDir: string): string[] {
  const require = createRequire(import.meta.url)
  const dirs = new Set<string>([adapterDir])
  for (const pkg of ['@veyrum/capture', '@veyrum/core']) {
    const found = packageJsonAbove(require.resolve(pkg), pkg)
    if (found) dirs.add(found.dir)
  }
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
