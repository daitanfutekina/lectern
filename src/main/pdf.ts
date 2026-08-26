import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { assemblePage, cleanPage, repeatedLines, type TextItem } from '@shared/pdf-text'
import type { Chapter } from '@shared/library'

/**
 * Reading a digital PDF. SPEC section 3.
 *
 * "Digital" means the file carries a real text layer. Those read well. A scan
 * carries only pixels and belongs to M6 and the OCR pipeline; this reports the
 * difference rather than producing silence and leaving it a mystery.
 *
 * The library is loaded lazily: pdf.js is large, and a library of Markdown
 * books should not pay for it on startup.
 */

const require = createRequire(import.meta.url)

type PdfPage = {
  getTextContent: () => Promise<{ items: TextItem[] }>
}
type PdfDocument = {
  numPages: number
  getPage: (n: number) => Promise<PdfPage>
  getOutline: () => Promise<OutlineEntry[] | null>
  getPageIndex: (ref: unknown) => Promise<number>
}
interface OutlineEntry {
  title: string
  dest: unknown
  items?: OutlineEntry[]
}

/** Pages per chapter when a document has no outline to divide it by. */
const PAGES_PER_CHUNK = 20

/**
 * Below this many characters a page has no usable text layer. A digital page
 * runs to hundreds; a scanned one reports a handful of stray marks.
 */
const DIGITAL_CHARS_PER_PAGE = 120

export interface PdfBook {
  readonly document: PdfDocument
  readonly chapters: readonly Chapter[]
  /** First and last page, inclusive and 1-based, per chapter file id. */
  readonly ranges: Readonly<Record<string, { from: number; to: number }>>
  readonly digital: boolean
  readonly pages: number
}

const opened = new Map<string, PdfBook>()

function pdfjs(): { getDocument: (options: unknown) => { promise: Promise<PdfDocument> } } {
  return require('pdfjs-dist/legacy/build/pdf.mjs')
}

export async function openPdf(path: string): Promise<PdfBook> {
  const cached = opened.get(path)
  if (cached) return cached

  const data = new Uint8Array(await readFile(path))
  const document = await pdfjs().getDocument({ data, useSystemFonts: true }).promise

  // Sample rather than scan: on a 948-page book, reading every page to decide
  // whether it has text would cost more than reading the part being read.
  const digital = await hasTextLayer(document)

  const ranges: Record<string, { from: number; to: number }> = {}
  const chapters = (await outlineChapters(document)) ?? chunkChapters(document.numPages)
  for (const chapter of chapters) {
    const parsed = /^p(\d+)-(\d+)$/.exec(chapter.file)
    if (parsed) ranges[chapter.file] = { from: Number(parsed[1]), to: Number(parsed[2]) }
  }

  const book: PdfBook = { document, chapters, ranges, digital, pages: document.numPages }
  opened.set(path, book)
  return book
}

async function hasTextLayer(document: PdfDocument): Promise<boolean> {
  const sample = [1, Math.ceil(document.numPages / 2), document.numPages].filter(
    (n, at, all) => n >= 1 && n <= document.numPages && all.indexOf(n) === at
  )

  let chars = 0
  for (const n of sample) {
    const content = await (await document.getPage(n)).getTextContent()
    chars += content.items.reduce((total, item) => total + (item.str?.length ?? 0), 0)
  }
  return chars / sample.length >= DIGITAL_CHARS_PER_PAGE
}

/**
 * Chapters from the document's own outline where it has one.
 *
 * A 593-page book split into 30 arbitrary chunks is navigable; split by its own
 * table of contents it is a book. Only the top level is used -- a three-deep
 * outline makes a chapter list nobody can scan.
 */
async function outlineChapters(document: PdfDocument): Promise<Chapter[] | null> {
  let outline: OutlineEntry[] | null = null
  try {
    outline = await document.getOutline()
  } catch {
    return null
  }
  if (!outline || outline.length < 2) return null

  const starts: { title: string; page: number }[] = []
  for (const entry of outline) {
    const page = await pageOf(document, entry.dest)
    if (page !== null) starts.push({ title: entry.title.trim() || `Page ${page}`, page })
  }

  starts.sort((a, b) => a.page - b.page)
  if (starts.length < 2) return null

  return starts.map((start, at) => {
    const to = at + 1 < starts.length ? (starts[at + 1]?.page ?? document.numPages) - 1 : document.numPages
    const from = start.page
    return {
      file: `p${from}-${Math.max(from, to)}`,
      title: start.title,
      crumb: null,
      headings: [],
      words: Math.max(1, (Math.max(from, to) - from + 1)) * 300
    }
  })
}

async function pageOf(document: PdfDocument, dest: unknown): Promise<number | null> {
  try {
    const ref = Array.isArray(dest) ? dest[0] : null
    if (!ref) return null
    return (await document.getPageIndex(ref)) + 1
  } catch {
    return null
  }
}

function chunkChapters(pages: number): Chapter[] {
  const chapters: Chapter[] = []
  for (let from = 1; from <= pages; from += PAGES_PER_CHUNK) {
    const to = Math.min(from + PAGES_PER_CHUNK - 1, pages)
    chapters.push({
      file: `p${from}-${to}`,
      title: `Pages ${from}–${to}`,
      crumb: null,
      headings: [],
      words: (to - from + 1) * 300
    })
  }
  return chapters
}

/**
 * One chapter's text, as HTML paragraphs the renderer can display and speak.
 *
 * Furniture removal runs across the whole range at once: a running head is
 * recognised by repeating, which cannot be seen one page at a time.
 */
export async function pdfChapter(path: string, file: string): Promise<string | null> {
  const book = await openPdf(path)
  const range = book.ranges[file]
  if (!range) return null

  if (!book.digital) {
    return (
      '<p class="notice">This PDF has no text layer. It is a scan, and reading it aloud ' +
      'needs the OCR pipeline, which is not built yet.</p>'
    )
  }

  const pages: string[][] = []
  for (let n = range.from; n <= range.to; n += 1) {
    const content = await (await book.document.getPage(n)).getTextContent()
    pages.push(assemblePage(content.items))
  }

  const repeated = repeatedLines(pages)
  const html: string[] = []

  pages.forEach((page, at) => {
    const kept = cleanPage(page, repeated)
    if (kept.length === 0) return
    // The page number is a landmark for someone following along on paper, and
    // it is marked so the speech walk skips it rather than reading it out.
    html.push(`<p class="page-mark" data-speak="no">Page ${range.from + at}</p>`)
    for (const paragraph of kept) html.push(`<p>${escapeHtml(paragraph)}</p>`)
  })

  return html.join('\n') || '<p class="notice">No text on these pages.</p>'
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
