import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { assemblePage, cleanPage, repeatedLines, type TextItem } from '@shared/pdf-text'
import { answerPdfPasswordChallenge, type PdfPasswordAttempt } from '@shared/pdf-interaction'
import type { BookPart, Chapter, PageSection } from '@shared/library'

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
  /** Resolves a named destination -- `dest` as a string rather than an array. */
  getDestination: (name: string) => Promise<unknown[] | null>
  destroy: () => Promise<void>
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
  /** Named chapter groups the outline declares, empty when it declares none. */
  readonly parts: readonly BookPart[]
  /** First and last page, inclusive and 1-based, per chapter file id. */
  readonly ranges: Readonly<Record<string, { from: number; to: number }>>
  readonly digital: boolean
  readonly pages: number
}

const opened = new Map<string, PdfBook>()
const passwords = new Map<string, string>()
type PasswordPrompt = (path: string, attempt: PdfPasswordAttempt) => Promise<string | null>
let passwordPrompt: PasswordPrompt | null = null

/** Passwords live only in this process and disappear when the app exits. */
export function configurePdfPasswordPrompt(prompt: PasswordPrompt): void {
  passwordPrompt = prompt
}

export function pdfPassword(path: string): string | null {
  return passwords.get(path) ?? null
}

/**
 * Let go of a document that has left the library.
 *
 * The session cache holds the parsed file, and for a thousand-page textbook
 * that is a good deal of memory to keep for a book the reader just removed.
 */
export function closePdf(path: string): void {
  const book = opened.get(path)
  passwords.delete(path)
  if (!book) return
  opened.delete(path)
  void book.document.destroy().catch(() => {
    // Already torn down, or never finished opening; either way it is gone.
  })
}

interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>
  onPassword: ((updatePassword: (password: string) => void, reason: number) => void) | null
  destroy: () => Promise<void>
}

function pdfjs(): { getDocument: (options: unknown) => PdfLoadingTask } {
  return require('pdfjs-dist/legacy/build/pdf.mjs')
}

/** The PDF's own bytes, for the renderer to rasterise a scan. */
export async function pdfBytes(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path))
  } catch {
    return null
  }
}

/** Page range of a chapter, for the OCR queue. */
export async function pdfRange(
  path: string,
  file: string
): Promise<{ from: number; to: number } | null> {
  const book = await openPdf(path)
  return book.ranges[file] ?? null
}

export async function isScanned(path: string): Promise<boolean> {
  return !(await openPdf(path)).digital
}

