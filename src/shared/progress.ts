/**
 * Reading position, bookmarks, and how far through a chapter you are.
 *
 * SPEC section 7. Pure by contract: everything here takes block geometry as
 * plain numbers, so the anchoring maths is testable without a window.
 *
 * A position is deliberately *not* a scroll offset in pixels. Pixels are a
 * property of one window at one size with one font, and every one of those can
 * change between closing the app and opening it again -- resize the window and
 * a pixel offset silently lands you in a different paragraph. Anchoring to a
 * block index with a fraction into that block survives all three.
 */

export interface ReadingPosition {
  /** Index of the top-level block at the top of the viewport. */
  readonly block: number
  /** How far into that block, 0 to 1. */
  readonly within: number
}

export const START: ReadingPosition = { block: 0, within: 0 }

export interface ChapterProgress {
  readonly position: ReadingPosition
  /** Furthest block reached, which is what "how much have I read" means. */
  readonly furthest: number
  readonly blocks: number
  readonly updatedAt: number
}

export interface Bookmark {
  readonly id: string
  readonly chapter: string
  readonly position: ReadingPosition
  readonly label: string
  readonly createdAt: number
}

export interface BookProgress {
  readonly lastChapter: string | null
  readonly chapters: Readonly<Record<string, ChapterProgress>>
  readonly bookmarks: readonly Bookmark[]
}

export interface LibraryProgress {
  readonly lastBook: string | null
  readonly books: Readonly<Record<string, BookProgress>>
}

export const EMPTY_PROGRESS: LibraryProgress = { lastBook: null, books: {} }

export const EMPTY_BOOK: BookProgress = { lastChapter: null, chapters: {}, bookmarks: [] }

const clamp = (value: number, min: number, max: number): number =>
  max < min ? min : Math.min(Math.max(value, min), max)

/**
 * Which block is at the top of the viewport, and how far into it.
 *
 * `tops` is each block's offset from the top of the content, ascending. The
 * search takes the last block that starts at or above the scroll position, so a
 * scroll landing mid-block anchors to that block rather than the next one.
 */
export function positionAt(tops: readonly number[], scrollTop: number): ReadingPosition {
  if (tops.length === 0) return START

  let block = 0
  for (let index = 0; index < tops.length; index += 1) {
    if ((tops[index] ?? 0) <= scrollTop) block = index
    else break
  }

  const start = tops[block] ?? 0
  // The next block's start is this one's end. For the last block there is no
  // next, so the fraction stays 0 rather than dividing by nothing.
  const end = tops[block + 1] ?? start
  const height = end - start
  const within = height > 0 ? clamp((scrollTop - start) / height, 0, 1) : 0

  return { block, within }
}

/**
 * Where to scroll to restore a position. Out-of-range block indices clamp
 * rather than fail: a chapter that was edited between sessions should reopen
 * near where you were, not at the top.
 */
export function scrollTopFor(tops: readonly number[], position: ReadingPosition): number {
  if (tops.length === 0) return 0

  const block = clamp(Math.round(position.block), 0, tops.length - 1)
  const start = tops[block] ?? 0
  const end = tops[block + 1] ?? start
  const within = clamp(position.within, 0, 1)

  return Math.round(start + (end - start) * within)
}

/** How far through a chapter, 0 to 1, by furthest block reached. */
export function fractionRead(progress: ChapterProgress | null): number {
  if (!progress || progress.blocks <= 1) return progress ? 1 : 0
  return clamp((progress.furthest + 1) / progress.blocks, 0, 1)
}

/**
 * Where the reader is *now*, 0 to 1 -- not how much of the chapter they have
 * seen.
 *
 * Distinct from `fractionRead` on purpose, and the two answer different
 * questions. Coverage only grows, so a chapter skimmed to the bottom keeps a
 * full bar however far back you scroll afterwards; that is the honest answer to
 * "how much of this book have I read", which is what the shelf asks. It is the
 * wrong answer beside an open chapter, where the useful question is "where am I
 * in this", and a bar pinned high because of one earlier skim answers nothing.
 *
 * The `✓` stays on coverage. A finished chapter reopened at the top is still
 * finished; its bar just says you are at the top of it.
 */
