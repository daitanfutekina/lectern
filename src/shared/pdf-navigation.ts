import type { Chapter } from './library'

export interface PdfPageRange {
  readonly from: number
  readonly to: number
}

/** The page range encoded in the synthetic chapter names made by the PDF adapter. */
export function pdfPageRange(file: string): PdfPageRange | null {
  const match = /^p(\d+)-(\d+)$/.exec(file)
  if (!match) return null

  const from = Number(match[1])
  const to = Number(match[2])
  return from >= 1 && to >= from ? { from, to } : null
}

/** The chapter whose range contains a 1-based PDF page. */
export function pdfChapterAtPage(
  chapters: readonly Chapter[],
  page: number
): Chapter | null {
  for (const chapter of chapters) {
    const range = pdfPageRange(chapter.file)
    if (range && page >= range.from && page <= range.to) return chapter
  }
  return null
}

/** The last page represented by the PDF's synthetic chapters. */
export function pdfPageCount(chapters: readonly Chapter[]): number {
  return chapters.reduce((last, chapter) => {
    const range = pdfPageRange(chapter.file)
    return range ? Math.max(last, range.to) : last
  }, 0)
}

/** Turn the page-number field into a safe target for the viewer. */
export function pdfPageTarget(value: string, pages: number): number | null {
  if (!value.trim()) return null
  const page = Number(value)
  if (!Number.isFinite(page) || pages < 1) return null
  return Math.max(1, Math.min(Math.trunc(page), pages))
}
