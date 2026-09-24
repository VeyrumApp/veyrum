import fs from 'node:fs'
import path from 'node:path'
import {
  CONFIG_ENV,
  type PlaywrightCaptureConfig,
  type ReportedFile,
  type ReportedRun,
  SCRATCH,
  TESTS_LOADED,
} from './protocol.ts'

/** The parts of Playwright's reporter API this uses. */
interface TestCase {
  readonly location: { readonly file: string }
  readonly results: readonly { readonly status: string; readonly duration: number }[]
  titlePath(): string[]
  outcome(): string
  readonly parent: { project(): { readonly name: string } | undefined }
}
interface Suite {
  allTests(): TestCase[]
}

/**
 * A Playwright reporter that writes each file's result, per project, as one JSON document into the
 * run's scratch directory. A test's state is its final outcome: flaky tests passed after retries.
 */
export default class VeyrumReporter {
  private suite: Suite | undefined
  private errors = 0

  printsToStdio(): boolean {
    return false
  }

  onBegin(_config: unknown, suite: Suite): void {
    this.suite = suite
    const loaded = (globalThis as Record<symbol, unknown>)[TESTS_LOADED]
    if (typeof loaded === 'function') loaded()
  }

  onError(): void {
    this.errors++
  }

  onEnd(result: { readonly status: string }): void {
    const raw = process.env[CONFIG_ENV]
    if (!raw) return
    const config = JSON.parse(raw) as PlaywrightCaptureConfig
    const files = new Map<string, { -readonly [K in keyof ReportedFile]: ReportedFile[K] }>()
    for (const test of this.suite?.allTests() ?? []) {
      const project = test.parent.project()?.name ?? ''
      const key = `${project}\u0000${test.location.file}`
      let entry = files.get(key)
      if (!entry) {
        entry = { file: test.location.file, project, durationMs: 0, tests: [] }
        files.set(key, entry)
      }
      const outcome = test.results.length === 0 ? 'notrun' : test.outcome()
      const durationMs = test.results.reduce((sum, r) => sum + r.duration, 0)
      entry.durationMs += durationMs
      entry.tests = [
        ...entry.tests,
        {
          name: test.titlePath().slice(3).join(' > '),
          state:
            outcome === 'skipped'
              ? 'skipped'
              : outcome === 'expected' || outcome === 'flaky'
                ? 'passed'
                : outcome === 'notrun'
                  ? 'pending'
                  : 'failed',
          durationMs,
          retries: Math.max(0, test.results.length - 1),
          outcome,
        },
      ]
    }
    const report: ReportedRun = { status: result.status, errors: this.errors, files: [...files.values()] }
    fs.writeFileSync(path.join(config.scratch, SCRATCH.outcomes), JSON.stringify(report))
  }
}
