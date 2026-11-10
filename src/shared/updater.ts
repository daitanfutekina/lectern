export type UpdateOutcome = 'downloaded' | 'not-available' | 'error'

/** The network is never touched in development or after the reader opts out. */
export function shouldCheckForUpdates(packaged: boolean, enabled: boolean): boolean {
  return packaged && enabled
}

/** Only an actionable result interrupts the reader's attention. */
export function updateNotice(outcome: UpdateOutcome): string | null {
  return outcome === 'downloaded'
    ? 'An update is ready and will be installed when you quit Lectern.'
    : null
}
