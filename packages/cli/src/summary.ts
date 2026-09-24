import type { Decision, RunMode, RunResult, Shard } from '@veyrum/core'

/** Options that change what a run did, as far as the summary needs to say. */
export interface SummaryContext {
  readonly mode: RunMode
  /** A full run that also planned, to measure what reuse would have done (shadow mode). */
  readonly audit: boolean
  /** The share of the test files this job covered, when the run was split across jobs. */
  readonly shard?: Shard
}

const REASON_TEXT: Record<Decision['reason'], string> = {
  reused: 'evidence reused',
  forced: 'full run requested',
  'no-evidence': 'no evidence yet (new file, or last run failed)',
  'not-reusable': 'last pass was not evidence (retried, wrote a snapshot, or capture incomplete)',
  'blocked-flag': 'uses a channel Veyrum does not observe (network, child process, shared worker)',
  'runtime-changed': 'Node, platform, runner or locale changed',
  'shared-inputs-changed': 'runner configuration or toolchain changed',
  'inputs-changed': 'code or inputs it used changed',
}

function duration(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.round((ms % 60_000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((100 * part) / whole)}%` : '0%'
}

/**
 * A Markdown report of one run, for a CI job summary. It states what ran, what was reused and how
 * much recorded test time that covers, why files ran, and every reuse decision that was checked by
 * running the file anyway, naming any that would have been wrong.
 */
export function markdownSummary(result: RunResult, context: SummaryContext): string {
  const decisions = result.decisions
  const reusable = decisions.filter((d) => d.action === 'skip')
  const mustRun = decisions.filter((d) => d.action === 'run')
  const reusableMs = reusable.reduce((sum, d) => sum + d.durationMs, 0)
  const mustRunMs = mustRun.reduce((sum, d) => sum + d.durationMs, 0)
  const totalMs = reusableMs + mustRunMs
  const shadow = context.mode === 'full' && context.audit
  const out: string[] = [
    context.shard ? `## Veyrum (shard ${context.shard.index}/${context.shard.count})` : '## Veyrum',
    '',
  ]

  if (shadow) {
    out.push(
      `Shadow mode: every test file ran. Veyrum would have reused evidence for **${reusable.length} of ${decisions.length}** test files, **${percent(reusableMs, totalMs)}** of recorded test time (${duration(reusableMs)}).`,
    )
  } else if (context.mode === 'full') {
    const recorded = result.outcomes.filter((o) => o.captured).length
    out.push(
      `Full run: every test file ran (${decisions.length} test files). Evidence was recorded for **${recorded}**; the other ${result.outcomes.length - recorded} already had valid evidence.`,
    )
  } else {
    const verb = context.mode === 'plan' ? 'would run' : 'ran'
    out.push(
      `${decisions.length} test files: ${verb} **${mustRun.length}**, reused evidence for **${reusable.length}**, covering **${percent(reusableMs, totalMs)}** of recorded test time (${duration(reusableMs)}).`,
    )
  }
  out.push('')

  if (context.mode !== 'full' || shadow) {
    const byReason = new Map<Decision['reason'], number>()
    for (const d of mustRun) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1)
    if (byReason.size > 0) {
      out.push('| Why test files ran | Files |', '| --- | --- |')
      for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1]))
        out.push(`| ${REASON_TEXT[reason]} | ${count} |`)
      out.push('')
    }
  }

  const checked = result.verifications
  if (checked.length > 0) {
    const escapes = checked.filter((v) => v.outcome === 'fail')
    const kind = checked[0]?.kind === 'audit' ? 'audit' : 'canaries'
    out.push(
      `Safety (${kind}): ${checked.length} reuse decisions were checked by running the files anyway; **${escapes.length}** would have been wrong.`,
    )
    for (const e of escapes)
      out.push(
        `- Escape: \`${e.check.path}\`${e.check.project ? ` (${e.check.project})` : ''} was reusable but fails.`,
      )
    out.push('')
  }

  const failed = result.outcomes.filter((o) => o.verdict === 'fail')
  if (failed.length > 0) {
    out.push(`Failing test files (${failed.length}):`)
    for (const o of failed.slice(0, 20)) out.push(`- \`${o.check.path}\``)
    if (failed.length > 20) out.push(`- and ${failed.length - 20} more`)
    out.push('')
  }
  const { planMs, runMs, recordMs } = result.timings
  out.push(`Plan ${duration(planMs)}, run ${duration(runMs)}, record ${duration(recordMs)}.`)
  return `${out.join('\n')}\n`
}
