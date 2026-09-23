import fs from 'node:fs'
import path from 'node:path'
import { type CheckRef, Store } from '@veyrum/core'
import { selectFileCoverage } from './baselines.ts'
import type { Corpus } from './corpus.ts'
import { type CommitResult, type MutantResult, pathsFor, type ResultLine, readResults } from './replay.ts'

/**
 * Recomputes the Datadog-style baseline of a finished replay from its evidence store and git
 * history, without running any test. Each commit is scored with evidence from earlier commits
 * only; each mutant with evidence up to and including its commit, as the replay planned it. The
 * previous results are kept next to the new ones.
 */
export function rescoreFileCoverage(corpus: Corpus, benchRoot: string): { commits: number; mutants: number } {
  const paths = pathsFor(corpus, benchRoot)
  const lines = readResults(paths.results)
  const store = Store.open(paths.store)
  try {
    const commitLines = lines.filter((l): l is CommitResult => l.kind === 'commit')
    const indexOf = new Map(commitLines.map((l) => [l.sha, l.index]))
    const checksByPath = new Map<string, CheckRef[]>()
    for (const c of store.checks()) {
      const list = checksByPath.get(c.path)
      if (list) list.push(c)
      else checksByPath.set(c.path, [c])
    }
    const toTestRoot = (f: string): string =>
      path.relative(paths.testRoot, path.join(paths.repo, f)).split(path.sep).join('/')
    const lockfiles = corpus.lockfiles.map(toTestRoot)
    const select = (at: CommitResult, upTo: number, alsoChanged: readonly string[]): Set<string> => {
      const checks = Object.keys(at.outcomes).flatMap((p) => checksByPath.get(p) ?? [])
      return selectFileCoverage(
        { repo: paths.testRoot, store, checks, changed: [], lockfileChanged: false, lockfiles },
        {
          against: at.sha,
          alsoChanged,
          eligible: (r) => r.revision !== null && (indexOf.get(r.revision) ?? Infinity) <= upTo,
        },
      )
    }
    const durationOf = (at: CommitResult, files: Iterable<string>): number => {
      let total = 0
      for (const f of files) total += at.outcomes[f]?.[1] ?? 0
      return total
    }
    let commits = 0
    let mutants = 0
    const out: ResultLine[] = lines.map((line) => {
      if (line.kind === 'commit') {
        if (!line.baselines) return line
        const sel = select(line, line.index - 1, [])
        const failing = Object.entries(line.outcomes)
          .filter(([, o]) => o[0] === 'fail')
          .map(([f]) => f)
        commits++
        return {
          ...line,
          baselines: {
            ...line.baselines,
            'file-coverage': {
              selected: [...sel].sort(),
              selectedMs: durationOf(line, sel),
              escapes: line.flips.filter((f) => !sel.has(f)),
              missedFailing: failing.filter((f) => !sel.has(f)),
            },
          },
        }
      }
      const at = commitLines.find((c) => c.sha === line.sha)
      if (!at) return line
      const sel = select(at, at.index, [toTestRoot(line.mutant.file)])
      mutants++
      const rescored: MutantResult = {
        ...line,
        baselines: {
          ...line.baselines,
          'file-coverage': {
            selected: sel.size,
            selectedMs: durationOf(at, sel),
            escapes: line.killed.filter((f) => !sel.has(f)),
          },
        },
      }
      return rescored
    })
    fs.copyFileSync(paths.results, `${paths.results}.before-rescore`)
    fs.writeFileSync(paths.results, `${out.map((l) => JSON.stringify(l)).join('\n')}\n`)
    return { commits, mutants }
  } finally {
    store.close()
  }
}
