import fs from 'node:fs'
import module from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { observeListening } from './listen.ts'
import { type PlaywrightCaptureConfig, SCRATCH } from './protocol.ts'

/** Appends lines to this process's log in a directory of the run's scratch directory. */
function appender(dir: string): (line: string) => void {
  const { appendFileSync, mkdirSync } = fs
  const log = path.join(dir, `${process.pid}.log`)
  let ready = false
  return (line) => {
    try {
      if (!ready) mkdirSync(dir, { recursive: true })
      ready = true
      appendFileSync(log, line)
    } catch {
      // The scratch directory is the run's own; a failure loses only this observation, and a port
      // never logged makes its traffic count as unobserved.
    }
  }
}

/** This process's parent, and theirs, as far as the system tells (Linux: every ancestor). */
function ancestors(): number[] {
  const out = [process.ppid]
  const { readFileSync } = fs
  for (let depth = 0; depth < 64; depth++) {
    let stat: string
    try {
      stat = readFileSync(`/proc/${out[out.length - 1]}/stat`, 'utf8')
    } catch {
      break
    }
    // The fourth field, after the command name in parentheses (which may contain spaces).
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    if (!parent || out.includes(parent)) break
    out.push(parent)
  }
  return out
}

/**
 * In a Node program a test started: logs `<port> <ancestor pids>` for each port it listens on, so
 * that the port counts as served by the test's own process tree (see analyze.ts).
 */
export function logChildListening(config: PlaywrightCaptureConfig): void {
  const append = appender(path.join(config.scratch, SCRATCH.children))
  observeListening((port) => append(`${port} ${ancestors().join(' ')}\n`))
}

/**
 * In every Node process of an app server (the webServer, or a program global setup starts): logs
 * the ports it listens on and the files it loads as code. What it reads is traced natively by the
 * main process (see main-process.ts); this tells which process serves which port, and which files
 * the server runs itself (never treated as client code, see analyze.ts).
 *
 * Lines are appended as they happen: servers are usually killed, not shut down.
 */
export function startServer(config: PlaywrightCaptureConfig): void {
  const append = appender(path.join(config.scratch, SCRATCH.server))
  observeListening((port) => append(`L ${port}\n`))
  const register = (module as { registerHooks?: (hooks: object) => unknown }).registerHooks
  if (typeof register !== 'function') {
    append('U module loads cannot be observed\n')
    return
  }
  const loaded = new Set<string>()
  register({
    load(url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown) {
      if (url.startsWith('file:') && !loaded.has(url)) {
        loaded.add(url)
        const file = fileURLToPath(url)
        if (!file.includes('\n')) append(`C ${file}\n`)
      }
      return nextLoad(url, context)
    },
  })
}
