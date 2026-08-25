/**
 * The library's shape, shared by all three processes.
 *
 * SPEC section 7. This is data, not behaviour: it crosses the IPC boundary by
 * structured clone, so everything here must survive serialisation. No classes,
 * no methods, no Date objects that anyone relies on being a Date.
 */

/** What kind of thing a document is, which decides the adapter that reads it. */
export type DocumentFormat = 'markdown' | 'html' | 'epub' | 'pdf'

export interface Chapter {
  /** File name within the book folder, e.g. `linalg_ch5_eigenvalues.md`. */
  readonly file: string
  /** Title from front matter, falling back to the file name. */
  readonly title: string
  /** Breadcrumb from front matter, e.g. `Linear Algebra - Chapter 5`. */
  readonly crumb: string | null
  /** Section headings, in document order. This is what makes the index searchable. */
  readonly headings: readonly string[]
  readonly words: number
}

export interface Book {
  /** Folder name, and the stable identity used everywhere else. */
  readonly id: string
  readonly title: string
  readonly format: DocumentFormat
  /** Absolute path to the book folder. */
  readonly path: string
  readonly chapters: readonly Chapter[]
  /**
   * Book-scoped LaTeX macro definitions. SPEC section 4 and FINDINGS: these were
   * defined per-chapter and inconsistently in the source books, and an
   * unregistered macro is unspeakable as well as unrenderable.
   */
  readonly macros: Readonly<Record<string, string>>
}

export interface LibraryIndex {
  /** Absolute path to the library root. */
  readonly root: string
  /** Milliseconds since the epoch. A number, because Date does not survive IPC intact. */
  readonly scannedAt: number
  readonly books: readonly Book[]
}

export const EMPTY_INDEX: LibraryIndex = { root: '', scannedAt: 0, books: [] }

/** Total chapters across the library, for the empty-state and the header count. */
export function chapterCount(index: LibraryIndex): number {
  return index.books.reduce((total, book) => total + book.chapters.length, 0)
}

export function findBook(index: LibraryIndex, id: string): Book | null {
  return index.books.find((book) => book.id === id) ?? null
}

export function findChapter(book: Book, file: string): Chapter | null {
  return book.chapters.find((chapter) => chapter.file === file) ?? null
}

/**
 * The chapter after `file`, or null at the end of the book. Order comes from the
 * manifest rather than from sorting, because alphabetical order puts chapter 10
 * before chapter 2.
 */
export function nextChapter(book: Book, file: string): Chapter | null {
  const at = book.chapters.findIndex((chapter) => chapter.file === file)
  return at >= 0 ? (book.chapters[at + 1] ?? null) : null
}

export function previousChapter(book: Book, file: string): Chapter | null {
  const at = book.chapters.findIndex((chapter) => chapter.file === file)
  return at > 0 ? (book.chapters[at - 1] ?? null) : null
}
