import os from 'node:os'
import { FINGERPRINT_VERSION } from './fingerprint.ts'
import { type Digest, digestParts } from './hash.ts'

/** Version of the capture format. Bump when closure semantics change so old evidence is not reused. */
export const CAPTURE_VERSION = `2.${FINGERPRINT_VERSION}`

/**
 * Facts every check can observe without reading them through a hooked API. A change to any of
 * them invalidates all evidence. Runner-specific facts (runner and bundler versions) are added by
 * the adapter.
 */
export function runtimeFacts(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const intl = Intl.DateTimeFormat().resolvedOptions()
  const facts: Record<string, string> = {
    capture: CAPTURE_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    icu: process.versions.icu ?? '',
    unicode: process.versions.unicode ?? '',
    tz: process.env.TZ ?? intl.timeZone ?? '',
    locale: intl.locale,
    lang: process.env.LANG ?? '',
    lcAll: process.env.LC_ALL ?? '',
    execArgv: withoutDiagnostics(process.execArgv).join(' '),
    nodeOptions: withoutDiagnostics((process.env.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean)).join(' '),
    endianness: os.endianness(),
    ...extra,
  }
  return facts
}

/**
 * Node flags that only produce diagnostics (profiles, reports, a debugger port) and cannot change
 * what a test does. Profiling a run must not make its evidence unusable by runs without it.
 */
const DIAGNOSTIC_FLAG = /^--(cpu-prof|heap-prof|report-|diagnostic-dir|inspect|debug-port)/

function withoutDiagnostics(flags: readonly string[]): string[] {
  return flags.filter((flag) => !DIAGNOSTIC_FLAG.test(flag))
}

export function runtimeKeyOf(facts: Readonly<Record<string, string>>): Digest {
  const keys = Object.keys(facts).sort()
  return digestParts(keys.flatMap((k) => [k, facts[k]]))
}
