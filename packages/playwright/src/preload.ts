import { CONFIG_ENV, MAIN_PID_ENV, type PlaywrightCaptureConfig, ROLE_ENV } from './protocol.ts'

/**
 * Loaded (NODE_OPTIONS --import) into every Node process of a Playwright run: Playwright's main
 * process, its workers, the programs it starts as app servers, and anything they start. Each takes
 * its part from ROLE_ENV; any other process is left alone.
 */
const raw = process.env[CONFIG_ENV]
const role = process.env[ROLE_ENV]
if (raw && role) {
  const config = JSON.parse(raw) as PlaywrightCaptureConfig
  if (role === 'main') {
    // Only the process Veyrum started is the main process; the programs it starts are told apart below.
    process.env[ROLE_ENV] = 'child'
    process.env[MAIN_PID_ENV] = String(process.pid)
    const { startMain } = await import('./main-process.ts')
    startMain(config)
  } else if (role === 'server') {
    const { startServer } = await import('./server-process.ts')
    startServer(config)
  } else if (
    role === 'child' &&
    typeof process.send === 'function' &&
    String(process.ppid) === process.env[MAIN_PID_ENV]
  ) {
    // A child of the main process with an IPC channel: a Playwright worker (or its test loader),
    // which the worker module recognizes by the messages it receives.
    const { startWorker } = await import('./worker-process.ts')
    startWorker(config)
  } else if (role === 'child') {
    // A program a test started (traced by the worker's capture): the ports it serves belong to the
    // worker that started it, found through the parent pids logged here.
    const { logChildListening } = await import('./server-process.ts')
    logChildListening(config)
  }
}
