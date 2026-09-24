import fs from 'node:fs'
import { type Digest, fingerprintModule, type ModuleTransformer } from '@veyrum/core'

/**
 * Node runs a module as its loader reads it: the code to fingerprint is the file itself (for
 * TypeScript, Node's type stripping keeps every position, and capture records the source as read).
 * Used only for modules whose source changed.
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
