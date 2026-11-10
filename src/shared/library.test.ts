import { describe, expect, it } from 'vitest'
import { nextChapter, type Book } from './library'

const book: Book = {
  id: 'book',
  title: 'Book',
  format: 'markdown',
  path: 'C:\\Library\\books\\book',
  chapters: [
    { file: 'chapter-2.md', title: 'Second', crumb: null, headings: [], words: 20 },
    { file: 'chapter-10.md', title: 'Tenth', crumb: null, headings: [], words: 20 }
  ],
  parts: [],
  macros: {}
}

describe('nextChapter', () => {
  it('follows manifest order rather than file-name order', () => {
    expect(nextChapter(book, 'chapter-2.md')?.file).toBe('chapter-10.md')
  })

  it('stops at the end of the book', () => {
    expect(nextChapter(book, 'chapter-10.md')).toBeNull()
  })
})
