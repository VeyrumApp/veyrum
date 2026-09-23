import type { CheckOutcome } from '@veyrum/capture/assemble'
import type { TestOutcome } from '@veyrum/core'
import { SESSION_KEY } from './protocol.ts'

/** Shared between the orchestrator and the reporter Jest instantiates in the same process. */
export interface ReporterSession {
  /** Veyrum project name by Jest project config id. */
  readonly projectNames: ReadonlyMap<string, string>
  readonly outcomes: Map<string, CheckOutcome>
}

export function openSession(projectNames: ReadonlyMap<string, string>): ReporterSession {
  const session: ReporterSession = { projectNames, outcomes: new Map() }
  ;(globalThis as Record<symbol, unknown>)[SESSION_KEY] = session
  return session
}

export function closeSession(): void {
  delete (globalThis as Record<symbol, unknown>)[SESSION_KEY]
}

interface AssertionLike {
  fullName: string
  status: string
  duration?: number | null
  invocations?: number
  retryReasons?: unknown[]
}

interface TestResultLike {
  testFilePath: string
  numFailingTests: number
  testExecError?: unknown
  failureMessage?: string | null
  perfStats: { start: number; end: number; runtime: number }
  snapshot: { added: number; updated: number; fileDeleted: boolean }
  testResults: AssertionLike[]
}

interface TestLike {
  context: { config: { id: string } }
}

function stateOf(status: string): TestOutcome['state'] {
  if (status === 'passed' || status === 'failed') return status
  if (status === 'todo') return 'pending'
  return 'skipped'
}

/** Collects per-file outcomes for evidence records. Prints nothing. Jest loads it by path. */
export default class OutcomeReporter {
  onTestResult(test: TestLike, result: TestResultLike): void {
    const session = (globalThis as Record<symbol, ReporterSession | undefined>)[SESSION_KEY]
    if (!session) return
    const project = session.projectNames.get(test.context.config.id) ?? ''
    const tests: TestOutcome[] = []
    let retries = 0
    for (const a of result.testResults) {
      const attempts = Math.max(a.invocations ?? 1, (a.retryReasons?.length ?? 0) + 1)
      retries += attempts - 1
      tests.push({
        name: a.fullName,
        state: stateOf(a.status),
        durationMs: a.duration ?? 0,
        retries: attempts - 1,
      })
    }
    const failed = result.numFailingTests > 0 || result.testExecError != null
    session.outcomes.set(`${project}\u0000${result.testFilePath}`, {
      file: result.testFilePath,
      project,
      env: 'jest',
      verdict: failed ? 'fail' : 'pass',
      tests,
      durationMs: result.perfStats.runtime ?? result.perfStats.end - result.perfStats.start,
      retries,
      snapshot: {
        added: result.snapshot.added,
        updated: result.snapshot.updated + (result.snapshot.fileDeleted ? 1 : 0),
      },
    })
  }

  getLastError(): undefined {
    return undefined
  }
}
