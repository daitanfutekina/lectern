/**
 * Assembling PDF text items into readable prose.
 *
 * A PDF has no paragraphs. It has glyphs at coordinates, and a text layer that
 * reports them as fragments in drawing order with no guarantee that a space
 * exists between two words. Concatenating them naively produces
 * "Digital Designwith RTL Design" -- which is fine to look at, because the
 * coordinates put the words apart on screen, and wrong to listen to.
 *
 * So the gaps have to be reconstructed from the geometry. This is pure and
 * tested: it is the part of PDF reading most likely to be subtly wrong, and the
 * part that needs no PDF library to exercise.
 */

/** One fragment as a PDF text layer reports it. */
export interface TextItem {
  readonly str: string
  /** Transform matrix; indices 4 and 5 are the x and y position. */
  readonly transform: readonly number[]
  readonly width: number
  readonly height: number
  readonly hasEOL?: boolean
}

export interface AssembleSettings {
  /**
   * Horizontal gap, as a fraction of glyph height, that means a word break.
   * Below this two fragments are parts of one word.
   */
  readonly spaceRatio: number
  /** Vertical change, as a fraction of glyph height, that means a new line. */
  readonly lineRatio: number
  /** Extra line spacing, again relative to height, that ends a paragraph. */
  readonly paragraphRatio: number
}

export const DEFAULT_ASSEMBLE: AssembleSettings = {
  spaceRatio: 0.2,
  lineRatio: 0.5,
  paragraphRatio: 1.6
}

const xOf = (item: TextItem): number => item.transform[4] ?? 0
const yOf = (item: TextItem): number => item.transform[5] ?? 0

/**
 * Join fragments into lines and paragraphs.
 *
 * Returns paragraphs, each already joined into a single string with spaces
 * where the geometry says a gap belongs.
 */
export function assemblePage(
  items: readonly TextItem[],
  settings: AssembleSettings = DEFAULT_ASSEMBLE
): string[] {
  const paragraphs: string[] = []
  let current = ''
  let previous: TextItem | null = null
  let previousGap = 0

  const flush = (): void => {
    const text = current.replace(/\s+/g, ' ').trim()
    if (text) paragraphs.push(text)
    current = ''
  }

  for (const item of items) {
    if (!item.str) continue

    if (previous === null) {
      current = item.str
      previous = item
      continue
    }

    const height = Math.max(item.height || previous.height || 10, 1)
    const verticalGap = Math.abs(yOf(previous) - yOf(item))
    const newLine = previous.hasEOL === true || verticalGap > height * settings.lineRatio

    if (newLine) {
      // A line noticeably further down than the last is a new paragraph rather
      // than a wrapped line. Using the previous gap as the reference makes this
      // adapt to the document's own leading instead of a guessed constant.
      const isParagraph =
        previousGap > 0 && verticalGap > previousGap * settings.paragraphRatio

      if (isParagraph) {
        flush()
      } else {
        // A wrapped line. A word broken across it must be rejoined, or the two
        // halves are spoken as two nonsense words.
        current = current.endsWith('-')
          ? `${current.slice(0, -1)}${item.str}`
          : `${current} ${item.str}`
        previous = item
        previousGap = verticalGap
        continue
      }
      current = item.str
      previous = item
      previousGap = verticalGap
      continue
    }

    // Same line: insert a space only when the geometry leaves room for one.
    const gap = xOf(item) - (xOf(previous) + previous.width)
    const needsSpace =
      gap > height * settings.spaceRatio &&
      !current.endsWith(' ') &&
      !item.str.startsWith(' ')

    current += needsSpace ? ` ${item.str}` : item.str
    previous = item
  }

  flush()
  return paragraphs
}

/**
 * Running heads, page numbers and footer rules.
 *
 * Spoken on every page these are unbearable, and they are the single loudest
 * defect in a naive read-aloud of a book. A short line that is mostly digits,
 * or that repeats on page after page, is furniture rather than content.
 */
export function isFurniture(line: string): boolean {
  const text = line.trim()
  if (!text) return true
  if (text.length > 70) return false

  // A bare page number, or "Page 12", or "12 | Chapter 3".
  if (/^[ivxlcdm]+$/i.test(text)) return true
  if (/^\d+$/.test(text)) return true
  if (/^(page\s+)?\d+\s*([|·—–-]\s*.{0,40})?$/i.test(text)) return true
  if (/^.{0,40}\s*[|·—–-]\s*(page\s+)?\d+$/i.test(text)) return true

  const digits = (text.match(/\d/g) ?? []).length
  const letters = (text.match(/[A-Za-z]/g) ?? []).length
  return letters > 0 && digits >= letters
}

/**
 * The form a line is compared in.
 *
 * Digits collapse to `#` so "Section 2.1 Introduction" and "Section 2.4
 * Introduction" count as the same running head -- which is the whole point,
 * since a head that carries the section number would otherwise never repeat.
 *
 * Exported because `repeatedLines` returns these keys rather than the lines
 * themselves, and a caller holding raw lines will silently match nothing.
 */
export function furnitureKey(line: string): string {
  return line.trim().replace(/\d+/g, '#')
}

/**
 * Keys of lines that repeat across pages, which is what a running head does and
 * a paragraph does not.
 *
 * Counting is a better test than pattern matching: a running head is defined by
 * recurring, and any given one is unguessable.
 */
export function repeatedLines(pages: readonly (readonly string[])[], threshold = 0.4): Set<string> {
  if (pages.length < 4) return new Set()

  const counts = new Map<string, number>()
  for (const page of pages) {
    // Only the edges of a page: a sentence repeated mid-body is a quotation,
    // not furniture.
    for (const line of [...page.slice(0, 2), ...page.slice(-2)]) {
      const key = furnitureKey(line)
      if (!key || key.length > 70) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  const needed = Math.max(3, Math.floor(pages.length * threshold))
  return new Set(
    [...counts.entries()].filter(([, count]) => count >= needed).map(([key]) => key)
  )
}

/**
 * Drop furniture from a page.
 *
 * `repeated` holds keys from `furnitureKey`, not raw lines -- see
 * `repeatedLines`.
 */
export function cleanPage(
  paragraphs: readonly string[],
  repeated: ReadonlySet<string>
): string[] {
  return paragraphs.filter((line) => !isFurniture(line) && !repeated.has(furnitureKey(line)))
}
