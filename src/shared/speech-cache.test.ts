import { describe, expect, it } from 'vitest'
import { isCacheable, normaliseText, speechKey, type SpeechRequest } from './speech-cache'
import { BOOK_VOICE } from './voice'

const base: SpeechRequest = {
  text: 'The determinant is zero.',
  voiceId: 'vits-piper-en_GB-alba-medium',
  shape: BOOK_VOICE,
  speed: 1,
  character: 'teto',
  semitones: 4
}

const changed = (change: Partial<SpeechRequest>): string => speechKey({ ...base, ...change })

describe('speechKey', () => {
  it('is the same for the same request', () => {
    expect(speechKey(base)).toBe(speechKey({ ...base }))
  })

  /*
    Every setting a reader can move has to be in the key.

    Leaving one out serves audio made with the old value after the reader has
    changed it -- a moved slider that appears to do nothing, which is a far more
    confusing bug than a cache that simply misses.
  */
  it('changes with the text', () => {
    expect(changed({ text: 'The determinant is one.' })).not.toBe(speechKey(base))
  })

  it('changes with the character', () => {
    expect(changed({ character: 'someone-else' })).not.toBe(speechKey(base))
    expect(changed({ character: null })).not.toBe(speechKey(base))
  })

  it('changes with the pitch shift', () => {
    expect(changed({ semitones: 5 })).not.toBe(speechKey(base))
  })

  it('changes with the base voice', () => {
    expect(changed({ voiceId: 'vits-piper-en_US-lessac-medium' })).not.toBe(speechKey(base))
  })

  it('changes with the speed', () => {
    expect(changed({ speed: 1.2 })).not.toBe(speechKey(base))
  })

  it('changes with every part of the voice shape', () => {
    for (const field of ['lengthScale', 'noiseScale', 'noiseW'] as const) {
      const shape = { ...BOOK_VOICE, [field]: BOOK_VOICE[field] + 0.1 }
      expect(changed({ shape })).not.toBe(speechKey(base))
    }
  })

  it('ignores whitespace, which is not audible', () => {
    // The same sentence reaches this from Markdown, a PDF text layer and an
    // EPUB, and the three disagree about line breaks while sounding identical.
    expect(changed({ text: 'The  determinant\n is zero.' })).toBe(speechKey(base))
    expect(changed({ text: '  The determinant is zero.  ' })).toBe(speechKey(base))
  })

  it('does not let a text ending in the separator imitate other settings', () => {
    // The text goes last precisely so this cannot happen.
    expect(changed({ text: 'a b' })).not.toBe(changed({ text: 'a', semitones: 4 }))
  })
})

describe('normaliseText', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(normaliseText('  a \n\t b  ')).toBe('a b')
  })
})

describe('isCacheable', () => {
  it('stores converted speech', () => {
    expect(isCacheable(base)).toBe(true)
  })

  it('does not store plain speech', () => {
    // Piper is faster than reading the audio back off a disk, so caching it
    // would cost space and save nothing.
    expect(isCacheable({ ...base, character: null })).toBe(false)
  })

  it('does not store nothing', () => {
    expect(isCacheable({ ...base, text: '   ' })).toBe(false)
  })
})
