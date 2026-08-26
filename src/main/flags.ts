import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  EMPTY_FLAGS,
  flagsToMarkdown,
  parseFlags,
  sortFlags,
  type Flag,
  type FlagStore
} from '@shared/flags'
import type { LibraryIndex } from '@shared/library'

/**
 * Flagged passages, stored and exported. SPEC section 8.
 *
 * Two files are written, deliberately. `flags.json` is the application's own
 * record. `FLAGGED.md` is the handoff -- a document meant to be opened by
 * whoever is editing the book, without this application and without knowing
 * anything about its formats.
 *
 * Writing both on every change is cheap at this scale and means the Markdown is
 * never stale. A handoff file that lags behind is worse than none, because it
 * will be trusted.
 */

let root = ''
let store: FlagStore = EMPTY_FLAGS
let loaded = false

export function configureFlags(libraryRoot: string): void {
  root = libraryRoot
  loaded = false
  store = EMPTY_FLAGS
}

const jsonPath = (): string => join(root, '.library', 'flags.json')
const markdownPath = (): string => join(root, 'FLAGGED.md')

export async function loadFlags(): Promise<FlagStore> {
  if (loaded) return store
  try {
    store = parseFlags(await readFile(jsonPath(), 'utf8'))
  } catch {
    store = EMPTY_FLAGS
  }
  loaded = true
  return store
}

export function getFlags(): FlagStore {
  return store
}

/**
 * Persist, and re-export the handoff document.
 *
 * The export needs chapter titles, which only the library index knows, so it is
 * passed in rather than looked up here -- this module has no business scanning
 * the disk for books.
 */
async function persist(index: LibraryIndex | null): Promise<void> {
  try {
    await mkdir(join(root, '.library'), { recursive: true })
    await writeFile(jsonPath(), JSON.stringify({ flags: store.flags }, null, 2), 'utf8')

    const titleOf = (bookId: string, chapter: string): string => {
      const book = index?.books.find((entry) => entry.id === bookId)
      const found = book?.chapters.find((entry) => entry.file === chapter)
      if (book && found) return `${book.title} — ${found.title}`
      return chapter || bookId || 'Unknown chapter'
    }

    await writeFile(markdownPath(), flagsToMarkdown(sortFlags(store.flags), titleOf), 'utf8')
  } catch {
    // A flag that cannot be written is lost, which is bad, but throwing here
    // would take down the reading session that produced it, which is worse.
  }
}

export async function addFlag(flag: Flag, index: LibraryIndex | null): Promise<FlagStore> {
  await loadFlags()
  store = { flags: [...store.flags, flag] }
  await persist(index)
  return store
}

export async function removeFlag(id: string, index: LibraryIndex | null): Promise<FlagStore> {
  await loadFlags()
  store = { flags: store.flags.filter((flag) => flag.id !== id) }
  await persist(index)
  return store
}

/**
 * The library map, written where it can be read without this application.
 *
 * Finding what a library already covers currently means walking 220 files. One
 * small file naming every book, chapter and heading makes that a single read --
 * which is the difference between "have I covered eigenvalues" being a question
 * worth asking and one that costs more than guessing.
 */
export async function exportIndex(index: LibraryIndex): Promise<string | null> {
  const lines = [
    '# Library index',
    '',
    `${index.books.length} books, generated ${new Date(index.scannedAt).toISOString().slice(0, 10)}.`,
    'Chapter titles and section headings only, so the whole library can be read',
    'without opening any of it.',
    ''
  ]

  for (const book of index.books) {
    lines.push(`## ${book.title}`, '', `\`${book.id}\` · ${book.format} · ${book.chapters.length} chapters`, '')
    for (const chapter of book.chapters) {
      lines.push(`### ${chapter.title}`, '', `\`${chapter.file}\` · ${chapter.words.toLocaleString()} words`, '')
      for (const heading of chapter.headings.slice(0, 40)) lines.push(`- ${heading}`)
      if (chapter.headings.length > 40) lines.push(`- …${chapter.headings.length - 40} more`)
      if (chapter.headings.length > 0) lines.push('')
    }
  }

  const path = join(root, 'INDEX.md')
  try {
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
    return path
  } catch {
    return null
  }
}
