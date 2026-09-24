export { isConfigLike, listRepoFiles } from './files.ts'
export {
  deserializeUnits,
  FINGERPRINT_VERSION,
  type FingerprintOptions,
  fingerprintModule,
  type ModuleUnits,
  moduleUnitsOf,
  OPAQUE_UNIT,
  serializeUnits,
  TOP_UNIT,
  type UnitInfo,
} from './fingerprint.ts'
export { type Digest, digest, digestParts } from './hash.ts'
export {
  fromRepoPath,
  isInside,
  normalizeAbsolute,
  type PathAlias,
  pathAliases,
  stem,
  toRepoPath,
  unalias,
} from './paths.ts'
export { describeUnit, type ModuleTransformer, type PlanOptions, plan } from './planner.ts'
export { DEFAULT_POLICY, makePolicy, type Policy, STRICT_SOURCE_FLAGS } from './policy.ts'
export { CAPTURE_VERSION, runtimeFacts, runtimeKeyOf } from './runtime.ts'
export {
  type CheckOutcomeSummary,
  ConfigurationError,
  checkKey,
  type Execution,
  forcedDecisions,
  inShard,
  needsPlan,
  parseShard,
  type RunMode,
  type RunOptions,
  type RunResult,
  recordEvidence,
  recordUncapturedFailures,
  recordVerifications,
  type Shard,
  seededRandom,
  selectExecution,
  selectFiles,
  type Verification,
} from './session.ts'
export {
  CurrentState,
  hashDirNames,
  hashEnvValue,
  hashFileBytes,
  hashManifest,
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
  type RecordChannels,
  type RunInfo,
  type TestOutcome,
} from './types.ts'
