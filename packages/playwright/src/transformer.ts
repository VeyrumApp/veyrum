import fs from 'node:fs'
import { type Digest, fingerprintModule, type ModuleTransformer } from '@veyrum/core'

/**
 * The code to fingerprint for a module whose source changed. Modules the test process loads are
 * compared by their source (Playwright compiles them with its own transform), so only client files
 * are fingerprinted: a browser ran them exactly as they are on disk.
 */
export function createTransformer(root: string): ModuleTransformer {
  return {
    async units(absolutePath: string): Promise<Record<string, Digest> | null> {
      const m = fingerprintModule(fs.readFileSync(absolutePath, 'utf8'), { root })
      const out: Record<string, Digest> = {}
      for (const [unitPath, unit] of m.units) out[unitPath] = unit.fp
      return out
    },
  }
}
