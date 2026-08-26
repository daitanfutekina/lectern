import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  EMPTY_BOOK,
  EMPTY_PROGRESS,
  advance,
  parseProgress,
  type Bookmark,
  type ChapterProgress,
  type LibraryProgress,
  type ReadingPosition
} from '@shared/progress'

/**
 * Reading state on disk. SPEC section 7: JSON, not SQLite -- at dozens of books
 * an in-memory object is entirely adequate, and a native module would mean the
 * packaging exposure that comes with one.
 *
 * The renderer proposes changes and this owns them, the same shape as the
 * library index: one side does storage, the other does display.
 */

const STATE_DIR = '.library'
const PROGRESS_FILE = 'progress.json'

/**
 * Writes are debounced because scrolling produces a position on every frame.
 * Long enough to collapse a scroll into one write, short enough that closing
 * the window a second after reading still saves.
 */
const WRITE_DELAY_MS = 800

let state: LibraryProgress = EMPTY_PROGRESS
let root = ''
let loaded = false
let timer: NodeJS.Timeout | null = null
let writing: Promise<void> = Promise.resolve()

function path(): string {
  return join(root, STATE_DIR, PROGRESS_FILE)
}

export async function loadProgress(libraryRoot: string): Promise<LibraryProgress> {
  if (loaded && root === libraryRoot) return state
  root = libraryRoot
  loaded = true
  try {
    state = parseProgress(await readFile(path(), 'utf8'))
  } catch {
    // No file yet, or an unreadable one. Either way, start fresh rather than
    // refusing to open the library.
    state = EMPTY_PROGRESS
  }
  return state
}

/**
 * Write through a temporary file and rename over the target.
 *
 * A crash midway through writing progress.json would otherwise leave a
 * truncated file, and the next launch would lose every reading position in the
 * library. Rename is atomic on the same volume, so the file is either the old
 * one or the new one and never half of each.
 */
async function persist(): Promise<void> {
  const target = path()
  const temporary = `${target}.tmp`
  try {
    await mkdir(join(root, STATE_DIR), { recursive: true })
    await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8')
    await rename(temporary, target)
  } catch {
    // Losing a position is a small cost and there is nothing useful to do about
    // a failed write here; the next one will most likely succeed.
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    writing = writing.then(persist)
  }, WRITE_DELAY_MS)
}

/** Flush immediately, for shutdown -- the debounce must not eat the last write. */
export async function flushProgress(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
    writing = writing.then(persist)
  }
  await writing
}

export function getProgress(): LibraryProgress {
  return state
}

function book(bookId: string) {
  return state.books[bookId] ?? EMPTY_BOOK
}

function update(bookId: string, next: Partial<ReturnType<typeof book>>): void {
  state = {
    ...state,
    lastBook: bookId,
    books: { ...state.books, [bookId]: { ...book(bookId), ...next } }
  }
  schedule()
}

export function recordPosition(
  bookId: string,
  file: string,
  position: ReadingPosition,
  blocks: number
): ChapterProgress {
  const current = book(bookId)
  const next = advance(current.chapters[file] ?? null, position, blocks, Date.now())
  update(bookId, { lastChapter: file, chapters: { ...current.chapters, [file]: next } })
  return next
}

/** Note which chapter is open without disturbing its recorded position. */
export function recordOpen(bookId: string, file: string): void {
  update(bookId, { lastChapter: file })
}

export function addBookmark(bookId: string, bookmark: Bookmark): readonly Bookmark[] {
  const bookmarks = [...book(bookId).bookmarks, bookmark]
  update(bookId, { bookmarks })
  return bookmarks
}

export function removeBookmark(bookId: string, id: string): readonly Bookmark[] {
  const bookmarks = book(bookId).bookmarks.filter((entry) => entry.id !== id)
  update(bookId, { bookmarks })
  return bookmarks
}
