import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings, withChange } from './settings'

describe('parseSettings', () => {
  it('survives a file that is not settings at all', () => {
    expect(parseSettings('not json')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('[]')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('"a string"')).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps the fields it understands and defaults the rest', () => {
    const parsed = parseSettings(JSON.stringify({ rate: 1.4, theme: 'light' }))
    expect(parsed.rate).toBe(1.4)
    expect(parsed.theme).toBe('light')
    expect(parsed.measure).toBe(DEFAULT_SETTINGS.measure)
  })

  it('clamps a hand-edited number rather than trusting it', () => {
    // The file is editable, so every range is enforced on the way in.
    const parsed = parseSettings(JSON.stringify({ rate: 99, fontScale: 0.1, ocrDpi: 5000 }))
    expect(parsed.rate).toBe(3)
    expect(parsed.fontScale).toBe(0.8)
    expect(parsed.ocrDpi).toBe(450)
  })

  it('rejects a value of the wrong type without taking the rest down', () => {
    const parsed = parseSettings(JSON.stringify({ rate: 'fast', neural: 'yes', measure: 60 }))
    expect(parsed.rate).toBe(1)
    expect(parsed.neural).toBe(true)
    expect(parsed.measure).toBe(60)
  })

  it('falls back on an unknown theme or sort', () => {
    const parsed = parseSettings(JSON.stringify({ theme: 'sepia', sort: 'nonsense' }))
    expect(parsed.theme).toBe('dark')
    expect(parsed.sort).toBe('added')
  })

  /*
    The section list defaults to shown, so `false` is the value with something to
    prove. This is the shape of the shelf-sort bug: a choice that reads back as
    the default has not been stored at all, and the symptom is a setting that
    silently forgets itself at every launch rather than an error anyone sees.
  */
  it('remembers a collapsed section list', () => {
    expect(parseSettings('{}').sections).toBe(true)
    expect(parseSettings(JSON.stringify({ sections: false })).sections).toBe(false)
    expect(parseSettings(JSON.stringify({ sections: 'no' })).sections).toBe(true)
  })

  it('carries a collapsed section list through a change to something else', () => {
    const collapsed = parseSettings(JSON.stringify({ sections: false }))
    expect(withChange(collapsed, { rate: 1.5 }).sections).toBe(false)
  })

  it('reads the nested voice shape and clamps it', () => {
    const parsed = parseSettings(
      JSON.stringify({ shape: { lengthScale: 9, noiseScale: -1, noiseW: 0.5 } })
    )
    expect(parsed.shape.lengthScale).toBe(2)
    expect(parsed.shape.noiseScale).toBe(0)
    expect(parsed.shape.noiseW).toBe(0.5)
  })

  it('reads the nested maths gate', () => {
    const parsed = parseSettings(JSON.stringify({ math: { maxWords: 25 } }))
    expect(parsed.math.maxWords).toBe(25)
    expect(parsed.math.alwaysSpeakInline).toBe(true)
  })
})

describe('withChange', () => {
  it('applies a change and revalidates the whole record', () => {
    const changed = withChange(DEFAULT_SETTINGS, { rate: 1.5 })
    expect(changed.rate).toBe(1.5)
    expect(changed.theme).toBe('dark')
  })

  it('clamps a change as strictly as a file', () => {
    expect(withChange(DEFAULT_SETTINGS, { rate: 99 }).rate).toBe(3)
  })

  it('does not mutate what it was given', () => {
    const before = { ...DEFAULT_SETTINGS }
    withChange(DEFAULT_SETTINGS, { rate: 2 })
    expect(DEFAULT_SETTINGS).toEqual(before)
  })
})
