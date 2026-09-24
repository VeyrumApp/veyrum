import path from 'node:path'
import { fromRepoPath, isInside, toRepoPath } from './paths.ts'
import type { StateFs } from './state.ts'

/**
 * TypeScript and JavaScript project configurations, and which test files a change to one can
 * affect.
 *
 * Vite 8 reads them in native code: its oxc transform plugin passes rolldown's `TsconfigCache` to
 * `transformSync` (vite/dist/node/chunks/node.js, `transformWithOxc`), and its resolver hands
 * `resolve.tsconfigPaths` to oxc's resolver. Both discover a file's configuration the same way,
 * checked against rolldown 1.2 with `resolveTsconfig`:
 *
 * - only a file named `tsconfig.json` is discovered, in the file's own directory or an ancestor;
 *   `tsconfig.*.json` and `jsconfig.json` never are;
 * - the nearest one is used when its `files`/`include`/`exclude` cover the file, a project it
 *   `references` is used when that one covers the file (its patterns may reach outside its own
 *   directory, as `../lib` does), and otherwise the search goes on in the parent directory;
 * - `extends` merges the base's options, and a base that cannot be loaded fails the transform.
 *
 * Vite 7 discovers through tsconfck (bundled in vite/dist/node/chunks/config.js): `find` stats
 * `tsconfig.json` in the file's directory and each ancestor, in JavaScript, so those reads are
 * observed and stay shared inputs, and `resolveSolutionTSConfig` swaps in a referenced project
 * (`path`, or `path/tsconfig.json`) whose patterns include the file. esbuild, which Vite 7 builds
 * with, also discovers `jsconfig.json`. So a configuration applies to a file only when that file
 * lies below the directory of a discovered `tsconfig.json` or `jsconfig.json` whose chain of
 * `extends` and `references` reaches the configuration. That holds whatever the patterns say,
 * which is what makes the scope below independent of the content a configuration had when
 * evidence was recorded.
 *
 * Edges are derived from content alone, never from what exists: a package a configuration
 * extends is looked up as every path it could be found at, the package's manifest among them.
 * Those paths are recorded (absent ones as absent), so a change in what they hold, including a
 * reinstall or a link that now points elsewhere, is a change to a recorded input.
 */

/** Files the runner may treat as project configurations, wherever they are. */
export const PROJECT_CONFIG = /(^|\/)(tsconfig|jsconfig)[^/]*\.json$/

/** Names discovered by walking up from a file (see above). */
const DISCOVERED = new Set(['tsconfig.json', 'jsconfig.json'])

/**
 * What a configuration extends and references: repository paths, whether they exist now or not,
 * and whether it may also reach configurations that are not modeled (any at all).
 */
interface Edges {
  readonly targets: readonly string[]
  readonly any: boolean
}

const UNKNOWN: Edges = { targets: [], any: true }

/**
 * Parses JSON with comments and trailing commas, as TypeScript and oxc accept in configuration
 * files. Throws on anything else.
 */
export function parseJsonc(text: string): unknown {
  /** The index after the comment starting at `i`, or `i` when none starts there. */
  const skipComment = (i: number): number => {
    if (text[i] !== '/') return i
    if (text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2)
      return end < 0 ? text.length : end
    }
    if (text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) throw new SyntaxError('unterminated comment')
      return end + 2
    }
    return i
  }
  let out = ''
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      const start = i
      i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      i++
      out += text.slice(start, i)
      continue
    }
    const after = skipComment(i)
    if (after !== i) {
      // A comment separates tokens like whitespace does.
      out += ' '
      i = after
      continue
    }
    if (c === ',') {
      // A trailing comma: the next significant character closes the object or array.
      let j = i + 1
      for (;;) {
        while (j < text.length && /\s/.test(text[j]!)) j++
        const next = skipComment(j)
        if (next === j) break
        j = next
      }
      if (text[j] === '}' || text[j] === ']') {
        i++
        continue
      }
    }
    out += c
    i++
  }
  return JSON.parse(out)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every string in a package `exports` target, whatever the conditions (a superset of any pick). */
function exportTargets(target: unknown): string[] | null {
  if (typeof target === 'string') return [target]
  if (target === null) return []
  const values = Array.isArray(target) ? target : isPlainObject(target) ? Object.values(target) : null
  if (!values) return null
  const out: string[] = []
  for (const value of values) {
    const nested = exportTargets(value)
    if (!nested) return null
    out.push(...nested)
  }
  return out
}

/** The fs functions reading configurations needs (unpatched while capture hooks are active). */
export type ConfigFs = Pick<StateFs, 'readFileSync' | 'statSync'>

/**
 * The project configurations of a repository as they are now, and the edges between them:
 * a configuration points to the ones it extends and references.
 */
