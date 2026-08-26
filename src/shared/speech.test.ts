import { describe, expect, it } from 'vitest'
import {
  clampRate,
  estimateSeconds,
  sentenceSpans,
  sentences,
  speakable,
  speakableWithMap,
  utterancesFor
} from './speech'

describe('speakable', () => {
  it('says section rather than swallowing the symbol', () => {
    expect(speakable('See §5.1 for details')).toBe('See section 5.1 for details')
  })

  it('speaks mathematical symbols that engines otherwise drop', () => {
    expect(speakable('a × b')).toContain(' by ')
    expect(speakable('x ≤ 3')).toContain(' at most ')
    expect(speakable('p ⇒ q')).toContain(' implies ')
  })

  it('turns a parenthetical dash into a pause, not a word', () => {
    expect(speakable('the matrix — a square one — is invertible')).toBe(
      'the matrix, a square one, is invertible'
    )
  })

  it('collapses whitespace', () => {
    expect(speakable('  many\n\n  spaces  ')).toBe('many spaces')
  })
})

describe('sentences', () => {
  it('splits on terminators', () => {
    expect(sentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?'])
  })

  it('does not split a decimal', () => {
    // "3." followed by "14" would otherwise end a sentence mid-number.
    expect(sentences('The value is 3.14 exactly.')).toEqual(['The value is 3.14 exactly.'])
  })

  it('does not split after an abbreviation', () => {
    expect(sentences('See Fig. 3 for the shape.')).toEqual(['See Fig. 3 for the shape.'])
    expect(sentences('Dr. Kim wrote the notes.')).toEqual(['Dr. Kim wrote the notes.'])
  })

  it('does not split after a lone initial', () => {
    expect(sentences('Written by J. Smith today.')).toEqual(['Written by J. Smith today.'])
  })

  it('keeps a trailing fragment with no terminator', () => {
    expect(sentences('First one. And a trailing clause')).toEqual([
      'First one.',
      'And a trailing clause'
    ])
  })

  it('is empty for empty input', () => {
    expect(sentences('')).toEqual([])
    expect(sentences('   ')).toEqual([])
  })

  it('applies symbol replacement before splitting', () => {
    expect(sentences('Read §2.1 now.')).toEqual(['Read section 2.1 now.'])
  })
})

describe('utterancesFor', () => {
  it('speaks a heading as one utterance however long', () => {
    // A heading is a label. Splitting it into sentences makes it sound like prose.
    const block = { kind: 'heading', level: 2, text: 'Eigenvalues. And eigenvectors.' } as const
    expect(utterancesFor(block)).toEqual(['Eigenvalues. And eigenvectors.'])
  })

  it('splits a paragraph into sentences', () => {
    const block = { kind: 'paragraph', text: 'One. Two.' } as const
    expect(utterancesFor(block)).toEqual(['One.', 'Two.'])
  })

  it('says nothing for a skipped block', () => {
    expect(utterancesFor({ kind: 'skip', reason: 'code' })).toEqual([])
  })

  it('speaks mathematics only when it has a spoken form', () => {
    expect(utterancesFor({ kind: 'math', latex: 'x^2', speech: 'x squared', display: false }))
      .toEqual(['x squared'])
    expect(utterancesFor({ kind: 'math', latex: '\\int_0^1', speech: null, display: true }))
      .toEqual([])
  })
})

describe('estimateSeconds', () => {
  it('scales with rate', () => {
    const text = Array.from({ length: 180 }, () => 'word').join(' ')
    expect(estimateSeconds(text, 1)).toBeCloseTo(60)
    expect(estimateSeconds(text, 2)).toBeCloseTo(30)
  })
})

describe('clampRate', () => {
  it('keeps a sensible rate and clamps the rest', () => {
    expect(clampRate(1.5)).toBe(1.5)
    expect(clampRate(0.1)).toBe(0.5)
    expect(clampRate(99)).toBe(3)
    expect(clampRate(Number.NaN)).toBe(1)
  })
})

describe('speakableWithMap', () => {
  it('maps every spoken character back to where it came from', () => {
    // Word-follow depends on this: "§" becomes eight characters, and a
    // boundary reported against the spoken text must still highlight the "§".
    const { text, map } = speakableWithMap('See §5 now')
    expect(text).toBe('See section 5 now')
    expect(map).toHaveLength(text.length)
    // What matters is that the first character of each spoken word points at
    // the right place on screen -- that is where a boundary event lands.
    expect(text.slice(4, 11)).toBe('section')
    expect(map[4]).toBe(4) // "section" came from the "§"
    expect(text[12]).toBe('5')
    expect(map[12]).toBe(5) // and the digit after it from the digit
    // A collapsed space takes the index of the character that follows it,
    // which keeps the word after a substitution pointing at the right source.
    expect(map[11]).toBe(5)
  })

  it('keeps the map aligned through whitespace collapse', () => {
    const { text, map } = speakableWithMap('a   b')
    expect(text).toBe('a b')
    expect(map).toHaveLength(3)
    expect(map[2]).toBe(4)
  })

  it('never maps past the end of the source', () => {
    const source = 'x ≤ 3 and y ≥ 4.'
    const { text, map } = speakableWithMap(source)
    expect(map).toHaveLength(text.length)
    for (const index of map) expect(index).toBeLessThan(source.length)
  })
})

describe('sentenceSpans', () => {
  it('reports offsets that address the prepared text', () => {
    const prepared = 'One. Two.'
    const spans = sentenceSpans(prepared)
    expect(spans).toHaveLength(2)
    for (const span of spans) {
      expect(prepared.slice(span.start, span.end)).toBe(span.text)
    }
  })

  it('trims whitespace without lying about where the text is', () => {
    const prepared = 'One.   Two.'
    const spans = sentenceSpans(prepared)
    expect(spans[1]?.text).toBe('Two.')
    expect(prepared.slice(spans[1]!.start, spans[1]!.end)).toBe('Two.')
  })
})
