import fs from 'node:fs'
import { type Digest, fingerprintModule, type ModuleTransformer, NATIVE_ENV } from '@veyrum/core'
import type { Vitest } from 'vitest/node'

/**
 * Re-transforms a module through the project's own Vite pipeline, producing the same code a
 * worker would execute, and fingerprints its units. Used only for modules whose source changed.
 */
export function createTransformer(vitest: Vitest, root: string): ModuleTransformer {
  return {
    async units(
      absolutePath: string,
      env: string,
      projectName: string,
    ): Promise<Record<string, Digest> | null> {
      // Node loaded it itself, as its source reads (an externalized workspace package's build).
      if (env === NATIVE_ENV) return fingerprintSource(fs.readFileSync(absolutePath, 'utf8'), root)
      const project = vitest.projects.find((p) => p.name === projectName) ?? vitest.getRootProject()
      const environment = project.vite.environments[env]
      if (!environment) return null
      const node = environment.moduleGraph.getModuleById(absolutePath)
      if (node) environment.moduleGraph.invalidateModule(node)
      const result = await environment.transformRequest(absolutePath)
      if (!result) return null
      return fingerprintSource(result.code, root)
    },
  }
}

function fingerprintSource(code: string, root: string): Record<string, Digest> {
  const m = fingerprintModule(code, { root })
  const out: Record<string, Digest> = {}
  for (const [path, unit] of m.units) out[path] = unit.fp
  return out
}
