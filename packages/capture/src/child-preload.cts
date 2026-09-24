/**
 * Preloaded (--require) into Node programs a test starts and into worker threads it creates, when
 * no native tracer follows them (see child.ts). A CommonJS file, because worker threads take
 * --require but not --import; it loads the ES module tracer with require().
 *
 * It removes its own flag from process.execArgv, so the program sees the execArgv it would, and
 * does nothing unless the trace log is named.
 */
if (process.env.VEYRUM_TRACE) {
  const at = process.execArgv.indexOf(__filename)
  if (at > 0 && process.execArgv[at - 1] === '--require') process.execArgv.splice(at - 1, 2)
  ;(require('./child.js') as typeof import('./child.ts')).startChildTrace()
}
