import fs from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', '.veyrum', '.hg', '.svn'])

/**
 * Lists repository files (POSIX, repository-relative), skipping dependency and VCS directories.
 * Used to detect newly added files that could change module resolution.
 */
export function listRepoFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(rel ? `${rel}/${entry.name}` : entry.name)
      }
    }
  }
  walk(root, '')
  return out.sort()
}

/** Files whose appearance anywhere can change configuration or resolution for every check. */
const CONFIG_LIKE =
  /^(package\.json|tsconfig(\..*)?\.json|jsconfig(\..*)?\.json|\.env(\..*)?|vite(st)?\.config\..*|vitest\.(workspace|projects)\..*|jest\.config\..*|jest-preset\..*|\.babelrc(\..*)?|\.babelignore|babel\.config\..*|\.npmrc|pnpm-workspace\.yaml|\.swcrc|\.browserslistrc|browserslist)$/

/**
 * Manual mocks apply by location: Jest uses a root `__mocks__` file for a node module without any
 * call to jest.mock, and both runners pick up `__mocks__` siblings when a module is mocked.
 */
const MOCKS_DIR = /(^|\/)__mocks__\//

export function isConfigLike(repoPath: string): boolean {
  const base = repoPath.slice(repoPath.lastIndexOf('/') + 1)
  return CONFIG_LIKE.test(base) || MOCKS_DIR.test(repoPath)
}

/** Configuration-like files whose effect is not limited to the directory they are in. */
const GLOBAL_CONFIG_LIKE = /^(\.env(\..*)?|\.npmrc|pnpm-workspace\.yaml)$/

/**
 * The directory a new configuration-like file can affect: a manifest, tsconfig, runner or Babel
 * configuration applies to the files below its directory, and a `__mocks__` file to its siblings'
 * directory. Null when it can affect anything: environment files, install settings, and any file
 * at the repository root.
 */
export function configScope(repoPath: string): string | null {
  const mocks = repoPath.search(MOCKS_DIR)
  const dir =
    mocks >= 0 ? repoPath.slice(0, mocks) : repoPath.slice(0, Math.max(0, repoPath.lastIndexOf('/')))
  const base = repoPath.slice(repoPath.lastIndexOf('/') + 1)
  if (dir === '' || GLOBAL_CONFIG_LIKE.test(base)) return null
  return dir
}
