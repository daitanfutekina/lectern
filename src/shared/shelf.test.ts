import { describe, expect, it } from 'vitest'
import { initials, shelfSubtitle, type ShelfEntry } from './shelf'

const entry = (over: Partial<ShelfEntry> = {}): ShelfEntry => ({
  id: 'x',
  title: 'Linear Algebra',
  format: 'markdown',
  badge: 'MD',
  chapters: 6,
  words: 12_500,
  progress: null,
  cover: null,
  ...over
})

describe('initials', () => {
  it('takes the first letter of each significant word', () => {
    expect(initials('Linear Algebra')).toBe('LA')
    expect(initials('Digital Design with RTL')).toBe('DDR')
  })

  it('skips a leading article, which carries no recognition', () => {
    expect(initials('The Physical Game')).toBe('PG')
  })

  it('uses two letters when there is only one word', () => {
    expect(initials('Calculus')).toBe('CA')
  })

  it('survives punctuation and a title with nothing in it', () => {
    // Three significant words survive the punctuation: C, Data, Structures.
    expect(initials('C++ / Data Structures')).toBe('CDS')
    expect(initials('...')).toBe('..')
  })
})

describe('shelfSubtitle', () => {
  it('abbreviates a large word count', () => {
    expect(shelfSubtitle(entry())).toBe('6 chapters · 13k words')
  })

  it('spells out a small one', () => {
    expect(shelfSubtitle(entry({ words: 900 }))).toBe('6 chapters · 900 words')
  })

  it('says nothing about words when there are none', () => {
    expect(shelfSubtitle(entry({ words: 0 }))).toBe('6 chapters')
  })

  it('agrees with itself about one chapter', () => {
    expect(shelfSubtitle(entry({ chapters: 1, words: 0 }))).toBe('1 chapter')
  })
})
