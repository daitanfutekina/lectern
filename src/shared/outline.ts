/**
 * Chapter metadata: headings and a word count.
 *
 * Deliberately dependency-free. The library scan runs in the main process, and
 * pulling the whole Markdown pipeline in there to learn a chapter's headings
 * would put an ESM-only parser stack into the main bundle for a job that needs
 * neither. Rendering stays in the renderer; this is the part main needs.
 *
 * Being hand-written means being fence-aware on purpose: a `#` on the first
 * line of a shell example is not a heading, and a naive line-by-line scan would
 * fill the library index with comments from code blocks.
 */

/** Lines outside fenced code blocks, in order. */
function proseLines(source: string): string[] {
  const withoutFrontMatter = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const lines = withoutFrontMatter.split(/\r?\n/)
  const kept: string[] = []

  let fence: { char: string; length: number } | null = null
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    const run = marker?.[1]

    if (fence === null) {
      if (run) fence = { char: run[0]!, length: run.length }
      else kept.push(line)
      continue
    }

    // CommonMark: a closing fence uses the same character and is at least as
    // long as the opener. Comparing only the character lets ``` inside a ````
    // block close it, and the rest of the code block is then read as prose.
    if (run && run[0] === fence.char && run.length >= fence.length) fence = null
  }
  return kept
}

/** Strip the inline syntax that would otherwise appear in a heading's text. */
function plain(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2')
    .replace(/\\([*_`[\]])/g, '$1')
    .trim()
}

export interface Heading {
  readonly level: number
  readonly text: string
}

/** Headings with their levels, in document order. */
export function outline(source: string): Heading[] {
  const headings: Heading[] = []
  for (const line of proseLines(source)) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!match) continue
    const text = plain(match[2] ?? '')
    if (text) headings.push({ level: match[1]!.length, text })
  }
  return headings
}

export function extractHeadings(source: string): string[] {
  return outline(source).map((heading) => heading.text)
}

/**
 * Words of prose, ignoring mathematics, code and directive syntax, so a chapter
 * of dense algebra is not reported as longer than a chapter of prose.
 */
export function countWords(source: string): number {
  const prose = proseLines(source)
    .join('\n')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/^:{3,}.*$/gm, ' ')
  return (prose.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length
}

/** Rough reading time. 200 words per minute is the usual figure for prose. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 200))
}