export class ProjectConfigs {
  private readonly root: string
  private readonly fs: ConfigFs
  private readonly known: readonly string[]
  private readonly parsed = new Map<string, Record<string, unknown> | undefined>()
  private readonly edgeCache = new Map<string, Edges>()
  private reverse: Map<string, string[]> | undefined
  /** Configurations that may reach any other. */
  private readonly reachAny: string[] = []

  /** `files`: the repository's files; every project configuration among them is a node. */
  constructor(root: string, fs: ConfigFs, files: readonly string[]) {
    this.root = root
    this.fs = fs
    this.known = files.filter((f) => PROJECT_CONFIG.test(f))
  }

  /**
   * The configuration files a run depends on: the given configurations, and every path the ones
   * that exist extend or reference, followed as far as those exist. Paths that do not exist are
   * included, since a file appearing there changes what they extend.
   */
  related(start: readonly string[]): string[] {
    const { existing, candidates } = this.walk(start)
    return [...new Set([...existing, ...candidates])].sort()
  }

  /** Whether the configuration exists and parses. */
  parses(p: string): boolean {
    return this.parse(p) !== undefined
  }

  /**
   * The directories whose files a change to a configuration can affect, or null when that can be
   * any file: the directory of every discovered configuration whose chain of `extends` and
   * `references` reaches it, itself included. A configuration at the repository root governs
   * everything. Computed over the configurations as they are now; see `docs/design/soundness.md`
   * for why that covers what the configurations were when evidence was recorded.
   */
  scope(p: string): readonly string[] | null {
    const reverse = this.reverseEdges()
    const dirs = new Set<string>()
    const seen = new Set<string>()
    const queue = [p]
    while (queue.length > 0) {
      const node = queue.pop()!
      if (seen.has(node)) continue
      seen.add(node)
      const slash = node.lastIndexOf('/')
      if (DISCOVERED.has(node.slice(slash + 1))) {
        if (slash < 0) return null
        dirs.add(node.slice(0, slash))
      }
      queue.push(...(reverse.get(node) ?? []), ...this.reachAny)
    }
    return [...dirs].sort()
  }

  /** The existing configurations reachable from `start`, and every path their edges name. */
  private walk(start: readonly string[]): { existing: Set<string>; candidates: Set<string> } {
    const existing = new Set<string>()
    const candidates = new Set<string>()
    const queue = [...start]
    while (queue.length > 0) {
      const p = queue.pop()!
      if (existing.has(p) || !this.isFile(p)) continue
      existing.add(p)
      for (const target of this.edges(p).targets) {
        candidates.add(target)
        // A package manifest is an input of the lookup, not a configuration.
        if (!target.endsWith('/package.json')) queue.push(target)
      }
    }
    return { existing, candidates }
  }

  private reverseEdges(): Map<string, string[]> {
    if (this.reverse) return this.reverse
    const reverse = new Map<string, string[]>()
    for (const from of this.walk(this.known).existing) {
      const edges = this.edges(from)
      if (edges.any) this.reachAny.push(from)
      for (const to of edges.targets) {
        const list = reverse.get(to)
        if (list) list.push(from)
        else reverse.set(to, [from])
      }
    }
    this.reverse = reverse
    return reverse
  }

  private isFile(p: string): boolean {
    try {
      return this.fs.statSync(fromRepoPath(this.root, p)).isFile()
    } catch {
      return false
    }
  }

  private parse(p: string): Record<string, unknown> | undefined {
    if (this.parsed.has(p)) return this.parsed.get(p)
    let value: Record<string, unknown> | undefined
    try {
      const json = parseJsonc(this.fs.readFileSync(fromRepoPath(this.root, p), 'utf8') as string)
      if (isPlainObject(json)) value = json
    } catch {
      value = undefined
    }
    this.parsed.set(p, value)
    return value
  }

  /**
   * What a configuration extends and references. A configuration that does not parse, or names
   * its bases in a form not modeled, may reach any.
   */
  private edges(p: string): Edges {
    const cached = this.edgeCache.get(p)
    if (cached) return cached
    const config = this.parse(p)
    let result = UNKNOWN
    const ext = config?.extends
    const refs = config?.references
    const extendsList = Array.isArray(ext) ? ext : ext === undefined ? [] : [ext]
    const refList = Array.isArray(refs) ? refs : refs === undefined ? [] : null
    const specs: { spec: string; reference: boolean }[] = []
    if (config && refList) {
      for (const spec of extendsList) if (typeof spec === 'string') specs.push({ spec, reference: false })
      for (const ref of refList) {
        const spec = (ref as { path?: unknown } | null)?.path
        if (typeof spec === 'string') specs.push({ spec, reference: true })
      }
    }
    if (config && refList && specs.length === extendsList.length + refList.length) {
      const dir = path.dirname(fromRepoPath(this.root, p))
      const targets: string[] = []
      let any = false
      for (const { spec, reference } of specs) {
        const resolved = this.resolve(dir, spec, reference)
        targets.push(...resolved.targets)
        any ||= resolved.any
      }
      result = { targets, any }
    }
    this.edgeCache.set(p, result)
    return result
  }

