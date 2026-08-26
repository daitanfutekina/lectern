import { describe, expect, it } from 'vitest'
import { initials, shelfSubtitle, sortShelf, type ShelfEntry } from './shelf'

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

describe('sortShelf', () => {
  const facts = (id: string) =>
    ({ a: { addedAt: 30, readAt: 1 }, b: { addedAt: 10, readAt: 99 }, c: { addedAt: 20, readAt: 0 } })[
      id
    ] ?? { addedAt: 0, readAt: 0 }

  const shelf = [
    entry({ id: 'a', title: 'Zebra', format: 'pdf' }),
    entry({ id: 'b', title: 'Apple', format: 'markdown' }),
    entry({ id: 'c', title: 'Mango', format: 'epub' })
  ]

  it('orders by when a book was added', () => {
    expect(sortShelf(shelf, 'added', facts).map((e) => e.id)).toEqual(['a', 'c', 'b'])
  })

  it('orders by when a book was last read', () => {
    expect(sortShelf(shelf, 'read', facts).map((e) => e.id)).toEqual(['b', 'a', 'c'])
  })

  it('orders by title, case-insensitively', () => {
    expect(sortShelf(shelf, 'title', facts).map((e) => e.title)).toEqual(['Apple', 'Mango', 'Zebra'])
  })

  it('groups by format, then title within each', () => {
    expect(sortShelf(shelf, 'format', facts).map((e) => e.format)).toEqual([
      'epub',
      'markdown',
      'pdf'
    ])
  })

  it('breaks ties by title, so the grid never reshuffles between renders', () => {
    const tied = [entry({ id: 'x', title: 'Beta' }), entry({ id: 'y', title: 'Alpha' })]
    const flat = () => ({ addedAt: 5, readAt: 5 })
    expect(sortShelf(tied, 'added', flat).map((e) => e.title)).toEqual(['Alpha', 'Beta'])
  })

  it('does not mutate what it was given', () => {
    const original = [...shelf]
    sortShelf(shelf, 'title', facts)
    expect(shelf).toEqual(original)
  })
})
