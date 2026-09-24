import path from 'node:path'
import { VOLATILE_ENV } from '@veyrum/capture'
import { beginWorkerCapture, uncapturedFiles } from '@veyrum/capture/worker'
import { NODE_TEST_CAPTURE_ENV, type NodeTestCaptureConfig } from './protocol.ts'

/**
 * Preloaded (--import) into `node --test` and, through the execArgv it passes on, into the process
 * that runs each test file (node:test marks those with NODE_TEST_CONTEXT). There it captures the
 * file: hooks and coverage start before the file loads, and the payload is written once the process
 * has nothing left to do (beforeExit), after every test and everything they left running. A process
 * that exits early (process.exit, --test-force-exit) writes none, and its file is not reusable.
 */
const raw = process.env[NODE_TEST_CAPTURE_ENV]
const testFile = process.argv[1]
if (raw && testFile && process.env.NODE_TEST_CONTEXT?.startsWith('child')) {
  // The test file's process sees the environment and execArgv it would without Veyrum.
  delete process.env[NODE_TEST_CAPTURE_ENV]
  const config = JSON.parse(raw) as NodeTestCaptureConfig
  const argv = process.execArgv
  const inline = argv.indexOf(`--import=${config.preload}`)
  const separate = argv.indexOf(config.preload)
  if (inline >= 0) argv.splice(inline, 1)
  else if (separate > 0 && argv[separate - 1] === '--import') argv.splice(separate - 1, 2)
  const file = path.resolve(testFile)
  if (!uncapturedFiles(config.outDir).has(file)) {
    const capture = await beginWorkerCapture({
      root: config.root,
      outDir: config.outDir,
      ignoredPrefixes: config.ignored,
      volatileEnv: VOLATILE_ENV,
      layout: 'node',
    })
    let finishing = false
    process.on('beforeExit', () => {
      if (finishing) return
      finishing = true
      // A failure only loses this file's evidence (it is then not reusable), never the exit code.
      capture.finish(file, { added: 0, updated: 0 }).catch(() => {})
    })
  }
}
