import { describe, expect, it } from 'vitest'
import type { Chapter } from './library'
import {
  pdfChapterAtPage,
  pdfPageCount,
  pdfPageRange,
  pdfPageTarget
} from './pdf-navigation'

const chapter = (file: string, title = file): Chapter => ({
  file,
  title,
  crumb: null,
  headings: [],
  words: 100
})

const chapters = [chapter('p1-12', 'Introduction'), chapter('p13-29', 'Methods')]

describe('pdfPageRange', () => {
  it('reads the synthetic range made by the PDF adapter', () => {
    expect(pdfPageRange('p13-29')).toEqual({ from: 13, to: 29 })
  })

  it('rejects malformed and backwards ranges', () => {
    expect(pdfPageRange('chapter-2')).toBeNull()
    expect(pdfPageRange('p9-4')).toBeNull()
  })
})

describe('pdfChapterAtPage', () => {
  it('changes chapters at the exact page boundary', () => {
    expect(pdfChapterAtPage(chapters, 12)?.title).toBe('Introduction')
    expect(pdfChapterAtPage(chapters, 13)?.title).toBe('Methods')
  })

  it('returns null outside the represented pages', () => {
    expect(pdfChapterAtPage(chapters, 30)).toBeNull()
  })
})

describe('pdfPageCount', () => {
  it('uses the greatest range end regardless of chapter order', () => {
    expect(pdfPageCount([...chapters].reverse())).toBe(29)
  })
})

describe('pdfPageTarget', () => {
  it('clamps typed pages to the document', () => {
    expect(pdfPageTarget('0', 29)).toBe(1)
    expect(pdfPageTarget('13', 29)).toBe(13)
    expect(pdfPageTarget('999', 29)).toBe(29)
  })

  it('rejects an empty or non-numeric target', () => {
    expect(pdfPageTarget('', 29)).toBeNull()
    expect(pdfPageTarget('page 4', 29)).toBeNull()
  })
})
