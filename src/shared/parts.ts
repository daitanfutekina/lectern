/**
 * Grouping a book's chapters by the parts its manifest declares.
 *
 * Pure, and here rather than in the renderer so it can be tested: SPEC's rule
 * that `src/shared` is testable without a window is the only reason this logic
 * has a fixture at all. It shipped once unverified and did not work.
 */
import type { Book, Chapter } from './library'

export interface ChapterGroup {
  /** Null for the ungrouped run, which renders with no heading. */
  readonly title: string | null
  readonly chapters: readonly Chapter[]
}

/**
 * A book that declares no parts yields one untitled group, which renders
 * exactly as the flat list always did -- that is what keeps this off the
 * six-chapter books, where thirteen headings over seven entries would be worse
 * than none.
 *
 * Anything the parts do not mention is appended in reading order rather than
 * dropped. A manifest is edited by hand, and a chapter vanishing from the
 * sidebar over a typo is a far worse failure than an ungrouped one.
 */
export function groupChapters(book: Book): ChapterGroup[] {
  if (book.parts.length === 0) return [{ title: null, chapters: [...book.chapters] }]

  const byFile = new Map(book.chapters.map((c) => [c.file, c]))
  const placed = new Set<string>()

  const groups: ChapterGroup[] = book.parts.map((part) => {
    const chapters: Chapter[] = []
    for (const file of part.chapters) {
      const chapter = byFile.get(file)
      if (chapter && !placed.has(file)) {
        chapters.push(chapter)
        placed.add(file)
      }
    }
    return { title: part.title, chapters }
  })

  const rest = book.chapters.filter((c) => !placed.has(c.file))
  if (rest.length > 0) groups.push({ title: null, chapters: rest })
  return groups.filter((g) => g.chapters.length > 0)
}

/**
 * Whether a chapter continues the one numbered before it, so a walkthrough
 * split across nine files reads as one thing rather than nine.
 *
 * Taken from the file name because that is where the relationship already
 * lives: `godot_ch70a_scene_setup.md` belongs to chapter 70 whatever its title
 * says. Only true when the parent is actually present -- a lone `ch15a` with no
 * `ch15` is a chapter in its own right.
 */
export function isSubChapter(book: Book, chapter: Chapter): boolean {
  const mine = /^(.*_(?:p\d+)?ch\d+)[a-z]+_/i.exec(chapter.file)
  if (!mine) return false
  return book.chapters.some((c) => c.file.startsWith(`${mine[1]}_`))
}
