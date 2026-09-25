import type { BaselineName, CommitResult, MutantResult, ResultLine } from './replay.ts'
import { changeType, hermeticShare, hermeticShares, upperBound95 } from './report.ts'

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
    '| Repository | Runner | Commits (unreplayable) | Veyrum time run (median / mean) | Datadog-style (median / mean) | Hermetic tests: Veyrum / Datadog-style (mean) | Runner changed (median / mean) | Killed mutants + mainline flips | Veyrum escapes | Datadog-style escapes | Verdicts capture changed | Capture overhead (median) |',
  )
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
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
    const hermetic = (name: BaselineName): string => {
      const shares = hermeticShares(commits, name)
      return pct(shares.length === 0 ? Number.NaN : shares.reduce((a, b) => a + b, 0) / shares.length)
    }
    const overhead = input.lines
      .filter((l): l is CommitResult => l.kind === 'commit' && l.plainWallMs !== null)
      .map((c) => c.capture.wallMs / c.plainWallMs! - 1)
    const brokenCommits = input.lines.filter((l) => l.kind === 'broken').length
    const veyrumEscapes = escapes('veyrum')
    const divergent = commits.reduce((n, c) => n + (c.divergent?.length ?? 0), 0)
    oraclesTotal += killed.length + flips
    escapesTotal += veyrumEscapes
    out.push(
      `| ${input.name} | ${input.runner} | ${commits.length}${brokenCommits > 0 ? ` (${brokenCommits})` : ''} | ${cell('veyrum')} | ${cell('file-coverage')} | ${hermetic('veyrum')} / ${hermetic('file-coverage')} | ${cell('runner-changed')} | ${killed.length} + ${flips} | ${veyrumEscapes} | ${escapes('file-coverage')} | ${divergent} | ${pct(quantile(overhead, 0.5))} |`,
    )
  }
  out.push('')
  out.push(
    `Veyrum escapes across all repositories: ${escapesTotal} of ${oraclesTotal} killed mutants and mainline flips; 95% upper bound on the escape rate ${pct(upperBound95(escapesTotal, oraclesTotal))}.`,
    '',
  )
  out.push(...renderGate(inputs, escapesTotal, oraclesTotal))
  return out.join('\n')
}

/** The plan's final gate (section 37), per repository and overall. */
const GATE = {
  oracles: 1500,
  escapeBound: 0.0025,
  ratioVsCoverage: 0.65,
  ratioVsClosure: 1 / 1.2,
  reposPassingRatio: 4,
  sourceMedian: 0.3,
  dependencyMedian: 0.6,
  overhead: 0.15,
} as const

function renderGate(inputs: readonly SummaryInput[], escapes: number, oracles: number): string[] {
  const mark = (ok: boolean): string => (ok ? 'pass' : 'FAIL')
  const out = ['## Release gate (plan section 37)', '']
  out.push(
    'Shares are of hermetic test time (files that used the internet or untraced programs run under any sound selector), median over the commits of each kind. Source commits change only source and test files.',
    '',
  )
  out.push(
    '| Repository | Source commits | Veyrum | File-coverage | Ratio | File-coverage escapes | File-closure | Ratio | Dependency commits | Veyrum on them | Capture overhead |',
  )
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  let ratioPasses = 0
  let closurePasses = 0
  let sourcePasses = 0
  let dependencyPasses = 0
  let overheadPasses = 0
  for (const input of inputs) {
    const commits = input.lines.filter((l): l is CommitResult => l.kind === 'commit' && l.baselines !== null)
    const median = (list: readonly CommitResult[], name: BaselineName): number =>
      quantile(
        list.flatMap((c) => {
          const s = hermeticShare(c, name)
          return s === null ? [] : [s]
        }),
        0.5,
      )
    const source = commits.filter((c) => ['source', 'tests', 'source+tests'].includes(changeType(c.changed)))
    const dependency = commits.filter((c) => changeType(c.changed) === 'dependencies')
    const v = median(source, 'veyrum')
    const fc = median(source, 'file-coverage')
    const closure = median(commits, 'file-closure')
    const ratioOf = (base: number, own: number): number =>
      base > 0 ? own / base : own === 0 ? 0 : Number.POSITIVE_INFINITY
    const ratio = ratioOf(fc, v)
    // A1 against A0 (plan section 37): Veyrum against whole-file closure identity, over every commit.
    const closureRatio = ratioOf(closure, median(commits, 'veyrum'))
    const killed = input.lines.filter(
      (l): l is MutantResult => l.kind === 'mutant' && l.killed.length > 0 && !l.timedOut,
    )
    const fcEscapes =
      killed.filter((m) => (m.baselines['file-coverage']?.escapes.length ?? 0) > 0).length +
      commits.reduce((n, c) => n + (c.baselines?.['file-coverage']?.escapes.length ?? 0), 0)
    if (commits.length > 0 && closureRatio <= GATE.ratioVsClosure) closurePasses++
    const dep = median(dependency, 'veyrum')
    const overhead = quantile(
      input.lines
        .filter((l): l is CommitResult => l.kind === 'commit' && l.plainWallMs !== null)
        .map((c) => c.capture.wallMs / c.plainWallMs! - 1),
      0.5,
    )
    const ratioOk = source.length > 0 && ratio <= GATE.ratioVsCoverage
    if (ratioOk) ratioPasses++
    if (source.length > 0 && v <= GATE.sourceMedian) sourcePasses++
    if (dependency.length === 0 || dep <= GATE.dependencyMedian) dependencyPasses++
    if (!Number.isNaN(overhead) && overhead <= GATE.overhead) overheadPasses++
    const ratioCell = (r: number): string => (Number.isFinite(r) ? `${r.toFixed(2)}x` : '-')
    out.push(
      `| ${input.name} | ${source.length} | ${pct(v)} | ${pct(fc)} | ${ratioCell(ratio)} | ${fcEscapes} | ${pct(closure)} | ${ratioCell(closureRatio)} | ${dependency.length} | ${pct(dep)} | ${pct(overhead)} |`,
    )
  }
  const bound = upperBound95(escapes, oracles)
  out.push('')
  out.push(
    `- Escapes: ${escapes} over ${oracles} oracles (gate: 0 over at least ${GATE.oracles}), 95% bound ${(bound * 100).toFixed(2)}% (gate: at most ${(GATE.escapeBound * 100).toFixed(2)}%): ${mark(escapes === 0 && oracles >= GATE.oracles && bound <= GATE.escapeBound)}`,
    `- Ratio to file-coverage on source commits at most ${GATE.ratioVsCoverage}x: ${ratioPasses} of ${inputs.length} repositories (gate: at least ${GATE.reposPassingRatio}): ${mark(ratioPasses >= GATE.reposPassingRatio)}`,
    `- Veyrum at least 1.2x better than file-closure identity (median, all commits): ${closurePasses} of ${inputs.length} repositories (gate: at least 4): ${mark(closurePasses >= GATE.reposPassingRatio)}`,
    `- Veyrum median on source commits at most ${pct(GATE.sourceMedian)}: ${sourcePasses} of ${inputs.length} repositories`,
    `- Veyrum median on dependency commits at most ${pct(GATE.dependencyMedian)}: ${dependencyPasses} of ${inputs.length} repositories`,
    `- Capture overhead at most ${pct(GATE.overhead)}: ${overheadPasses} of ${inputs.length} repositories`,
    '',
  )
  return out
}
