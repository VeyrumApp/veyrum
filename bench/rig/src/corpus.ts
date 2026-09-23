import fs from 'node:fs'

/** A repository to replay. Stored as JSON under bench/corpora. */
export interface Corpus {
  readonly name: string
  /** Git URL to clone. */
  readonly repo: string
  /** Branch whose first-parent history is replayed. */
  readonly branch: string
  /** Replay this many commits after the warm-up commit. */
  readonly commits: number
  /** Optional commit to end at (defaults to the branch head). */
  readonly until?: string
  /** Dependency installation command, run whenever a lockfile changes. */
  readonly install: readonly string[]
  /** Files whose change triggers a reinstall. */
  readonly lockfiles: readonly string[]
  /** Directory (relative to the repository) where the tests run; defaults to the repository root. */
  readonly cwd: string
  /** The project's test runner. */
  readonly runner: 'vitest' | 'jest'
  /** Runner config file, relative to the test root (default: the runner's own lookup). */
  readonly config?: string
  /** Node flags the project's test command passes (for example --expose-gc). */
  readonly nodeArgs: readonly string[]
  /** Extra runner arguments (for example project filters as --project <name>). */
  readonly runnerArgs: readonly string[]
  readonly maxWorkers: number
  /** Force per-file isolation (for projects that set isolate: false). Applied to every selector. */
  readonly forceIsolation: boolean
  /** Regular expressions (on repository paths) of source files eligible for mutation. */
  readonly mutationSources: readonly string[]
  /** Mutants per sampled commit, and how often to sample (every Nth commit). */
  readonly mutantsPerCommit: number
  readonly mutationEvery: number
}

export function loadCorpus(file: string): Corpus {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Corpus> & { vitestArgs?: string[] }
  const required: (keyof Corpus)[] = ['name', 'repo', 'branch', 'commits', 'install', 'lockfiles']
  for (const key of required) if (raw[key] === undefined) throw new Error(`${file}: missing "${key}"`)
  const { vitestArgs, ...rest } = raw
  return {
    cwd: '',
    runner: 'vitest',
    nodeArgs: [],
    runnerArgs: vitestArgs ?? [],
    maxWorkers: 2,
    forceIsolation: false,
    mutationSources: [],
    mutantsPerCommit: 0,
    mutationEvery: 5,
    ...rest,
  } as Corpus
}
