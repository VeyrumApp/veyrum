import fs from 'node:fs'
import type { ListedRun } from './protocol.ts'

/** Where `playwright test --list` with this reporter writes what it found. */
export const LIST_ENV = 'VEYRUM_PLAYWRIGHT_LIST'

interface Project {
  readonly name: string
  /** Playwright's internal project id (what workers are told); its name when absent. */
  readonly __projectId?: string
}
interface TestCase {
  readonly location: { readonly file: string }
  readonly parent: { project(): Project | undefined }
}

/**
 * A Playwright reporter for `--list`: the test files of every project, with the project ids that
 * Playwright's workers are told, written as one JSON document.
 */
export default class VeyrumLister {
  private run: { -readonly [K in keyof ListedRun]: ListedRun[K] } = {
    version: '',
    configFile: null,
    projects: [],
    tests: [],
    errors: [],
  }

  printsToStdio(): boolean {
    return false
  }

  onBegin(
    config: { readonly version: string; readonly configFile?: string; readonly projects: readonly Project[] },
    suite: { allTests(): TestCase[] },
  ): void {
    const id = (p: Project): string => p.__projectId ?? p.name
    const seen = new Set<string>()
    const tests: ListedRun['tests'][number][] = []
    for (const test of suite.allTests()) {
      const project = test.parent.project()
      if (!project) continue
      const key = `${id(project)}\u0000${test.location.file}`
      if (seen.has(key)) continue
      seen.add(key)
      tests.push({ file: test.location.file, projectId: id(project), project: project.name })
    }
    this.run = {
      ...this.run,
      version: config.version,
      configFile: config.configFile ?? null,
      projects: config.projects.map((p) => ({ id: id(p), name: p.name })),
      tests,
    }
  }

  onError(error: { readonly message?: string }): void {
    this.run = { ...this.run, errors: [...this.run.errors, error.message ?? 'error'] }
  }

  onEnd(): void {
    const out = process.env[LIST_ENV]
    if (out) fs.writeFileSync(out, JSON.stringify(this.run))
  }
}
