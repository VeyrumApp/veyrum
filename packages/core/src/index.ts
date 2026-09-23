export { isConfigLike, listRepoFiles } from './files.ts'
export {
  type FingerprintOptions,
  fingerprintModule,
  type ModuleUnits,
  OPAQUE_UNIT,
  TOP_UNIT,
  type UnitInfo,
} from './fingerprint.ts'
export { type Digest, digest, digestParts } from './hash.ts'
export { fromRepoPath, isInside, stem, toRepoPath } from './paths.ts'
export { describeUnit, type ModuleTransformer, type PlanOptions, plan } from './planner.ts'
export { DEFAULT_POLICY, makePolicy, type Policy, STRICT_SOURCE_FLAGS } from './policy.ts'
export { CAPTURE_VERSION, runtimeFacts, runtimeKeyOf } from './runtime.ts'
export {
  CurrentState,
  hashDirNames,
  hashEnvValue,
  hashFileBytes,
  type StateFs,
  type StatType,
} from './state.ts'
export { Store } from './store.ts'
export {
  type Action,
  type CheckRef,
  type ClosureEntry,
  type ClosureKind,
  type Decision,
  type EvidenceRecord,
  FLAGS,
  type Flag,
  type RunInfo,
  type TestOutcome,
} from './types.ts'
