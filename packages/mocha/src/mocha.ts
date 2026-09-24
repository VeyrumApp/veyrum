import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/** Mocha's parsed options (its CLI's argv): option names as Mocha spells them, positionals in `_`. */
export type MochaOptions = Record<string, unknown> & { _: unknown[] }

/** The project's own Mocha installation. */
export interface TargetMocha {
  readonly dir: string
  readonly version: string
}

export function resolveTargetMocha(root: string): TargetMocha {
  let manifest: string
  try {
    manifest = createRequire(path.join(root, 'package.json')).resolve('mocha/package.json')
  } catch {
    throw new Error(`Cannot find Mocha installed in ${root}`)
  }
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: string }
  const dir = path.dirname(manifest)
  return { dir, version: pkg.version ?? '' }
}

/** Loads one of Mocha's own modules from its installation. */
export function mochaModule<T>(mochaDir: string, rel: string): T {
  return createRequire(path.join(mochaDir, 'package.json'))(`./${rel}`) as T
}

/**
 * Mocha's options as its command line would see them: the arguments given, then MOCHA_OPTIONS, the
 * config file (.mocharc.* or --config) and the package.json "mocha" key, with Mocha's own loader.
 * Mocha resolves these against the working directory.
 */
export function loadMochaOptions(mochaDir: string, argv: readonly string[]): MochaOptions {
  const { loadOptions } = mochaModule<{ loadOptions(argv: string[]): MochaOptions }>(
    mochaDir,
    'lib/cli/options.js',
  )
  return loadOptions([...argv])
}

/**
 * Splits options into Node's and Mocha's the way Mocha's executable does before it either runs
 * Mocha in its own process or starts one with the Node flags: Node's flags as command line
 * arguments, and Mocha's options without them (timeouts off when a debugger flag is present).
 */
export function splitNodeFlags(
  mochaDir: string,
  options: MochaOptions,
): { nodeArgv: string[]; mochaOptions: MochaOptions } {
  const flags = mochaModule<{
    isNodeFlag(flag: string): boolean
    impliesNoTimeouts(flag: string): boolean
    unparseNodeFlags(opts: Record<string, unknown>): string[]
  }>(mochaDir, 'lib/cli/node-flags.js')
  const mochaOptions: MochaOptions = { _: [] }
  const nodeOptions: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(options)) {
    if (flags.isNodeFlag(name))
      nodeOptions[name !== 'v8-options' && /^v8-/.test(name) ? name.slice(3) : name] = value
    else mochaOptions[name] = value
  }
  const nodeOption = mochaOptions['node-option'] as string[] | undefined
  if ([...Object.keys(nodeOptions), ...(nodeOption ?? [])].some((f) => flags.impliesNoTimeouts(f)))
    mochaOptions.timeout = 0
  delete mochaOptions['node-option']
  return {
    nodeArgv: nodeOption ? nodeOption.map((v) => `--${v}`) : flags.unparseNodeFlags(nodeOptions),
    mochaOptions,
  }
}

/**
 * The spec files Mocha runs for these options (without --file entries, which it loads before
 * them), as absolute paths: Mocha's own file lookup with its extension, recursion and ignore rules.
 * Resolved against the working directory, as Mocha does.
 */
export function specFiles(mochaDir: string, options: MochaOptions): string[] {
  const lookupFiles = mochaModule<(spec: string, extensions: string[], recursive: boolean) => unknown>(
    mochaDir,
    'lib/cli/lookup-files.js',
  )
  type Match = (file: string, pattern: string, options: object) => boolean
  // Mocha's own minimatch: a function up to version 3, a named export since.
  const loaded = createRequire(path.join(mochaDir, 'lib', 'cli', 'collect-files.js'))('minimatch') as
    | Match
    | { minimatch: Match }
  const minimatch = typeof loaded === 'function' ? loaded : loaded.minimatch
  const specs = options._.length > 0 ? options._.map(String) : ['test']
  const extensions = (options.extension as string[] | undefined) ?? []
  const ignore = (options.ignore as string[] | undefined) ?? []
  const found = new Set<string>()
  for (const spec of specs) {
    let matched: unknown
    try {
      matched = lookupFiles(spec, extensions, Boolean(options.recursive))
    } catch (error) {
      // Mocha warns about a pattern that matches nothing and goes on.
      if ((error as { code?: unknown }).code === 'ERR_MOCHA_NO_FILES_MATCH_PATTERN') continue
      throw error
    }
    const list = matched === undefined ? [] : Array.isArray(matched) ? matched : [matched]
    for (const file of list as string[]) {
      if (ignore.some((pattern) => minimatch(file, pattern, { windowsPathsNoEscape: true }))) continue
      found.add(path.resolve(file))
    }
  }
  return [...found]
}

/** Runs `fn` with the working directory set to `dir`, which Mocha resolves its configuration in. */
export function inDirectory<T>(dir: string, fn: () => T): T {
  const before = process.cwd()
  if (path.resolve(before) === path.resolve(dir)) return fn()
  process.chdir(dir)
  try {
    return fn()
  } finally {
    process.chdir(before)
  }
}
