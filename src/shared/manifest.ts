import { parse as parseYaml } from 'yaml'

/**
 * `book.yml`, parsed defensively.
 *
 * The file is written by the conversion script but edited by hand afterwards, so
 * it is untrusted input like any config: a missing field must degrade, never
 * throw. SPEC section 2.
 */
/**
 * A named group of chapters, for a book long enough that a flat list stops
 * being navigable.
 *
 * Optional on purpose: a book that declares no parts reads exactly as it did
 * before. The Godot book lists 109 chapters across thirteen parts and is the
 * reason this exists; the six-chapter books would be worse for the grouping,
 * not better, so nothing imposes it on them.
 */
export interface BookPart {
  readonly title: string
  readonly chapters: readonly string[]
}

export interface BookManifest {
  readonly title: string | null
  readonly index: string | null
  readonly chapters: readonly string[]
  readonly parts: readonly BookPart[]
  readonly macros: Readonly<Record<string, string>>
}

export const EMPTY_MANIFEST: BookManifest = {
  title: null,
  index: null,
  chapters: [],
  parts: [],
  macros: {}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

/** Only `.md` entries; anything else in the list is a typo, not a chapter. */
function chapterList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => str(entry))
    .filter((entry): entry is string => entry !== null && entry.endsWith('.md'))
}

/**
 * Macro names are LaTeX control sequences, so letters only. A name with a
 * backslash or a brace in it would be written into a MathJax config and break
 * every equation in the book, which is a large blast radius for a typo.
 */
function macroMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const macros: Record<string, string> = {}
  for (const [name, body] of Object.entries(value)) {
    const text = str(body)
    if (text && /^[A-Za-z]+$/.test(name)) macros[name] = text
  }
  return macros
}

/**
 * Parts, dropping any that name no chapter that survived `chapterList`.
 *
 * A part is a view over the reading order, never a second source of it: the
 * `chapters:` list stays authoritative, so a chapter missing from every part
 * still appears and a chapter named by a part it does not contain is ignored.
 * Getting that backwards would let a typo in a part title hide a chapter.
 */
function partList(value: unknown, chapters: readonly string[]): BookPart[] {
  if (!Array.isArray(value)) return []
  const known = new Set(chapters)
  const parts: BookPart[] = []

  for (const entry of value) {
    if (!isRecord(entry)) continue
    const title = str(entry['title'])
    const files = chapterList(entry['chapters']).filter((f) => known.has(f))
    if (title && files.length > 0) parts.push({ title, chapters: files })
  }
  return parts
}

export function parseManifest(source: string): BookManifest {
  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch {
    // A malformed manifest yields an empty one. The scanner then falls back to
    // sorted file order, which is wrong but readable -- better than a book that
    // cannot be opened at all.
    return EMPTY_MANIFEST
  }

  if (!isRecord(raw)) return EMPTY_MANIFEST

  const chapters = chapterList(raw['chapters'])
  return {
    title: str(raw['title']),
    index: str(raw['index']),
    chapters,
    parts: partList(raw['parts'], chapters),
    macros: macroMap(raw['macros'])
  }
}

export interface FrontMatter {
  readonly title: string | null
  readonly crumb: string | null
}

/**
 * Front matter from a chapter file, plus the body with it removed.
 *
 * Returned together because every caller needs both, and splitting the source
 * twice invites the two halves disagreeing about where the boundary was.
 */
export function splitFrontMatter(source: string): { matter: FrontMatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { matter: { title: null, crumb: null }, body: source }

  let parsed: unknown
  try {
    parsed = parseYaml(match[1] ?? '')
  } catch {
    parsed = null
  }

  const matter = isRecord(parsed)
    ? { title: str(parsed['title']), crumb: str(parsed['crumb']) }
    : { title: null, crumb: null }

  return { matter, body: source.slice(match[0].length) }
}
