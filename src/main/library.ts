import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseManifest, splitFrontMatter } from '@shared/manifest'
import { extractHeadings, countWords } from '@shared/outline'
import { epubDocument, openEpub } from './epub'
import { openPdf, pdfChapter } from './pdf'
import { livingDocuments } from './documents'
import type { Book, Chapter, DocumentFormat, LibraryIndex } from '@shared/library'

/**
 * Scanning the library root into an index. SPEC section 7.
 *
 * The index is derived, never authoritative: the files on disk are the truth,
 * and a corrupt or missing index must only cost a rescan. Nothing here may
 * refuse to produce a library because one book is malformed.
 */

export const DEFAULT_ROOT = 'C:\\Library'

const BOOKS_DIR = 'books'
const EPUBS_DIR = 'epubs'
const PDFS_DIR = 'pdfs'
const STATE_DIR = '.library'
const INDEX_FILE = 'index.json'

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * A book's format is decided by what is in it, not by what it claims. Markdown
 * wins over HTML where both are present, which is what makes conversion safe to
 * do in place: drop the `.md` files in and the book switches over.
 */
function formatOf(files: string[]): DocumentFormat | null {
  if (files.some((f) => f.endsWith('.md'))) return 'markdown'
  if (files.some((f) => f.endsWith('.html'))) return 'html'
  if (files.some((f) => f.endsWith('.epub'))) return 'epub'
  if (files.some((f) => f.endsWith('.pdf'))) return 'pdf'
  return null
}

async function readChapter(bookPath: string, file: string): Promise<Chapter> {
  const source = (await readIfPresent(join(bookPath, file))) ?? ''
  const { matter, body } = splitFrontMatter(source)

  return {
    file,
    // Front matter first, then the first heading, then the file name. Every
    // book in the library has at least one of the three.
    title: matter.title ?? extractHeadings(body)[0] ?? file.replace(/\.[^.]+$/, ''),
    crumb: matter.crumb,
    headings: extractHeadings(body),
    words: countWords(body)
  }
}

async function readBook(booksPath: string, id: string): Promise<Book | null> {
  const path = join(booksPath, id)
  if (!(await isDirectory(path))) return null

  const entries = await readdir(path)
  const format = formatOf(entries)
  if (!format) return null

  const manifest = parseManifest((await readIfPresent(join(path, 'book.yml'))) ?? '')

  // Manifest order is the order the book was written to be read in. Falling
  // back to a sort is a degraded mode, not a default: it puts chapter 10 before
  // chapter 2, which is wrong but still readable.
  const present = new Set(entries)
  const ordered = manifest.chapters.filter((file) => present.has(file))
  const listed = new Set(ordered)
  const remaining = entries
    .filter((f) => f.endsWith('.md') && !listed.has(f) && f !== manifest.index)
    .sort()

  const files = [...ordered, ...remaining]
  if (files.length === 0) return null

  const chapters = await Promise.all(files.map((file) => readChapter(path, file)))

  return {
    id,
    title: manifest.title ?? id,
    format,
    path,
    chapters,
    macros: manifest.macros
  }
}

/**
 * A single-file book: one EPUB or one PDF.
 *
 * Folder books and file books differ only here. Everything downstream sees the
 * same shape -- an id, a title, an ordered list of chapters -- which is what
 * lets one reading surface serve four formats.
 */
async function readFileBook(dir: string, name: string, format: DocumentFormat): Promise<Book | null> {
  const path = join(dir, name)
  const id = `${format}:${name}`

  if (format === 'epub') {
    const book = await openEpub(path)
    if (book.chapters.length === 0) return null
    return {
      id,
      title: book.structure.title ?? name.replace(/\.epub$/i, ''),
      format,
      path,
      chapters: book.chapters,
      macros: {}
    }
  }

  const book = await openPdf(path)
  if (book.chapters.length === 0) return null
  return {
    id,
    // A scan is listed and openable, and says what it needs. Hiding it would
    // leave the reader wondering why a file they can see is not in the library.
    title: `${name.replace(/\.pdf$/i, '')}${book.digital ? '' : ' (scanned)'}`,
    format,
    path,
    chapters: book.chapters,
    macros: {}
  }
}

async function scanFileBooks(
  root: string,
  dir: string,
  extension: string,
  format: DocumentFormat
): Promise<Book[]> {
  const path = join(root, dir)
  if (!(await isDirectory(path))) return []

  const names = (await readdir(path)).filter((n) => n.toLowerCase().endsWith(extension)).sort()
  const books = await Promise.all(
    names.map(async (name) => {
      try {
        return await readFileBook(path, name, format)
      } catch {
        // A DRM-protected or corrupt file must not cost the rest of the shelf.
        return null
      }
    })
  )
  return books.filter((book): book is Book => book !== null)
}

/**
 * Documents the reader added, read where they live.
 *
 * These are referenced rather than copied, so the id has to survive the file
 * being somewhere outside the library entirely.
 */
async function scanAddedDocuments(): Promise<Book[]> {
  const entries = await livingDocuments()
  const books = await Promise.all(
    entries.map(async (entry) => {
      // Both separators: a Windows path split on `/` alone comes back whole,
      // and the book's id then carries its entire absolute path.
      const name = entry.path.split(/[\\/]/).pop() ?? entry.path
      const format: DocumentFormat = name.toLowerCase().endsWith('.epub') ? 'epub' : 'pdf'
      try {
        return await readFileBook(entry.path.slice(0, entry.path.length - name.length), name, format)
      } catch {
        return null
      }
    })
  )
  return books.filter((book): book is Book => book !== null)
}

/** Scan the root. One unreadable book must not cost the whole library. */
export async function scanLibrary(root: string): Promise<LibraryIndex> {
  const booksPath = join(root, BOOKS_DIR)
  const scannedAt = Date.now()

  const folderBooks = (await isDirectory(booksPath))
    ? await Promise.all(
        (await readdir(booksPath)).sort().map(async (id) => {
          try {
            return await readBook(booksPath, id)
          } catch {
            return null
          }
        })
      )
    : []

  const [epubs, pdfs, added] = await Promise.all([
    scanFileBooks(root, EPUBS_DIR, '.epub', 'epub'),
    scanFileBooks(root, PDFS_DIR, '.pdf', 'pdf'),
    scanAddedDocuments()
  ])

  return {
    root,
    scannedAt,
    books: [
      ...folderBooks.filter((book): book is Book => book !== null),
      ...epubs,
      ...pdfs,
      ...added
    ]
  }
}

/**
 * Cache the index so the library list paints immediately on the next launch.
 * A write failure is not worth reporting: the index is derived, and the only
 * cost of losing it is a rescan nobody will notice.
 */
export async function saveIndex(index: LibraryIndex): Promise<void> {
  try {
    const dir = join(index.root, STATE_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, INDEX_FILE), JSON.stringify(index, null, 2), 'utf8')
  } catch {
    // Deliberately ignored, see above.
  }
}

/**
 * A chapter's content, in whatever form its format produces.
 *
 * Markdown books return Markdown; the others return HTML. The renderer decides
 * what to do with it from the book's format, which is the one place the four
 * formats are still distinguishable.
 */
export async function readChapterSource(book: Book, file: string): Promise<string | null> {
  // The file must be one the scan already found, or a crafted name could read
  // anything on disk. Membership in the book's own chapter list is the check.
  if (!book.chapters.some((chapter) => chapter.file === file)) return null

  if (book.format === 'epub') return epubDocument(book.path, file)
  if (book.format === 'pdf') return pdfChapter(book.path, file)
  return readIfPresent(join(book.path, file))
}
