import { CAPTION_MATH } from './markdown'

/**
 * Finding a phrase across a whole book. The searching, not the showing.
 *
 * Every format is reduced to the prose a reader sees, and then one matcher is
 * used twice: over that text, to list the results, and over the rendered page,
 * to land on the one the reader chose. Using the same matcher in both places is
 * the point -- a result list and a page that disagreed about what counts as a
 * match would send the reader to the wrong occurrence.
 *
 * Mathematics is removed rather than searched. It is typeset as glyphs, so a
 * search for "text" that matched inside `\text{...}` would list a result that is
 * nowhere visible on the page it opens.
 */

/** Below this a query matches everything in a textbook and tells the reader nothing. */
export const MIN_QUERY = 2

/** Results kept per chapter. A word on every page of a chapter is not a list anyone reads. */
export const PER_CHAPTER = 50

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“'
}

const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })

/** Markup a reader never sees as text: drawings, scripts, styles. */
const stripInvisible = (html: string): string =>
  html
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')

/** One of our Markdown chapters, as the prose it renders to. */
export function markdownPlain(source: string): string {
  let text = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  text = stripInvisible(text)
  text = text
    // Display then inline mathematics, in every delimiter the books use.
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\\\[[\s\S]*?\\\]/g, ' ')
    .replace(/\\\([\s\S]*?\\\)/g, ' ')
    .replace(new RegExp(CAPTION_MATH.source, 'g'), ' ')
    // A directive fence keeps its label, which is what is printed.
    .replace(/^\s*:{3,}[\w-]*(?:\[([^\]]*)\])?.*$/gm, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Bold markers, which split a phrase a reader typed. Underscores stay:
    // `set_cell` is exactly the kind of thing a Godot reader searches for.
    .replace(/\*\*/g, '')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(text)
}

/** An EPUB document or one of the older HTML chapters, as the prose it shows. */
export function htmlPlain(html: string): string {
  return decodeEntities(stripInvisible(html).replace(/<[^>]+>/g, ' '))
}

/**
 * The matcher, for a query as typed.
 *
 * Literal, case-insensitive, and loose about whitespace: the reader's space is
 * any run of whitespace in the book, because a phrase that wraps onto the next
 * line in the source is still one phrase on the page. Null for a query too
 * short to be worth running.
 */
export function queryPattern(query: string): RegExp | null {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.join(' ').length < MIN_QUERY) return null
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(escaped.join('\\s+'), 'gi')
}

export interface Match {
  /** Which occurrence this is in its text, counting from zero. */
  readonly occurrence: number
  readonly before: string
  readonly match: string
  readonly after: string
}

const SNIPPET = 60

const tidy = (text: string): string => text.replace(/\s+/g, ' ')

/**
 * Every occurrence in a piece of text, with enough either side to recognise it.
 *
 * `total` is counted past the limit, so a result list can say "and 40 more"
 * rather than silently stopping at fifty.
 */
export function findMatches(
  text: string,
  pattern: RegExp,
  limit = PER_CHAPTER
): { matches: Match[]; total: number } {
  const matches: Match[] = []
  let total = 0
  const scan = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)

  for (const found of text.matchAll(scan)) {
    const at = found.index ?? 0
    if (matches.length < limit) {
      const start = Math.max(0, at - SNIPPET)
      const end = Math.min(text.length, at + found[0].length + SNIPPET)
      matches.push({
        occurrence: total,
        before: (start > 0 ? '…' : '') + tidy(text.slice(start, at)).trimStart(),
        match: tidy(found[0]),
        after: tidy(text.slice(at + found[0].length, end)).trimEnd() + (end < text.length ? '…' : '')
      })
    }
    total += 1
  }
  return { matches, total }
}
