export type FatalErrorKind = 'Uncaught exception' | 'Unhandled rejection'

function describe(reason: unknown): string {
  try {
    if (reason instanceof Error) return reason.stack || `${reason.name}: ${reason.message}`
  } catch {
    // A hostile Proxy can throw even during inspection; the logger must not.
  }

  if (typeof reason === 'string') return reason

  try {
    const serialized = JSON.stringify(reason)
    if (serialized !== undefined) return serialized
  } catch {
    // Circular values and BigInts fall through to their ordinary string form.
  }

  try {
    return String(reason)
  } catch {
    return '<unprintable value>'
  }
}

/** A complete append-only entry for the main-process error log. */
export function formatFatalError(
  kind: FatalErrorKind,
  reason: unknown,
  at: Date = new Date()
): string {
  return `[${at.toISOString()}] ${kind}\n${describe(reason)}\n\n`
}