  /**
   * Where a specifier can lead, as TypeScript resolves it. A reference path, and an `extends`
   * path that is absolute or starts with `./` or `../`, names a file relative to the
   * configuration: for a reference also a directory's `tsconfig.json`, and `extends` adds `.json`
   * when it is missing. Any other `extends` names a package in the node_modules directory of the
   * configuration's directory or an ancestor: each of those is a candidate, with the files the
   * specifier can name in it (through the manifest's `exports` or `tsconfig` field, or directly)
   * and the manifest. Only the nearest manifest decides; a package found in none of them, or one
   * whose manifest maps the specifier in a way not modeled, may reach any configuration.
   * Paths outside the repository are left out: they are not repository inputs.
   */
  private resolve(dir: string, spec: string, reference: boolean): Edges {
    const inRepo = (candidates: readonly string[]): string[] =>
      candidates.filter((c) => isInside(this.root, c)).map((c) => toRepoPath(this.root, c))
    if (reference || spec.startsWith('./') || spec.startsWith('../') || path.isAbsolute(spec)) {
      const absolute = path.resolve(dir, spec)
      const candidates = [absolute]
      if (reference) candidates.push(path.join(absolute, 'tsconfig.json'))
      else if (!absolute.endsWith('.json')) candidates.push(`${absolute}.json`)
      return { targets: inRepo(candidates), any: false }
    }
    const parts = spec.split('/')
    const scoped = spec.startsWith('@')
    const name = parts.slice(0, scoped ? 2 : 1).join('/')
    const subpath = parts.slice(scoped ? 2 : 1).join('/')
    if (!/^(@[^/.][^/]*\/)?[^/.][^/]*$/.test(name)) return UNKNOWN
    const direct = (pkg: string): string[] => {
      if (!subpath) return [path.join(pkg, 'tsconfig.json')]
      const base = path.join(pkg, subpath)
      return [base, `${base}.json`, path.join(base, 'tsconfig.json')]
    }
    const candidates: string[] = []
    let nearest: string | undefined
    for (let d = dir; isInside(this.root, d) || d === this.root; d = path.dirname(d)) {
      const pkg = path.join(d, 'node_modules', name)
      candidates.push(path.join(pkg, 'package.json'), ...direct(pkg))
      if (nearest === undefined && this.isFile(toRepoPath(this.root, path.join(pkg, 'package.json'))))
        nearest = pkg
      if (d === this.root) break
    }
    if (nearest === undefined) return { targets: inRepo(candidates), any: true }
    const manifest = this.parse(toRepoPath(this.root, path.join(nearest, 'package.json')))
    if (!manifest) return { targets: inRepo(candidates), any: true }
    let mapped: string[] | null = []
    if (manifest.exports !== undefined) {
      mapped = this.exported(manifest.exports, subpath)
    } else if (!subpath && manifest.tsconfig !== undefined) {
      mapped = typeof manifest.tsconfig === 'string' ? [manifest.tsconfig] : null
    }
    if (!mapped) return { targets: inRepo(candidates), any: true }
    const pkg = nearest
    candidates.push(...mapped.map((m) => path.resolve(pkg, m)))
    return { targets: inRepo(candidates), any: false }
  }

  /**
   * The files a package's `exports` can map a subpath to, or null when that is not modeled: a
   * key that matches exactly (with or without `.json`), or a single `*` pattern.
   */
  private exported(exports: unknown, subpath: string): string[] | null {
    const map =
      isPlainObject(exports) && Object.keys(exports).every((k) => k.startsWith('.'))
        ? exports
        : { '.': exports }
    const wanted = subpath ? [`./${subpath}`, `./${subpath}.json`] : ['.']
    const out: string[] = []
    for (const [key, target] of Object.entries(map)) {
      const star = key.indexOf('*')
      const prefix = key.slice(0, star)
      const suffix = key.slice(star + 1)
      const matches =
        star < 0
          ? wanted.includes(key)
            ? ['']
            : []
          : wanted
              .filter((w) => w.startsWith(prefix) && w.endsWith(suffix) && w.length >= key.length - 1)
              .map((w) => w.slice(prefix.length, w.length - suffix.length))
      if (matches.length === 0) continue
      const targets = exportTargets(target)
      if (!targets) return null
      for (const match of matches) out.push(...targets.map((t) => t.replaceAll('*', match)))
    }
    return out.length > 0 ? out : null
  }
}
