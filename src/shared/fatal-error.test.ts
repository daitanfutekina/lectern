import { describe, expect, it } from 'vitest'
import { formatFatalError } from './fatal-error'

const WHEN = new Date('2026-11-09T18:30:00.000Z')

describe('formatFatalError', () => {
  it('records the time, failure kind, and error stack', () => {
    const error = new Error('library scan failed')
    const entry = formatFatalError('Uncaught exception', error, WHEN)

    expect(entry).toContain('[2026-11-09T18:30:00.000Z] Uncaught exception')
    expect(entry).toContain('Error: library scan failed')
    expect(entry.endsWith('\n\n')).toBe(true)
  })

  it('records non-Error rejection reasons', () => {
    expect(formatFatalError('Unhandled rejection', { operation: 'open', code: 5 }, WHEN)).toContain(
      '{"operation":"open","code":5}'
    )
    expect(formatFatalError('Unhandled rejection', 'offline', WHEN)).toContain('\noffline\n')
  })

  it('does not throw while describing an unprintable reason', () => {
    const reason = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('no prototype')
        },
        get: () => {
          throw new Error('no properties')
        }
      }
    )

    expect(formatFatalError('Unhandled rejection', reason, WHEN)).toContain('<unprintable value>')
  })
})
