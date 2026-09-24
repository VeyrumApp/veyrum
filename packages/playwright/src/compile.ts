import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { unobserved } from '@veyrum/capture'

/**
 * The transform environment of modules Playwright's test process compiled (see PayloadModule.env):
 * at plan time they are compiled again with Playwright's own transform. Client files, which a
 * browser ran as they are on disk, keep the empty environment.
 */
export const TEST_PROCESS_ENV = 'playwright-test'

/**
 * Set for component testing: Playwright then adds a Babel plugin of its own to the transform of the
 * files in PW_TEST_SOURCE_TRANSFORM_SCOPE, which Veyrum does not reproduce.
 */
export const SOURCE_TRANSFORM_ENV = 'PW_TEST_SOURCE_TRANSFORM'

type BabelTransform = (
  code: string,
  filename: string,
  isModule: boolean,
  pluginsEpilogue: readonly unknown[],
  jsxImportSource: string | undefined,
) => { code?: string | null } | null

/** Compiles a module the way Playwright's test process does. */
export interface PlaywrightCompiler {
  /** The code Playwright's transform produces for this source, or null if it fails. */
  compile(absolutePath: string, source: string): string | null
}

/**
 * Playwright's own transform, from the project's installed `playwright` package (its directory),
 * or null when its internals are not found or not what this adapter knows (Playwright 1.63).
 *
 * Playwright compiles every module of the test process outside node_modules with Babel, in
 * `transformHook` (lib/common/index.js): `babelTransform(source, file, isModule, pluginsEpilogue,
 * jsxImportSource)` from lib/transform/babelBundle.js. This calls that same function with the
 * arguments Playwright passes once the configuration is loaded: no epilogue plugins (they exist
 * only for component testing), the `playwright` package itself as the JSX import source, and the
 * module format Playwright decides for the file. Whether this reproduces what a run compiled is
 * checked byte for byte on every module before it is fingerprinted by its functions (analyze.ts).
 */
export function loadPlaywrightCompiler(playwrightDir: string | null): PlaywrightCompiler | null {
  if (!playwrightDir) return null
  return unobserved(() => {
    try {
      const common = path.join(playwrightDir, 'lib', 'common', 'index.js')
      const local = createRequire(common)
      const bundle = local(path.join(playwrightDir, 'lib', 'transform', 'babelBundle.js')) as {
        babelTransform?: unknown
      }
      if (typeof bundle.babelTransform !== 'function') return null
      const babelTransform = bundle.babelTransform as BabelTransform
      // What Playwright's configuration loader sets: path.dirname(require.resolve('playwright')),
      // resolved from Playwright's own code.
      const jsxImportSource = path.dirname(local.resolve('playwright'))
      const isModule = moduleFormat()
      return {
        compile(absolutePath: string, source: string): string | null {
          return unobserved(() => {
            try {
              const result = babelTransform(source, absolutePath, isModule(absolutePath), [], jsxImportSource)
              // Playwright runs the source as it is when Babel returns no code (an empty module).
              return result?.code ? result.code : source
            } catch {
              return null
            }
          })
        },
      }
    } catch {
      return null
    }
  })
}

/**
 * Playwright's `fileIsModule`: .mjs and .mts are ES modules, .cjs and .cts CommonJS, and any other
 * file follows the "type" of the nearest package.json. A file loaded another way (required although
 * its package is a module) compiles differently, which the byte-for-byte check finds.
 */
function moduleFormat(): (file: string) => boolean {
  const manifests = new Map<string, string | null>()
  const nearest = (dir: string): string | null => {
    const cached = manifests.get(dir)
    if (cached !== undefined) return cached
    const candidate = path.join(dir, 'package.json')
    const parent = path.dirname(dir)
    const found = fs.existsSync(candidate) ? candidate : parent === dir ? null : nearest(parent)
    manifests.set(dir, found)
    return found
  }
  return (file) => {
    if (file.endsWith('.mjs') || file.endsWith('.mts')) return true
    if (file.endsWith('.cjs') || file.endsWith('.cts')) return false
    const manifest = nearest(path.dirname(file))
    if (!manifest) return false
    try {
      return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { type?: unknown }).type === 'module'
    } catch {
      return false
    }
  }
}