export async function openPdf(path: string): Promise<PdfBook> {
  const cached = opened.get(path)
  if (cached) return cached

  const data = new Uint8Array(await readFile(path))
  let acceptedPassword = passwords.get(path) ?? null
  const task = pdfjs().getDocument({
    data,
    useSystemFonts: true,
    ...(acceptedPassword === null ? {} : { password: acceptedPassword })
  })
  if (passwordPrompt) {
    task.onPassword = (updatePassword, reason) => {
      void answerPdfPasswordChallenge(
        reason,
        (attempt) => passwordPrompt!(path, attempt),
        (password) => {
          acceptedPassword = password
          updatePassword(password)
        },
        () => {
          void task.destroy()
        }
      )
    }
  }
  const document = await task.promise
  if (acceptedPassword !== null) passwords.set(path, acceptedPassword)

  // Sample rather than scan: on a 948-page book, reading every page to decide
  // whether it has text would cost more than reading the part being read.
  const digital = await hasTextLayer(document)

  const ranges: Record<string, { from: number; to: number }> = {}
  const outlined = await outlineChapters(document)
  const chapters = outlined?.chapters ?? chunkChapters(document.numPages)
  const parts = outlined?.parts ?? []
  for (const chapter of chapters) {
    const parsed = /^p(\d+)-(\d+)$/.exec(chapter.file)
    if (parsed) ranges[chapter.file] = { from: Number(parsed[1]), to: Number(parsed[2]) }
  }

  const book: PdfBook = { document, chapters, parts, ranges, digital, pages: document.numPages }
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
async function outlineChapters(
  document: PdfDocument
): Promise<{ chapters: Chapter[]; parts: BookPart[] } | null> {
  let outline: OutlineEntry[] | null = null
  try {
    outline = await document.getOutline()
  } catch {
    return null
  }
  if (!outline || outline.length < 2) return null

  const starts: {
    title: string
    page: number
    sections: string[]
    pageSections: PageSection[]
    part: string | null
  }[] = []

  const record = async (entry: OutlineEntry, part: string | null): Promise<void> => {
    const page = await pageOf(document, entry.dest)
    if (page === null) return

    // The level below is the chapter's sections. The chapter list stays flat
    // -- a three-deep list is one nobody can scan -- but discarding the
    // children entirely left every PDF in the library without a section list,
    // however carefully the publisher had built one.
    const children = (entry.items ?? []).filter((item) => cleanTitle(item.title))
    const pageSections: PageSection[] = []
    for (const child of children) {
      // A title with no page is still a section worth searching for; it just
      // has nowhere to jump to, so it stays in `sections` and not here.
      const at = await pageOf(document, child.dest)
      if (at !== null) pageSections.push({ title: cleanTitle(child.title), page: at })
    }

    starts.push({
      title: cleanTitle(entry.title) || `Page ${page}`,
      page,
      sections: children.map((item) => cleanTitle(item.title)),
      pageSections,
      part
    })
  }

  for (const entry of outline) {
    if (isPart(entry)) {
      const title = cleanTitle(entry.title)
      for (const child of entry.items ?? []) await record(child, title)
    } else {
      await record(entry, null)
    }
  }

  starts.sort((a, b) => a.page - b.page)
  if (starts.length < 2) return null

  const chapters = starts.map((start, at) => {
    const to = at + 1 < starts.length ? (starts[at + 1]?.page ?? document.numPages) - 1 : document.numPages
    const from = start.page
    return {
      file: `p${from}-${Math.max(from, to)}`,
      title: start.title,
      crumb: null,
      headings: start.sections,
      pageSections: start.pageSections,
      words: Math.max(1, (Math.max(from, to) - from + 1)) * 300
    }
  })

  // Parts in reading order, each naming the chapters it covers. The sidebar
  // already knows how to fold a book up by these.
  const parts: { title: string; chapters: string[] }[] = []
  for (const [at, start] of starts.entries()) {
    if (!start.part) continue
    const file = chapters[at]?.file
    if (!file) continue
    const last = parts[parts.length - 1]
    if (last && last.title === start.part) last.chapters.push(file)
    else parts.push({ title: start.part, chapters: [file] })
  }

  return { chapters, parts }
}

/**
 * Whether an outline entry is a part rather than a chapter.
 *
 * A part's children are chapters and have sections of their own; a chapter's
 * children are sections and are leaves. So: most children having children
 * means a part. Taking only the top level made "Part I" a single 637-page
 * chapter of Computer Systems: A Programmer's Perspective and buried chapters
 * 2 to 6 inside it, while flattening a level unconditionally would have
 * dissolved the 22 real chapters of Computer Science: An Overview into a
 * hundred sections.
 *
 * The majority is what makes it hold: that book's Chapter 1 has ten children
 * of which four carry subsections, and it is a chapter.
 */
function isPart(entry: OutlineEntry): boolean {
  const children = entry.items ?? []
  if (children.length === 0) return false
  const nested = children.filter((child) => (child.items ?? []).length > 0).length
  return nested * 2 > children.length
}

/**
 * An outline title as it should read in a list.
 *
 * Real outlines carry hard line breaks where the printed heading wrapped --
 * `6\rWeighted Graph Algorithms` -- and a bare carriage return renders as
 * nothing at all, running the number into the word after it.
 */
function cleanTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim()
}

/**
 * The page an outline entry points at.
 *
 * A destination is either an array whose first element is a page reference, or
 * the *name* of one recorded in the document's name tree. Reading only the
 * array form silently dropped every entry of the second kind, and a book that
 * names its destinations -- LaTeX writes `chapter.1`, `part.2` -- lost its
 * whole chapter list: The Algorithm Design Manual kept three of six entries and
 * the survivors spanned pages 10 to 720, which is one chapter for the book.
 */
async function pageOf(document: PdfDocument, dest: unknown): Promise<number | null> {
  try {
    const resolved = typeof dest === 'string' ? await document.getDestination(dest) : dest
    const ref = Array.isArray(resolved) ? resolved[0] : null
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

  // A scan carries no text to return. The renderer recognises it and fills the
  // chapter in as pages complete, so the marker tells it where to start rather
  // than apologising to the reader.
  if (!book.digital) {
    return `<p class="notice" data-scan="${range.from}-${range.to}">Reading this scan…</p>`
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
