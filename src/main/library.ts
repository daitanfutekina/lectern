import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseManifest, splitFrontMatter } from '@shared/manifest'
import { extractHeadings, countWords } from '@shared/outline'
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

/** Scan the root. One unreadable book must not cost the whole library. */
export async function scanLibrary(root: string): Promise<LibraryIndex> {
  const booksPath = join(root, BOOKS_DIR)
  const scannedAt = Date.now()

  if (!(await isDirectory(booksPath))) return { root, scannedAt, books: [] }

  const ids = (await readdir(booksPath)).sort()
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return await readBook(booksPath, id)
      } catch {
        return null
      }
    })
  )

  return { root, scannedAt, books: results.filter((book): book is Book => book !== null) }
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

/** Read a chapter's raw Markdown. The renderer turns it into HTML. */
export async function readChapterSource(book: Book, file: string): Promise<string | null> {
  // The file must be one the scan already found, or a crafted name could read
  // anything on disk. Membership in the book's own chapter list is the check.
  if (!book.chapters.some((chapter) => chapter.file === file)) return null
  return readIfPresent(join(book.path, file))
}
