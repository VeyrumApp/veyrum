import type { CheckOutcome } from '@veyrum/capture/assemble'
import type { TestOutcome } from '@veyrum/core'
import type { Reporter, TestModule } from 'vitest/node'

/** Collects per-file outcomes for evidence records. Prints nothing. */
export class OutcomeReporter implements Reporter {
  readonly outcomes = new Map<string, CheckOutcome>()

  onTestModuleEnd(module: TestModule): void {
    const tests: TestOutcome[] = []
    let retries = 0
    let failure: string | undefined
    const describe = (error: { message?: string } | undefined): string =>
      (error?.message ?? '').split('\n')[0] ?? ''
    for (const error of module.errors()) failure ??= `(file): ${describe(error)}`
    for (const test of module.children.allTests()) {
      const result = test.result()
      if (result.state === 'failed') failure ??= `${test.fullName}: ${describe(result.errors?.[0])}`
      const diagnostic = test.diagnostic()
      retries += diagnostic?.retryCount ?? 0
      tests.push({
        name: test.fullName,
        state: result.state,
        durationMs: diagnostic?.duration ?? 0,
        retries: diagnostic?.retryCount ?? 0,
      })
    }
    const state = module.state()
    this.outcomes.set(`${module.project.name}\u0000${module.moduleId}`, {
      file: module.moduleId,
      project: module.project.name,
      // The Vite environment the file ran in.
      env: module.viteEnvironment?.name ?? 'ssr',
      verdict: state === 'passed' || state === 'skipped' ? 'pass' : 'fail',
      tests,
      durationMs: module.diagnostic().duration,
      retries,
      ...(state === 'failed' && failure ? { failure: failure.slice(0, 400) } : {}),
    })
  }
}
