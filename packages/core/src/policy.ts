import { FLAGS } from './types.ts'

export interface Policy {
  /** Flags that make a record ineligible for reuse. */
  readonly blockingFlags: ReadonlySet<string>
  /** Maximum number of prior records examined per check. */
  readonly maxCandidates: number
}

/**
 * The default policy refuses reuse whenever a check touched a channel whose effect on the outcome
 * is not captured by its closure.
 *
 * Allowed by default, as documented assumptions:
 * - loopback network: servers a test starts are code in its own closure;
 * - eval and new Function: the compiled strings derive from observed inputs;
 * - native addons: their binaries are recorded as dependencies;
 * - env enumeration: every variable read through the enumeration is recorded individually;
 * - writes to the filesystem: later reads by any check are recorded against the file content.
 */
export const DEFAULT_POLICY: Policy = {
  blockingFlags: new Set<string>([
    FLAGS.netRemote,
    FLAGS.spawn,
    FLAGS.sharedWorker,
    FLAGS.snapshotWritten,
    FLAGS.flakySuspect,
    FLAGS.captureIncomplete,
  ]),
  maxCandidates: 20,
}

/** Flags that switch a check's modules to raw source comparison instead of unit fingerprints. */
export const STRICT_SOURCE_FLAGS: ReadonlySet<string> = new Set([
  FLAGS.sourceObserved,
  FLAGS.positionsObserved,
])

export function makePolicy(overrides: { allow?: readonly string[]; block?: readonly string[] } = {}): Policy {
  const blocking = new Set(DEFAULT_POLICY.blockingFlags)
  for (const f of overrides.allow ?? []) blocking.delete(f)
  for (const f of overrides.block ?? []) blocking.add(f)
  return { ...DEFAULT_POLICY, blockingFlags: blocking }
}
