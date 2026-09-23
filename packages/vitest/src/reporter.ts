import type { TestOutcome } from '@veyrum/core'
import type { Reporter, TestModule } from 'vitest/node'

export interface ModuleOutcome {
  /** Absolute path of the test file. */
  readonly moduleId: string
  readonly project: string
  /** Vite environment the file ran in (used to re-transform its modules at plan time). */
  readonly env: string
  readonly state: 'passed' | 'failed' | 'skipped' | 'pending' | 'queued'
  readonly tests: readonly TestOutcome[]
  readonly durationMs: number
  readonly retries: number
}

/** Collects per-file outcomes for evidence records. Prints nothing. */
export class OutcomeReporter implements Reporter {
  readonly outcomes = new Map<string, ModuleOutcome>()

  onTestModuleEnd(module: TestModule): void {
    const tests: TestOutcome[] = []
    let retries = 0
    for (const test of module.children.allTests()) {
      const result = test.result()
      const diagnostic = test.diagnostic()
      retries += diagnostic?.retryCount ?? 0
      tests.push({
        name: test.fullName,
        state: result.state,
        durationMs: diagnostic?.duration ?? 0,
        retries: diagnostic?.retryCount ?? 0,
      })
    }
    this.outcomes.set(`${module.project.name}\u0000${module.moduleId}`, {
      moduleId: module.moduleId,
      project: module.project.name,
      env: module.viteEnvironment?.name ?? 'ssr',
      state: module.state(),
      tests,
      durationMs: module.diagnostic().duration,
      retries,
    })
  }
}
