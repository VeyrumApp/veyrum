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
  /^(package\.json|tsconfig(\..*)?\.json|jsconfig(\..*)?\.json|\.env(\..*)?|vite(st)?\.config\..*|vitest\.(workspace|projects)\..*|\.babelrc(\..*)?|babel\.config\..*|\.npmrc|pnpm-workspace\.yaml|\.swcrc|\.browserslistrc|browserslist)$/

export function isConfigLike(repoPath: string): boolean {
  const base = repoPath.slice(repoPath.lastIndexOf('/') + 1)
  return CONFIG_LIKE.test(base)
}
