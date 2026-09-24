/**
 * Imported first by the CLI. Node 22 (and 24 before 24.13) warns on every run that SQLite, which
 * the evidence store uses, is experimental; that says nothing to a Veyrum user.
 */
const emitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message
  if (/SQLite is an experimental feature/.test(text)) return
  ;(emitWarning as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning
