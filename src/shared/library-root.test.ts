import { describe, expect, it } from 'vitest'
import { decideLibraryRoot } from './library-root'

const candidates = {
  environment: undefined,
  stored: null,
  storedExists: false,
  fallback: 'C:\\Library',
  fallbackExists: false
}

describe('decideLibraryRoot', () => {
  it('uses LECTERN_ROOT before every persisted or legacy location', () => {
    expect(
      decideLibraryRoot({
        ...candidates,
        environment: 'D:\\from-environment',
        stored: 'D:\\stored',
        storedExists: true,
        fallbackExists: true
      })
    ).toEqual({ source: 'environment', path: 'D:\\from-environment' })
  })

  it('uses an existing stored location before the legacy location', () => {
    expect(
      decideLibraryRoot({
        ...candidates,
        stored: 'D:\\stored',
        storedExists: true,
        fallbackExists: true
      })
    ).toEqual({ source: 'stored', path: 'D:\\stored' })
  })

  it('ignores a stored location that no longer exists', () => {
    expect(
      decideLibraryRoot({
        ...candidates,
        stored: 'D:\\missing',
        fallbackExists: true
      })
    ).toEqual({ source: 'fallback', path: 'C:\\Library' })
  })

  it('keeps an existing installation on C:\\Library without asking', () => {
    expect(decideLibraryRoot({ ...candidates, fallbackExists: true })).toEqual({
      source: 'fallback',
      path: 'C:\\Library'
    })
  })

  it('asks only when no usable location exists', () => {
    expect(decideLibraryRoot(candidates)).toEqual({ source: 'picker' })
  })
})