export function fractionAt(progress: ChapterProgress | null): number {
  if (!progress || progress.blocks <= 0) return 0
  if (progress.blocks === 1) return 1

  const { block, within } = progress.position
  // Blocks are indexed 0..blocks-1, so the last block is the end of the
  // chapter rather than one block short of it.
  return clamp((block + within) / (progress.blocks - 1), 0, 1)
}

/** A chapter counts as finished once the last block has been reached. */
export function isFinished(progress: ChapterProgress | null): boolean {
  return progress !== null && progress.blocks > 0 && progress.furthest >= progress.blocks - 1
}

/** The progress values a sidebar redraw can actually make visible. */
export function sidebarProgressKey(progress: ChapterProgress | null, section: number): string {
  const percent = progress ? Math.round(fractionAt(progress) * 100) : 'new'
  return [percent, isFinished(progress), section].join(':')
}

/**
 * Advance a chapter's progress. `furthest` only ever grows: scrolling back to
 * re-read something must not make the book look less read than it is.
 */
export function advance(
  previous: ChapterProgress | null,
  position: ReadingPosition,
  blocks: number,
  now: number
): ChapterProgress {
  return {
    position,
    furthest: Math.max(previous?.furthest ?? 0, position.block),
    blocks,
    updatedAt: now
  }
}

/** Bookmark identity. Time plus a random suffix, because two can share a millisecond. */
export function bookmarkId(now: number, random: number): string {
  return `${now.toString(36)}-${Math.floor(random * 1e6).toString(36)}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

function parsePosition(value: unknown): ReadingPosition {
  if (!isRecord(value)) return START
  return {
    block: Math.max(0, Math.round(num(value['block'], 0))),
    within: clamp(num(value['within'], 0), 0, 1)
  }
}

function parseChapter(value: unknown): ChapterProgress | null {
  if (!isRecord(value)) return null
  const blocks = Math.max(0, Math.round(num(value['blocks'], 0)))
  return {
    position: parsePosition(value['position']),
    furthest: Math.max(0, Math.round(num(value['furthest'], 0))),
    blocks,
    updatedAt: num(value['updatedAt'], 0)
  }
}

function parseBookmark(value: unknown): Bookmark | null {
  if (!isRecord(value)) return null
  const id = str(value['id'])
  const chapter = str(value['chapter'])
  if (!id || !chapter) return null
  return {
    id,
    chapter,
    position: parsePosition(value['position']),
    label: str(value['label']) ?? 'Bookmark',
    createdAt: num(value['createdAt'], 0)
  }
}

function parseBook(value: unknown): BookProgress {
  if (!isRecord(value)) return EMPTY_BOOK

  const chapters: Record<string, ChapterProgress> = {}
  const rawChapters = value['chapters']
  if (isRecord(rawChapters)) {
    for (const [file, entry] of Object.entries(rawChapters)) {
      const parsed = parseChapter(entry)
      if (parsed) chapters[file] = parsed
    }
  }

  const bookmarks = Array.isArray(value['bookmarks'])
    ? value['bookmarks'].map(parseBookmark).filter((b): b is Bookmark => b !== null)
    : []

  return { lastChapter: str(value['lastChapter']), chapters, bookmarks }
}

/**
 * Parse the stored file defensively. It is JSON on the user's disk that a
 * crash could truncate, and losing a reading position is not worth refusing to
 * open the library over.
 */
export function parseProgress(source: string): LibraryProgress {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return EMPTY_PROGRESS
  }
  if (!isRecord(raw)) return EMPTY_PROGRESS

  const books: Record<string, BookProgress> = {}
  const rawBooks = raw['books']
  if (isRecord(rawBooks)) {
    for (const [id, entry] of Object.entries(rawBooks)) books[id] = parseBook(entry)
  }

  return { lastBook: str(raw['lastBook']), books }
}
