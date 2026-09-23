import fs from 'node:fs'
import { type Digest, digest } from './hash.ts'
import { fromRepoPath } from './paths.ts'
import type { Store } from './store.ts'

/** Digest of file content. Shared by capture and planning so both sides agree byte for byte. */
export function hashFileBytes(bytes: Uint8Array): Digest {
  return digest(bytes)
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
  private readonly stats = new Map<string, StatType>()

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
