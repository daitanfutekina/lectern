import { describe, expect, it } from 'vitest'
import { BOOK_VOICE, clampShape, pauseAfter } from './voice'

describe('BOOK_VOICE', () => {
  it('is meaningfully slower than the model default', () => {
    // Measured: 1.0 reads at 182 wpm, 1.1 at 179 -- indistinguishable. The
    // first attempt at a book voice changed nothing, which is the whole reason
    // this test exists.
    expect(BOOK_VOICE.lengthScale).toBeGreaterThan(1.25)
  })
})

describe('pauseAfter', () => {
  it('leaves the longest gap after a finished sentence', () => {
    expect(pauseAfter('That is the whole idea.')).toBeGreaterThan(pauseAfter('first,'))
    expect(pauseAfter('Is it?')).toBeGreaterThan(pauseAfter('and then,'))
  })

  it('handles a terminator inside a quote or bracket', () => {
    expect(pauseAfter('he said "no."')).toBe(pauseAfter('plain.'))
  })

  it('gives a heading a beat of its own', () => {
    expect(pauseAfter('Eigenvalues and Eigenvectors')).toBeGreaterThan(pauseAfter('a clause,'))
  })

  it('never returns nothing, so sentences never run together', () => {
    for (const text of ['', 'x', 'a,', 'b.', 'c;']) expect(pauseAfter(text)).toBeGreaterThan(0)
  })
})

describe('clampShape', () => {
  it('keeps a shape within what a model actually behaves in', () => {
    expect(clampShape({ lengthScale: 99, noiseScale: -1, noiseW: 5 })).toEqual({
      lengthScale: 2,
      noiseScale: 0,
      noiseW: 1
    })
  })
})
