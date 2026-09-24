import path from 'node:path'

/** Converts an absolute path to a repository-relative POSIX path, or keeps it absolute if outside. */
export function toRepoPath(root: string, absolute: string): string {
  const rel = path.relative(root, absolute)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return absolute.split(path.sep).join('/')
  return rel.split(path.sep).join('/')
}

/**
 * An absolute path in one canonical spelling, for comparing paths as strings: resolved, and on
 * Windows with backslashes and an upper-case drive letter (runners also spell them `c:/x/y`).
 */
export function normalizeAbsolute(p: string): string {
  const resolved = path.resolve(p)
  return path.sep === '\\' && /^[a-z]:/.test(resolved)
    ? resolved[0]!.toUpperCase() + resolved.slice(1)
    : resolved
}

export function fromRepoPath(root: string, repoPath: string): string {
  return path.isAbsolute(repoPath) ? repoPath : path.join(root, repoPath)
}

export function isInside(root: string, absolute: string): boolean {
  const rel = path.relative(root, absolute)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Strips the extension of a repository path: `src/a/foo.test.ts` becomes `src/a/foo.test`. */
export function stem(repoPath: string): string {
  const slash = repoPath.lastIndexOf('/')
  const dot = repoPath.lastIndexOf('.')
  return dot > slash + 1 ? repoPath.slice(0, dot) : repoPath
}
