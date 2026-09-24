import fs from 'node:fs'
import Module from 'node:module'
import path from 'node:path'
import { unobserved, VOLATILE_ENV } from '@veyrum/capture'
import {
  beginWorkerCapture,
  prepareWorkerHooks,
  uncapturedFiles,
  type WorkerCaptureOptions,
} from '@veyrum/capture/worker'
import { loadMochaOptions, mochaModule, splitNodeFlags } from './mocha.ts'
import { MOCHA_CHILD_ENV, type MochaChildConfig, type ReportedFile } from './protocol.ts'
import { createReporter, type MochaExports, REPORTER_NAME } from './reporter.ts'

/**
 * The process that runs one test file: Mocha's own command line, as its executable runs it in
 * process, with the project's options and the file as its only spec. Capture begins before Mocha
 * reads its configuration and the file loads, and the payload is written once the process has
 * nothing left to do (beforeExit), after every test and everything they left running; with --exit,
 * Mocha's own exit after the run waits for it. A process that exits before the run ends writes no
 * report, and its file fails.
 */
const raw = process.env[MOCHA_CHILD_ENV]
if (!raw) throw new Error(`${MOCHA_CHILD_ENV} is not set: this module runs only as Veyrum's Mocha process`)
// The test file's process sees the environment and arguments it would without Veyrum, and Mocha's
// executable as its main module, which yargs reads its version from and tests can look at.
delete process.env[MOCHA_CHILD_ENV]
const config = JSON.parse(raw) as MochaChildConfig
const bin = path.join(config.mochaDir, 'bin', 'mocha.js')
process.argv.splice(1, process.argv.length - 1, bin, ...config.argv, config.file)
const main = new Module(bin)
main.filename = bin
main.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(
  path.dirname(bin),
)
main.loaded = true
;(process as { mainModule?: Module }).mainModule = main

const captureOptions: WorkerCaptureOptions = {
  root: config.root,
  outDir: config.outDir,
  ignoredPrefixes: config.ignored,
  volatileEnv: VOLATILE_ENV,
  layout: 'node',
}
const captured = !uncapturedFiles(config.outDir).has(config.file)
// Mocha's own modules load with the hooks in place but before capture begins: what they read to
// initialize (the environment, the terminal) is the runner's. Veyrum's main process loads the same
// modules, so the packages they come from are shared inputs.
if (captured) prepareWorkerHooks(captureOptions)
const Mocha = mochaModule<MochaExports>(config.mochaDir, 'lib/mocha.js')
const cli = mochaModule<{ main(argv: string[], options: object): void }>(config.mochaDir, 'lib/cli/cli.js')

let finish: () => Promise<void> = () => Promise.resolve()
if (captured) {
  const capture = await beginWorkerCapture(captureOptions)
  let finishing: Promise<void> | null = null
  // A failure only loses this file's evidence (it is then not reusable), never the exit code.
  finish = () => {
    finishing ??= capture.finish(config.file, { added: 0, updated: 0 }).catch(() => {})
    return finishing
  }
  process.on('beforeExit', () => {
    void finish()
  })
}

function reported(report: ReportedFile): void {
  unobserved(() => fs.writeFileSync(config.reportFile, JSON.stringify(report)))
  // Mocha's --exit ends the process right after the run, before it would be idle.
  const exit = process.exit
  process.exit = ((code?: number | string | null) => {
    process.exit = exit
    void finish().then(() => exit.call(process, code))
  }) as typeof process.exit
}

Mocha.reporters[REPORTER_NAME] = createReporter(Mocha, config.print, reported)
const { mochaOptions } = splitNodeFlags(config.mochaDir, loadMochaOptions(config.mochaDir, config.argv))
mochaOptions._ = [config.file]
mochaOptions.reporter = REPORTER_NAME
// This process is the file's own: Mocha runs it here, once.
mochaOptions.parallel = false
mochaOptions.watch = false
if (config.color && mochaOptions.color === undefined) mochaOptions.color = true
cli.main([], mochaOptions)
