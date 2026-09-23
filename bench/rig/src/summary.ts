import type { BaselineName, CommitResult, MutantResult, ResultLine } from './replay.ts'
import { upperBound95 } from './report.ts'

/** One replayed corpus, for the cross-repository summary. */
export interface SummaryInput {
  readonly name: string
  readonly runner: string
  readonly lines: readonly ResultLine[]
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

const pct = (v: number): string => (Number.isNaN(v) ? '-' : `${(v * 100).toFixed(1)}%`)

function timeShares(commits: readonly CommitResult[], name: BaselineName): number[] {
  return commits.flatMap((c) => {
    const b = c.baselines?.[name]
    return b && b.selected !== null ? [b.selectedMs / Math.max(1, c.totalMs)] : []
  })
}

/**
 * A Markdown table comparing Veyrum with the Datadog-style baseline and the runner's own changed
 * selection across replayed repositories, with mutant escapes and capture overhead, and the
 * combined escape bound.
 */
export function renderSummary(inputs: readonly SummaryInput[]): string {
  const out: string[] = ['# Veyrum replay summary', '']
  out.push(
    '| Repository | Runner | Commits | Veyrum time run (median / mean) | Datadog-style (median / mean) | Runner changed (median / mean) | Killed mutants + mainline flips | Veyrum escapes | Datadog-style escapes | Capture overhead (median) |',
  )
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  let oraclesTotal = 0
  let escapesTotal = 0
  for (const input of inputs) {
    const commits = input.lines.filter((l): l is CommitResult => l.kind === 'commit' && l.baselines !== null)
    const killed = input.lines.filter(
      (l): l is MutantResult => l.kind === 'mutant' && l.killed.length > 0 && !l.timedOut,
    )
    const flips = commits.reduce((n, c) => n + c.flips.length, 0)
    // Both oracles count in one denominator: a killed mutant escapes when any killing file was
    // skipped, a mainline flip when its file was.
    const escapes = (name: BaselineName): number =>
      killed.filter((m) => (m.baselines[name]?.escapes.length ?? 0) > 0).length +
      commits.reduce((n, c) => n + (c.baselines?.[name]?.escapes.length ?? 0), 0)
    const cell = (name: BaselineName): string => {
      const shares = timeShares(commits, name)
      const mean = shares.length === 0 ? Number.NaN : shares.reduce((a, b) => a + b, 0) / shares.length
      return `${pct(quantile(shares, 0.5))} / ${pct(mean)}`
    }
    const overhead = input.lines
      .filter((l): l is CommitResult => l.kind === 'commit' && l.plainWallMs !== null)
      .map((c) => c.capture.wallMs / c.plainWallMs! - 1)
    const veyrumEscapes = escapes('veyrum')
    oraclesTotal += killed.length + flips
    escapesTotal += veyrumEscapes
    out.push(
      `| ${input.name} | ${input.runner} | ${commits.length} | ${cell('veyrum')} | ${cell('file-coverage')} | ${cell('runner-changed')} | ${killed.length} + ${flips} | ${veyrumEscapes} | ${escapes('file-coverage')} | ${pct(quantile(overhead, 0.5))} |`,
    )
  }
  out.push('')
  out.push(
    `Veyrum escapes across all repositories: ${escapesTotal} of ${oraclesTotal} killed mutants and mainline flips; 95% upper bound on the escape rate ${pct(upperBound95(escapesTotal, oraclesTotal))}.`,
    '',
  )
  return out.join('\n')
}
