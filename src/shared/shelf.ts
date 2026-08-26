import type { Book, DocumentFormat } from './library'

/**
 * The shelf: how a library is presented before anything is opened.
 *
 * SPEC section 3. A grid of covers rather than a list, because a book is
 * recognised by its cover long before its title is read, and because the
 * question the home page answers is "which of these do I want" rather than
 * "what is in this one".
 */

export interface ShelfEntry {
  readonly id: string
  readonly title: string
  readonly format: DocumentFormat
  /** Ribbon text: short enough to sit in a corner. */
  readonly badge: string
  readonly chapters: number
  readonly words: number
  /** 0 to 1, or null when the book has not been opened. */
  readonly progress: number | null
  /** Data URL of the cover, filled in asynchronously. */
  readonly cover: string | null
}

export const FORMAT_BADGE: Readonly<Record<DocumentFormat, string>> = {
  markdown: 'MD',
  html: 'HTML',
  epub: 'EPUB',
  pdf: 'PDF'
}

/**
 * Colour per format, for the ribbon and for the fallback cover.
 *
 * A generated cover has to be told apart at a glance from the ten beside it, and
 * colour does that faster than a title does.
 */
export const FORMAT_COLOUR: Readonly<Record<DocumentFormat, string>> = {
  markdown: '#58a6ff',
  html: '#bc8cff',
  epub: '#56d364',
  pdf: '#f85149'
}

export function shelfEntry(book: Book, progress: number | null): ShelfEntry {
  return {
    id: book.id,
    title: book.title,
    format: book.format,
    badge: FORMAT_BADGE[book.format],
    chapters: book.chapters.length,
    words: book.chapters.reduce((total, chapter) => total + chapter.words, 0),
    progress,
    cover: null
  }
}

/**
 * Initials for a generated cover.
 *
 * Two or three letters from the significant words. "The Physical Game" gives
 * "PG", not "TPG" -- a leading article carries no recognition.
 */
export function initials(title: string): string {
  const skip = new Set(['a', 'an', 'the', 'of', 'and', 'to', 'in', 'for', 'with', 'on'])
  const words = title
    .split(/[\s\-–—:]+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ''))
    .filter((word) => word.length > 0 && !skip.has(word.toLowerCase()))

  if (words.length === 0) return title.slice(0, 2).toUpperCase() || '?'
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase()
  return words
    .slice(0, 3)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase()
}

/** Compact size for the card: "6 chapters · 12k words". */
export function shelfSubtitle(entry: ShelfEntry): string {
  const chapters = `${entry.chapters} chapter${entry.chapters === 1 ? '' : 's'}`
  if (entry.words <= 0) return chapters
  const words =
    entry.words >= 10_000
      ? `${Math.round(entry.words / 1000)}k words`
      : `${entry.words.toLocaleString()} words`
  return `${chapters} · ${words}`
}


/* ── Sorting ───────────────────────────────────────────────────────── */

export type ShelfSort = 'added' | 'read' | 'title' | 'format'

export const SORT_LABELS: Readonly<Record<ShelfSort, string>> = {
  added: 'Recently added',
  read: 'Recently read',
  title: 'Title',
  format: 'File type'
}

export const SORT_ORDER: readonly ShelfSort[] = ['added', 'read', 'title', 'format']

export function isShelfSort(value: unknown): value is ShelfSort {
  return typeof value === 'string' && (SORT_ORDER as readonly string[]).includes(value)
}

export interface SortFacts {
  /** When the document joined the library. Zero for books that were always there. */
  readonly addedAt: number
  /** When it was last opened. Zero for never. */
  readonly readAt: number
}

/**
 * Order the shelf.
 *
 * Ties fall back to title in every mode, so the grid never reshuffles between
 * two renders just because two books share a timestamp -- a shelf that moves
 * under the cursor is worse than one sorted slightly differently than expected.
 */
export function sortShelf(
  entries: readonly ShelfEntry[],
  sort: ShelfSort,
  facts: (id: string) => SortFacts
): ShelfEntry[] {
  const byTitle = (a: ShelfEntry, b: ShelfEntry): number =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })

  return [...entries].sort((a, b) => {
    switch (sort) {
      case 'added':
        return facts(b.id).addedAt - facts(a.id).addedAt || byTitle(a, b)
      case 'read':
        return facts(b.id).readAt - facts(a.id).readAt || byTitle(a, b)
      case 'format':
        return a.format.localeCompare(b.format) || byTitle(a, b)
      case 'title':
        return byTitle(a, b)
    }
  })
}
