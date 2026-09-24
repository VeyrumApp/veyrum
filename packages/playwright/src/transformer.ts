import fs from 'node:fs'
import { type Digest, fingerprintModule, type ModuleTransformer } from '@veyrum/core'
import { type PlaywrightCompiler, SOURCE_TRANSFORM_ENV, TEST_PROCESS_ENV } from './compile.ts'

/**
 * The code to fingerprint for a module whose source changed. A module Playwright's test process
 * ran is compiled again with Playwright's own transform (only modules whose compiled code a run
 * reproduced are recorded by their functions, see analyze.ts); a client file is fingerprinted as it
 * is on disk, since a browser ran it that way. Anything uncertain returns null, and the file runs.
 */
export function createTransformer(
  root: string,
  compiler: () => PlaywrightCompiler | null,
): ModuleTransformer {
  return {
    async units(absolutePath: string, env: string): Promise<Record<string, Digest> | null> {
      const source = fs.readFileSync(absolutePath, 'utf8')
      let code = source
      if (env === TEST_PROCESS_ENV) {
        // Component testing adds a plugin of its own to Playwright's transform.
        if (process.env[SOURCE_TRANSFORM_ENV]) return null
        const compiled = compiler()?.compile(absolutePath, source)
        if (compiled == null) return null
        code = compiled
      } else if (env !== '') {
        return null
      }
      const m = fingerprintModule(code, { root })
      const out: Record<string, Digest> = {}
      for (const [unitPath, unit] of m.units) out[unitPath] = unit.fp
      return out
    },
  }
}
