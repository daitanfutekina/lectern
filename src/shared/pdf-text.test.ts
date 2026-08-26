import { describe, expect, it } from 'vitest'
import {
  assemblePage,
  cleanPage,
  furnitureKey,
  isFurniture,
  repeatedLines,
  type TextItem
} from './pdf-text'

/** A fragment at a position. Height 10 throughout, so ratios are readable. */
const item = (str: string, x: number, y: number, width = str.length * 5): TextItem => ({
  str,
  transform: [1, 0, 0, 1, x, y],
  width,
  height: 10
})

describe('assemblePage', () => {
  it('inserts the space the PDF omitted', () => {
    // The defect this module exists for: "Digital Designwith RTL Design".
    const page = assemblePage([item('Digital Design', 0, 700), item('with RTL', 90, 700)])
    expect(page).toEqual(['Digital Design with RTL'])
  })

  it('does not insert a space where the glyphs touch', () => {
    // Two fragments of one word, which is how a PDF often stores kerned text.
    const page = assemblePage([item('Dig', 0, 700, 15), item('ital', 15, 700)])
    expect(page).toEqual(['Digital'])
  })

  it('joins a wrapped line without inventing a paragraph', () => {
    const page = assemblePage([item('the quick brown', 0, 700), item('fox jumps', 0, 690)])
    expect(page).toEqual(['the quick brown fox jumps'])
  })

  it('rejoins a word hyphenated across a line break', () => {
    // "consider-\nation" spoken as two words is the most audible scanning bug.
    const page = assemblePage([item('consider-', 0, 700), item('ation follows', 0, 690)])
    expect(page).toEqual(['consideration follows'])
  })

  it('starts a paragraph on a noticeably larger line gap', () => {
    const page = assemblePage([
      item('first line', 0, 700),
      item('still first', 0, 690),
      item('second paragraph', 0, 660)
    ])
    expect(page).toEqual(['first line still first', 'second paragraph'])
  })

  it('honours an explicit end of line', () => {
    const page = assemblePage([
      { ...item('one', 0, 700), hasEOL: true },
      item('two', 0, 699)
    ])
    expect(page).toEqual(['one two'])
  })

  it('is empty for a page with no text', () => {
    expect(assemblePage([])).toEqual([])
    expect(assemblePage([item('', 0, 0)])).toEqual([])
  })
})

describe('isFurniture', () => {
  it('recognises page numbers', () => {
    expect(isFurniture('42')).toBe(true)
    expect(isFurniture('Page 42')).toBe(true)
    expect(isFurniture('xiv')).toBe(true)
    expect(isFurniture('42 | Chapter 3')).toBe(true)
    expect(isFurniture('Chapter 3 — 42')).toBe(true)
  })

  it('keeps real prose', () => {
    expect(isFurniture('The determinant of a triangular matrix')).toBe(false)
    expect(isFurniture('In 1998 the standard was revised by the committee')).toBe(false)
  })

  it('keeps a long line even if it looks numeric', () => {
    // A table row is content; the length rules it out of being furniture.
    expect(isFurniture('1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23')).toBe(false)
  })
})

describe('repeatedLines', () => {
  it('finds a running head', () => {
    // Pages are given a realistic number of lines on purpose. Only the first
    // and last two are examined, so body text is out of reach -- and it has to
    // be, because digits are normalised away and a body line that differs only
    // by a number would otherwise look exactly like a running head.
    const pages = Array.from({ length: 10 }, (_, n) => [
      'Chapter 3: Determinants',
      `The determinant of a matrix of order ${n} has a sign.`,
      'Expanding along the first row gives the cofactor sum.',
      'A triangular matrix is the easy case.',
      'Row operations change the value in known ways.',
      `${n + 10}`
    ])
    const repeated = repeatedLines(pages)
    // The set holds keys, not lines: digits are normalised away.
    expect(repeated.has(furnitureKey('Chapter 3: Determinants'))).toBe(true)
    expect(repeated.has(furnitureKey('A triangular matrix is the easy case.'))).toBe(false)
  })

  it('normalises the numbers, so a numbered head still counts as one', () => {
    const pages = Array.from({ length: 10 }, (_, n) => [`Section 2.${n} Introduction`, 'body'])
    expect(repeatedLines(pages).has('Section #.# Introduction')).toBe(true)
  })

  it('says nothing about a document too short to judge', () => {
    expect(repeatedLines([['a'], ['a']]).size).toBe(0)
  })
})

describe('cleanPage', () => {
  it('drops furniture and repeated heads, keeping the prose', () => {
    const repeated = new Set([furnitureKey('Chapter 3: Determinants')])
    expect(cleanPage(['Chapter 3: Determinants', 'Real content here.', '42'], repeated)).toEqual([
      'Real content here.'
    ])
  })
})
