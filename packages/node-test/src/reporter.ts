import type { ReportedFile } from './protocol.ts'

interface TestEventData {
  readonly name: string
  readonly nesting: number
  readonly file?: string
  readonly skip?: boolean | string
  readonly todo?: boolean | string
  readonly details?: { readonly duration_ms?: number; readonly type?: string }
}

/**
 * A node:test reporter (--test-reporter) that reports each test file's verdict, duration and tests
 * as one JSON document. A file fails when any of its tests fails (a failing todo test does not
 * fail the run); its duration is the sum of its top-level tests' durations.
 */
export default async function* veyrumReporter(
  source: AsyncIterable<{ readonly type: string; readonly data: TestEventData }>,
): AsyncGenerator<string> {
  const files = new Map<
    string,
    { verdict: 'pass' | 'fail'; durationMs: number; tests: ReportedFile['tests'][number][] }
  >()
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const data = event.data
    if (!data.file) continue
    let entry = files.get(data.file)
    if (!entry) {
      entry = { verdict: 'pass', durationMs: 0, tests: [] }
      files.set(data.file, entry)
    }
    const failed = event.type === 'test:fail' && !data.todo
    if (failed) entry.verdict = 'fail'
    const durationMs = data.details?.duration_ms ?? 0
    if (data.nesting === 0) entry.durationMs += durationMs
    if (data.details?.type !== 'suite')
      entry.tests.push({
        name: data.name,
        state: data.todo ? 'pending' : data.skip ? 'skipped' : failed ? 'failed' : 'passed',
        durationMs,
        retries: 0,
      })
  }
  const report: ReportedFile[] = [...files].map(([file, e]) => ({ file, ...e }))
  yield JSON.stringify(report)
}
