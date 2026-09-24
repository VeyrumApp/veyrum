import type { ReportedFile } from './protocol.ts'

type ReporterClass = new (runner: MochaRunner, options?: unknown) => object

/** The parts of Mocha's module (lib/mocha.js) Veyrum uses. */
export interface MochaExports {
  readonly reporters: Record<string, ReporterClass> & {
    readonly Base: ReporterClass
    readonly Spec: ReporterClass
  }
}

interface MochaRunnable {
  readonly type?: string
  readonly duration?: number
  fullTitle(): string
  currentRetry?(): number
}

interface MochaRunner {
  on(event: string, listener: (runnable: MochaRunnable) => void): unknown
  once(event: string, listener: () => void): unknown
}

/** The name the process registers its reporter under among Mocha's own. */
export const REPORTER_NAME = 'veyrum'

/**
 * A Mocha reporter for the file this process runs: its verdict, duration and tests, handed to
 * `done` when the run ends. The file fails when a test or hook fails; its duration is the run's.
 * With `print`, it is Mocha's spec reporter too.
 */
export function createReporter(
  mocha: MochaExports,
  print: boolean,
  done: (report: ReportedFile) => void,
): ReporterClass {
  const Parent = print ? mocha.reporters.Spec : mocha.reporters.Base
  return class VeyrumReporter extends Parent {
    constructor(runner: MochaRunner, options?: unknown) {
      super(runner, options)
      let started = performance.now()
      let verdict: ReportedFile['verdict'] = 'pass'
      const tests: ReportedFile['tests'][number][] = []
      const add = (test: MochaRunnable, state: ReportedFile['tests'][number]['state']): void => {
        tests.push({
          name: test.fullTitle(),
          state,
          durationMs: test.duration ?? 0,
          retries: test.currentRetry?.() ?? 0,
        })
      }
      runner.once('start', () => {
        started = performance.now()
      })
      runner.on('pass', (test) => add(test, 'passed'))
      runner.on('pending', (test) => add(test, 'pending'))
      runner.on('fail', (runnable) => {
        verdict = 'fail'
        if (runnable.type === 'test') add(runnable, 'failed')
      })
      runner.once('end', () => done({ verdict, durationMs: performance.now() - started, tests }))
    }
  }
}
