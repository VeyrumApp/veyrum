import fs from 'node:fs'
import { type Digest, digest } from './hash.ts'
import { fromRepoPath } from './paths.ts'
import type { Store } from './store.ts'

/** Digest of file content. Shared by capture and planning so both sides agree byte for byte. */
export function hashFileBytes(bytes: Uint8Array): Digest {
  return digest(bytes)
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/**
 * Fields that only describe the package or steer installing and publishing it: nothing a test
 * runs reads them to load or transform code.
 */
const INERT_FIELDS = [
  // A release bumps it; code that reads it reads the manifest itself, a `file` or `mod` input.
  'version',
  'scripts',
  'engines',
  'devEngines',
  'packageManager',
  'publishConfig',
  'files',
  'private',
  'description',
  'keywords',
  'author',
  'contributors',
  'maintainers',
  'license',
  'repository',
  'bugs',
  'homepage',
  'funding',
]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Digest of a package manifest as the runner's toolchain uses it. The toolchain reads manifests
 * for module format, resolution and the names of dependencies; the installed version of every
 * package a check loads is recorded separately, by that package's own manifest. Version ranges,
 * scripts, install and publish settings, and descriptive metadata therefore cannot change an
 * outcome by themselves and are left out. Every other field, and the order of fields, is kept.
 * Unparsable content is compared byte for byte.
 */
export function hashManifest(bytes: Uint8Array): Digest {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return hashFileBytes(bytes)
  }
  if (!isPlainObject(value)) return hashFileBytes(bytes)
  const projected: Record<string, unknown> = { ...value }
  for (const field of INERT_FIELDS) delete projected[field]
  // Resolvers use a package's own name only to resolve imports of the package from inside itself,
  // which Node, Jest and oxc allow only through "exports". Jest's lookup of repository packages
  // by name is recorded separately, as `pkgname` entries.
  if (projected.exports === undefined) delete projected.name
  for (const field of DEPENDENCY_FIELDS) {
    const deps = projected[field]
    if (isPlainObject(deps)) projected[field] = Object.keys(deps).sort()
  }
  return digest(`manifest\n${JSON.stringify(projected)}`)
}

/** Digest of a directory listing (entry names only, order-insensitive). */
export function hashDirNames(names: readonly string[]): Digest {
  return digest(`dir\n${[...names].sort().join('\n')}`)
}

/** Digest of an environment variable value; null when unset. */
export function hashEnvValue(value: string | undefined): Digest | null {
  return value === undefined ? null : digest(`env\n${value}`)
}

export type StatType = 'file' | 'dir' | 'other' | 'absent'

/** The fs functions CurrentState uses; injectable so capture hooks never observe the planner. */
export interface StateFs {
  readonly statSync: typeof fs.statSync
  readonly readFileSync: typeof fs.readFileSync
  readonly readdirSync: typeof fs.readdirSync
}

/** Files modified this recently are never served from the stat cache (the racy-git problem). */
const TOO_NEW_MS = 2000

const NOT_A_FILE = 'not-a-file'

/**
 * Current fingerprints of files, directories and environment variables, with a persistent
 * stat cache keyed on size, mtime and inode.
 */
export class CurrentState {
  private readonly files = new Map<string, Digest | null>()
  private readonly dirs = new Map<string, Digest | null>()
  private readonly manifests = new Map<string, Digest | null>()
  private readonly stats = new Map<string, StatType>()
  private packageNames: Map<string, string[]> | undefined

  readonly root: string
  private readonly store: Store | undefined
  private readonly env: NodeJS.ProcessEnv
  private readonly fs: StateFs

  constructor(
    root: string,
    store: Store | undefined,
    env: NodeJS.ProcessEnv = process.env,
    fsImpl: StateFs = fs,
  ) {
    this.root = root
    this.store = store
    this.env = env
    this.fs = fsImpl
  }

  /** Content digest of a file; null if it does not exist; a sentinel if it is not a regular file. */
  fileDigest(repoPath: string): Digest | null {
    const cached = this.files.get(repoPath)
    if (cached !== undefined) return cached
    const value = this.computeFileDigest(fromRepoPath(this.root, repoPath))
    this.files.set(repoPath, value)
    return value
  }

  /** Manifest digest of a file (see `hashManifest`); null if it does not exist. */
  manifestDigest(repoPath: string): Digest | null {
    const cached = this.manifests.get(repoPath)
    if (cached !== undefined) return cached
    let value: Digest | null
    try {
      const absolute = fromRepoPath(this.root, repoPath)
      value = this.fs.statSync(absolute).isFile() ? hashManifest(this.fs.readFileSync(absolute)) : NOT_A_FILE
    } catch {
      value = null
    }
    this.manifests.set(repoPath, value)
    return value
  }

  statType(repoPath: string): StatType {
    const cached = this.stats.get(repoPath)
    if (cached) return cached
    let value: StatType
    try {
      const st = this.fs.statSync(fromRepoPath(this.root, repoPath))
      value = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'
    } catch {
      value = 'absent'
    }
    this.stats.set(repoPath, value)
    return value
  }

  dirDigest(repoPath: string): Digest | null {
    const cached = this.dirs.get(repoPath)
    if (cached !== undefined) return cached
    let value: Digest | null
    try {
      value = hashDirNames(this.fs.readdirSync(fromRepoPath(this.root, repoPath)) as string[])
    } catch {
      value = null
    }
    this.dirs.set(repoPath, value)
    return value
  }

  /**
   * Digest of the repository manifests that declare a package name, given the repository's file
   * list. Capture and planning compute it the same way, over every package.json outside
   * node_modules: a superset of what Jest indexes, so a change Jest would see always shows here.
   */
  packageNameDigest(name: string, files: () => readonly string[]): Digest {
    if (!this.packageNames) {
      this.packageNames = new Map()
      for (const file of files()) {
        if (file !== 'package.json' && !file.endsWith('/package.json')) continue
        let declared: unknown
        try {
          declared = (
            JSON.parse(this.fs.readFileSync(fromRepoPath(this.root, file), 'utf8') as string) as {
              name?: unknown
            }
          ).name
        } catch {
          continue
        }
        if (typeof declared !== 'string') continue
        const list = this.packageNames.get(declared)
        if (list) list.push(file)
        else this.packageNames.set(declared, [file])
      }
    }
    return digest(`pkgname\n${(this.packageNames.get(name) ?? []).sort().join('\n')}`)
  }

  envDigest(name: string, injected: Readonly<Record<string, Digest | null>>): Digest | null {
    if (Object.hasOwn(injected, name)) return injected[name] ?? null
    return hashEnvValue(this.env[name])
  }

  private computeFileDigest(absolute: string): Digest | null {
    let st: fs.BigIntStats
    try {
      st = this.fs.statSync(absolute, { bigint: true }) as fs.BigIntStats
    } catch {
      return null
    }
    if (!st.isFile()) return NOT_A_FILE
    const size = Number(st.size)
    const mtimeNs = st.mtimeNs.toString()
    const ino = Number(st.ino)
    const cached = this.store?.getStat(absolute)
    if (cached && cached.size === size && cached.mtimeNs === mtimeNs && cached.ino === ino && cached.digest) {
      return cached.digest
    }
    let value: Digest
    try {
      value = hashFileBytes(this.fs.readFileSync(absolute))
    } catch {
      return null
    }
    const ageMs = Date.now() - Number(st.mtimeMs)
    if (this.store && ageMs > TOO_NEW_MS) this.store.putStat(absolute, size, mtimeNs, ino, value)
    return value
  }
}
