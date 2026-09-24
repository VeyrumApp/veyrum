import { Session } from 'node:inspector/promises'
import vm from 'node:vm'
import { expect, test } from 'vitest'
import { coverageHub, type ScriptCoverage } from '../src/coverage.ts'

/**
 * Under Veyrum's own capture (the shadow-mode CI run), this worker's coverage already belongs to
 * that capture's hub: these scenarios need a hub of their own.
 */
const captured = Symbol.for('veyrum.coverageHub') in globalThis

/** A function in its own script, so coverage reports it under its own URL. */
const probe = (name: string): (() => number) =>
  vm.runInThisContext(`(function ${name}() { return 1 })`, { filename: `file:///veyrum-probe-${name}.js` })

const executed = (result: readonly ScriptCoverage[]): string[] =>
  [
    ...new Set(
      result
        .filter((s) => s.url.startsWith('file:///veyrum-probe-'))
        .filter((s) => s.functions.some((f) => (f.ranges[0]?.count ?? 0) > 0))
        .map((s) => s.url.slice('file:///veyrum-probe-'.length, -'.js'.length)),
    ),
  ].sort()

/** A project's own coverage session, stopped and disconnected afterwards whatever happens. */
async function withProjectSession(capture: object, fn: (project: Session) => Promise<void>): Promise<void> {
  const project = new Session()
  project.connect()
  try {
    await fn(project)
  } finally {
    await project.post('Profiler.stopPreciseCoverage')
    await coverageHub().release(capture)
    project.disconnect()
  }
}

test.skipIf(captured)(
  "a project's own coverage session and capture each see every execution since their last take",
  async () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(probe) as [
      () => number,
      () => number,
      () => number,
      () => number,
    ]
    const hub = coverageHub()
    const capture = {}
    // As capture does when the project collects coverage: in its mode from the start.
    await hub.acquire(capture, { callCount: true, detailed: true })
    await withProjectSession(capture, async (project) => {
      await project.post('Profiler.enable')
      await project.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
      a()
      expect(executed(await hub.take(capture))).toEqual(['a'])
      b()
      const projectTake = (await project.post('Profiler.takePreciseCoverage')) as { result: ScriptCoverage[] }
      expect(executed(projectTake.result)).toEqual(['a', 'b'])
      c()
      // Stopping the project's coverage leaves capture's running.
      await project.post('Profiler.stopPreciseCoverage')
      d()
      expect(executed(await hub.take(capture))).toEqual(['b', 'c', 'd'])
      expect(hub.disturbed(capture)).toBe(false)
    })
  },
)

test.skipIf(captured)(
  'a mode change under a consumer is reported to it: V8 stops reporting older functions',
  async () => {
    const hub = coverageHub()
    const capture = {}
    await hub.acquire(capture, { callCount: false, detailed: false })
    await withProjectSession(capture, async (project) => {
      await project.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
      expect(hub.disturbed(capture)).toBe(true)
      expect(hub.disturbed(capture)).toBe(false)
    })
  },
)
