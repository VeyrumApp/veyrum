import fs from 'node:fs'
import module from 'node:module'
import { fileURLToPath } from 'node:url'
import { type HookSink, installHooks, setSink } from './hooks.ts'

/**
 * Traces a Node program a test starts, or a worker thread it creates, with capture's own hooks,
 * where no native tracer follows it (macOS, Windows, and worker threads everywhere). What it
 * reads, lists, writes, starts and connects to is appended to the trace log the test's worker
 * replays (the format of native/trace.c), and so is every module it loads: the program's code is
 * an input of the test, file by file.
 *
 * It sees what the program does through Node's APIs. Like the test's own code, a native addon's
 * file access is not seen (the addon's binary is recorded).
 */

/** The variable that names the log; the preload removes it, so the program sees the environment it would. */
export const TRACE_ENV = 'VEYRUM_TRACE'

export function startChildTrace(): void {
  const log = process.env[TRACE_ENV]
  if (!log) return
  delete process.env[TRACE_ENV]
  // The log's own writes go through fs functions taken before the hooks wrap them.
  const { openSync, writeSync } = fs
  let fd: number | null = null
  const written = new Set<string>()
  const append = (line: string): void => {
    if (written.has(line)) return
    written.add(line)
    try {
      fd ??= openSync(log, 'a')
      writeSync(fd, line)
    } catch {
      // The log is in the run's own scratch directory, which the native tracers write to as well:
      // like them, this assumes it stays writable.
    }
  }
  const pathLine = (kind: string, absolute: string): void =>
    append(absolute.includes('\n') ? 'u unrecordable path\n' : `${kind} ${absolute}\n`)

  const sink: HookSink = {
    path(absolute, kind, type) {
      if (kind === 'dir') pathLine('d', absolute)
      else if (kind === 'stat') pathLine(type === 'absent' ? 'S' : 's', absolute)
      else pathLine(type === 'absent' ? 'R' : 'r', absolute)
    },
    write(absolute) {
      pathLine('w', absolute)
    },
    // The program's whole environment is recorded when it starts.
    env() {},
    envEnumerated() {},
    envWrite() {},
    net(host, port, local) {
      append(local && port === undefined ? `n unix:${host} 0\n` : `n ${host} ${port ?? 0}\n`)
    },
    spawn(command) {
      append(`u ${command.replaceAll('\n', ' ')}\n`)
    },
    traceLog: () => log,
    packageName() {},
    dlopen(absolute) {
      pathLine('r', absolute)
    },
    sourceObserved() {},
  }

  const registerHooks = (module as { registerHooks?: (hooks: object) => unknown }).registerHooks
  if (typeof registerHooks !== 'function') {
    // Without module hooks (Node before 22.15), the program's code cannot be recorded.
    append('u node module loads\n')
  } else {
    registerHooks({
      load(url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown) {
        if (url.startsWith('file:')) pathLine('r', fileURLToPath(url))
        return nextLoad(url, context)
      },
    })
  }
  installHooks({})
  setSink(sink)
}
