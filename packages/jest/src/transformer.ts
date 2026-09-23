import fs from 'node:fs'
import vm from 'node:vm'
import { type Digest, fingerprintModule, type ModuleTransformer } from '@veyrum/core'

/** The parts of a Jest project config the transformer needs. */
export interface ProjectConfigLike {
  readonly id: string
  readonly extensionsToTreatAsEsm: readonly string[]
}

interface ScriptTransformerLike {
  transformSource(filepath: string, content: string, options: Record<string, unknown>): { code: string }
  transformSourceAsync(
    filepath: string,
    content: string,
    options: Record<string, unknown>,
  ): Promise<{ code: string }>
}

export interface JestTransformApi {
  createScriptTransformer(config: unknown): Promise<ScriptTransformerLike>
  shouldLoadAsEsm(file: string, extensionsToTreatAsEsm: readonly string[]): boolean
}

/** The options jest-runtime transforms with (coverage is off in Veyrum runs). */
const CJS_OPTIONS = {
  instrument: false,
  isInternalModule: false,
  supportsDynamicImport: typeof (vm as { SyntheticModule?: unknown }).SyntheticModule === 'function',
  supportsExportNamespaceFrom: false,
  supportsStaticESM: false,
  supportsTopLevelAwait: false,
}
const ESM_OPTIONS = {
  instrument: false,
  isInternalModule: false,
  supportsDynamicImport: true,
  supportsExportNamespaceFrom: true,
  supportsStaticESM: true,
  supportsTopLevelAwait: true,
}

/**
 * Re-transforms a module through the project's own Jest transform pipeline, producing the code the
 * runtime would compile, and fingerprints its units. Used only for modules whose source changed.
 */
export function createTransformer(
  api: JestTransformApi,
  configs: ReadonlyMap<string, ProjectConfigLike>,
  root: string,
): ModuleTransformer {
  const transformers = new Map<string, Promise<ScriptTransformerLike>>()
  return {
    async units(absolutePath: string, _env: string, project: string): Promise<Record<string, Digest> | null> {
      const config = configs.get(project)
      if (!config) return null
      let transformer = transformers.get(project)
      if (!transformer) {
        transformer = api.createScriptTransformer(config)
        transformers.set(project, transformer)
      }
      const st = await transformer
      const source = fs.readFileSync(absolutePath, 'utf8')
      const esm = api.shouldLoadAsEsm(absolutePath, config.extensionsToTreatAsEsm)
      const result = esm
        ? await st.transformSourceAsync(absolutePath, source, ESM_OPTIONS)
        : st.transformSource(absolutePath, source, CJS_OPTIONS)
      const m = fingerprintModule(result.code, { root })
      const out: Record<string, Digest> = {}
      for (const [path, unit] of m.units) out[path] = unit.fp
      return out
    },
  }
}
