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

/** A directory's other spelling and its canonical one, both ending in a separator. */
export type PathAlias = readonly [from: string, to: string]

/**
 * The spellings of `dirs` that differ from their canonical form (symbolic links resolved, and on
 * Windows short 8.3 names expanded, as `realpath` gives them), as prefixes to rewrite. A process
 * started in a short-named directory resolves relative paths under that spelling, while runners
 * report the files they run under the canonical one.
 */
export function pathAliases(dirs: readonly string[], realpath: (p: string) => string): PathAlias[] {
  const out: PathAlias[] = []
  for (const dir of dirs) {
    let real: string
    try {
      real = realpath(dir)
    } catch {
      continue
    }
    const from = normalizeAbsolute(dir)
    const to = normalizeAbsolute(real)
    if (from !== to && !out.some(([f]) => f === from + path.sep)) out.push([from + path.sep, to + path.sep])
  }
  return out
}

/** An absolute path with an aliased prefix rewritten to its canonical spelling. */
export function unalias(absolute: string, aliases: readonly PathAlias[]): string {
  for (const [from, to] of aliases) {
    if (absolute.startsWith(from)) return to + absolute.slice(from.length)
    if (absolute === from.slice(0, -1)) return to.slice(0, -1)
  }
  return absolute
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
