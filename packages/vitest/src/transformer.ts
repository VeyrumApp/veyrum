import { type Digest, fingerprintModule, type ModuleTransformer } from '@veyrum/core'
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
      const project = vitest.projects.find((p) => p.name === projectName) ?? vitest.getRootProject()
      const environment = project.vite.environments[env]
      if (!environment) return null
      const node = environment.moduleGraph.getModuleById(absolutePath)
      if (node) environment.moduleGraph.invalidateModule(node)
      const result = await environment.transformRequest(absolutePath)
      if (!result) return null
      const m = fingerprintModule(result.code, { root })
      const out: Record<string, Digest> = {}
      for (const [path, unit] of m.units) out[path] = unit.fp
      return out
    },
  }
}
