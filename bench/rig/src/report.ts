import fs from 'node:fs'
import {
  BASELINES,
  type BaselineName,
  type BrokenResult,
  type CommitResult,
  type MutantResult,
  type ResultLine,
} from './replay.ts'

export function readLines(file: string): ResultLine[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l.replaceAll('"vitest-changed":', '"runner-changed":')) as ResultLine)
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

function binomialCdf(x: number, n: number, p: number): number {
  let sum = 0
  let term = (1 - p) ** n
  for (let k = 0; k <= x; k++) {
    sum += term
    term *= ((n - k) / (k + 1)) * (p / (1 - p))
  }
  return sum
}

/** One-sided 95% Clopper-Pearson upper bound on a rate after x events in n trials. */
export function upperBound95(x: number, n: number): number {
  if (n === 0) return 1
  if (x >= n) return 1
  let lo = x / n
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (binomialCdf(x, n, mid) > 0.05) lo = mid
    else hi = mid
  }
  return hi
}

const pct = (v: number): string => (Number.isNaN(v) ? '-' : `${(v * 100).toFixed(1)}%`)
const ms = (v: number): string =>
  Number.isNaN(v) ? '-' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`

/** Classifies a commit by what it touched. */
export function changeType(changed: readonly string[]): string {
  if (changed.length === 0) return 'empty'
  const kinds = new Set<string>()
  for (const f of changed) {
    if (/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/.test(f))
      kinds.add('dependencies')
    else if (/\.(md|mdx|txt|png|jpe?g|gif|svg)$|(^|\/)(LICENSE|CHANGELOG[^/]*)$/i.test(f)) kinds.add('docs')
    else if (/(^|\/)\.github\//.test(f)) kinds.add('ci')
    else if (/(__tests__|\.test\.|\.spec\.|(^|\/)tests?\/)/.test(f)) kinds.add('tests')
    else if (/\.[cm]?[jt]sx?$|\.vue$/.test(f)) kinds.add('source')
    else kinds.add('config')
  }
  if (kinds.has('dependencies')) return 'dependencies'
  if (kinds.has('config')) return 'config'
  if (kinds.has('source')) return kinds.has('tests') ? 'source+tests' : 'source'
  if (kinds.has('tests')) return 'tests'
  return [...kinds].sort().join('+')
}

interface Row {
  name: BaselineName
  medianFiles: number
  p90Files: number
  medianTime: number
  meanTime: number
  escapes: number
  missedFailing: number
  mutantEscapes: number
}

export function renderReport(title: string, lines: readonly ResultLine[]): string {
  const commits = lines
    .filter((l): l is CommitResult => l.kind === 'commit' && l.baselines !== null)
    .sort((a, b) => a.index - b.index)
  const mutants = lines.filter((l): l is MutantResult => l.kind === 'mutant')
  const killed = mutants.filter((m) => m.killed.length > 0 && !m.timedOut)
  const flips = commits.reduce((n, c) => n + c.flips.length, 0)

  const rows: Row[] = BASELINES.map((name) => {
    const fileRatios: number[] = []
    const timeRatios: number[] = []
    let escapes = 0
    let missedFailing = 0
    for (const c of commits) {
      const b = c.baselines?.[name]
      if (!b || b.selected === null) continue
      fileRatios.push(b.selected.length / Math.max(1, c.testFiles))
      timeRatios.push(b.selectedMs / Math.max(1, c.totalMs))
      escapes += b.escapes.length
      missedFailing += b.missedFailing.length
    }
    const mutantEscapes = killed.filter((m) => (m.baselines[name]?.escapes.length ?? 0) > 0).length
    return {
      name,
      medianFiles: quantile(fileRatios, 0.5),
      p90Files: quantile(fileRatios, 0.9),
      medianTime: quantile(timeRatios, 0.5),
      meanTime: timeRatios.reduce((a, b) => a + b, 0) / Math.max(1, timeRatios.length),
      escapes,
      missedFailing,
      mutantEscapes,
    }
  })

  const out: string[] = []
  out.push(`# ${title}`, '')
  out.push(
    `${commits.length} replayed commits, ${flips} outcome flips on the mainline, ${mutants.length} mutants (${killed.length} killed by at least one test file).`,
    '',
  )
  const broken = lines.filter((l): l is BrokenResult => l.kind === 'broken')
  if (broken.length > 0) {
    out.push(`${broken.length} commit(s) could not be replayed and are not scored:`, '')
    for (const b of broken) out.push(`- ${b.sha.slice(0, 10)}: ${b.error.split('\n')[0]}`)
    out.push('')
  }
  out.push('## Selection and safety', '')
  out.push(
    '| Selector | Files run (median) | Files run (p90) | Test time run (median) | Test time run (mean) | Mainline escapes | Missed failing | Mutant escapes |',
  )
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of rows) {
    out.push(
      `| ${r.name} | ${pct(r.medianFiles)} | ${pct(r.p90Files)} | ${pct(r.medianTime)} | ${pct(r.meanTime)} | ${r.escapes} / ${flips} | ${r.missedFailing} | ${r.mutantEscapes} / ${killed.length} |`,
    )
  }
  out.push('')
  const veyrum = rows.find((r) => r.name === 'veyrum')!
  out.push(
    `Veyrum mutant escape rate: ${veyrum.mutantEscapes} of ${killed.length}; 95% upper bound ${pct(upperBound95(veyrum.mutantEscapes, killed.length))}.`,
    '',
  )

  out.push('## Selection by change type (median share of test time run)', '')
  const types = new Map<string, CommitResult[]>()
  for (const c of commits) {
    const t = changeType(c.changed)
    const list = types.get(t)
    if (list) list.push(c)
    else types.set(t, [c])
  }
  out.push(`| Change type | Commits | ${BASELINES.join(' | ')} |`)
  out.push(`| --- | --- | ${BASELINES.map(() => '---').join(' | ')} |`)
  for (const [t, list] of [...types].sort((a, b) => b[1].length - a[1].length)) {
    const cells = BASELINES.map((name) =>
      pct(
        quantile(
          list.flatMap((c) => {
            const b = c.baselines?.[name]
            return b && b.selected !== null ? [b.selectedMs / Math.max(1, c.totalMs)] : []
          }),
          0.5,
        ),
      ),
    )
    out.push(`| ${t} | ${list.length} | ${cells.join(' | ')} |`)
  }
  out.push('')

  out.push('## Per commit (share of test time run)', '')
  const perCommit = BASELINES.filter((name) => name !== 'all')
  out.push(`| # | Commit | Change | Files changed | Veyrum files | ${perCommit.join(' | ')} |`)
  out.push(`| --- | --- | --- | --- | --- | ${perCommit.map(() => '---').join(' | ')} |`)
  for (const c of commits) {
    const veyrumFiles = c.baselines?.veyrum?.selected
    const cells = perCommit.map((name) => {
      const b = c.baselines?.[name]
      return b && b.selected !== null ? pct(b.selectedMs / Math.max(1, c.totalMs)) : '-'
    })
    out.push(
      `| ${c.index} | ${c.sha.slice(0, 7)} | ${changeType(c.changed)} | ${c.changed.length} | ${veyrumFiles ? `${veyrumFiles.length} / ${c.testFiles}` : '-'} | ${cells.join(' | ')} |`,
    )
  }
  out.push('')

  if (killed.length > 0) {
    out.push('## Mutants', '')
    out.push(`| Selector | Mutant escapes | Median files selected |`)
    out.push('| --- | --- | --- |')
    for (const name of BASELINES) {
      const sel = killed.map((m) => m.baselines[name]?.selected ?? Number.NaN).filter((v) => !Number.isNaN(v))
      out.push(
        `| ${name} | ${killed.filter((m) => (m.baselines[name]?.escapes.length ?? 0) > 0).length} | ${quantile(sel, 0.5)} |`,
      )
    }
    out.push('')
    const veyrumEscapes = killed.filter((m) => (m.baselines.veyrum?.escapes.length ?? 0) > 0)
    if (veyrumEscapes.length > 0) {
      out.push('Veyrum escapes (each needs a root cause):', '')
      for (const m of veyrumEscapes) {
        out.push(
          `- ${m.sha.slice(0, 10)} ${m.mutant.file}:${m.mutant.line} ${m.mutant.kind}: missed ${m.baselines.veyrum?.escapes.join(', ')}`,
        )
      }
      out.push('')
    }
  }

  out.push('## Cost', '')
  const planMs = commits.map((c) => c.veyrumPlanMs ?? Number.NaN).filter((v) => !Number.isNaN(v))
  const recordMs = commits.map((c) => c.capture.recordMs)
  const paired = lines.filter((l): l is CommitResult => l.kind === 'commit' && l.plainWallMs !== null)
  const overhead = paired.map((c) => c.capture.wallMs / c.plainWallMs! - 1)
  out.push(`| Measure | Median | p90 |`)
  out.push('| --- | --- | --- |')
  out.push(`| Veyrum plan time | ${ms(quantile(planMs, 0.5))} | ${ms(quantile(planMs, 0.9))} |`)
  out.push(`| Evidence recording time | ${ms(quantile(recordMs, 0.5))} | ${ms(quantile(recordMs, 0.9))} |`)
  out.push(
    `| Capture overhead (full run wall time vs uninstrumented, ${paired.length} pairs) | ${pct(quantile(overhead, 0.5))} | ${pct(quantile(overhead, 0.9))} |`,
  )
  out.push('')
  return out.join('\n')
}
