import { describe, expect, it } from 'vitest'
import { DEFAULT_GATE, gate, mathUtterance } from './math-gate'

/* Real speech strings, produced by the Speech Rule Engine in clearspeak. */
const SIMPLE = 'x equals mu plus sigma z'
const STATS = 'x bar equals 1 over n the sum from i equals 1 to n of x sub i'
const TRIPLE =
  'the integral from 0 to 1 of the integral from 0 to 1 of the integral from 0 to 1 of ' +
  'f of open paren x comma y comma z close paren d x d y d z the integral from 0 to 1 of ' +
  'the integral from 0 to 1 of f of open paren x comma y close paren d x d y'

describe('gate', () => {
  it('speaks a simple relation', () => {
    expect(gate('x = \\mu + \\sigma z', SIMPLE, true)).toEqual({ speak: true })
  })

  it('speaks a statistical definition, which is the case the reader asked for', () => {
    expect(gate('\\bar{x} = \\frac{1}{n}\\sum x_i', STATS, true)).toEqual({ speak: true })
  })

  it('defers an equation too long to follow by ear', () => {
    expect(gate('\\int\\int\\int', TRIPLE, true)).toEqual({ speak: false, reason: 'too-long' })
  })

  it('defers a stacked derivation however short', () => {
    // The line breaks carry the meaning, and they are inaudible.
    const verdict = gate('\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}', 'a equals b c equals d', true)
    expect(verdict).toEqual({ speak: false, reason: 'multi-line' })
  })

  it('recognises the starred forms too', () => {
    expect(gate('\\begin{align*} x &= 1 \\end{align*}', 'x equals 1', true).speak).toBe(false)
  })

  it('speaks inline mathematics regardless of length', () => {
    // It sits inside a sentence; skipping it leaves a hole in the prose.
    expect(gate('\\int\\int\\int', TRIPLE, false)).toEqual({ speak: true })
  })

  it('refuses when there is no speech at all', () => {
    expect(gate('x = 1', null, true)).toEqual({ speak: false, reason: 'no-speech' })
    expect(gate('x = 1', '   ', true)).toEqual({ speak: false, reason: 'no-speech' })
  })

  it('honours a raised threshold', () => {
    const generous = { ...DEFAULT_GATE, maxWords: 500 }
    expect(gate('\\int\\int\\int', TRIPLE, true, generous)).toEqual({ speak: true })
  })
})

describe('mathUtterance', () => {
  it('returns the speech when the gate allows it', () => {
    expect(mathUtterance('x = 1', SIMPLE, true)).toBe(SIMPLE)
  })

  it('announces a deferred display equation rather than skipping it silently', () => {
    // A silent gap is indistinguishable from a bug; a short announcement tells
    // the listener to look at the screen.
    expect(mathUtterance('\\int\\int\\int', TRIPLE, true)).toContain('on screen')
  })

  it('passes over unspeakable inline mathematics silently', () => {
    // A placeholder mid-sentence is more disruptive than the gap it fills.
    expect(mathUtterance('\\frac{1}{2}', null, false)).toBeNull()
  })
})
