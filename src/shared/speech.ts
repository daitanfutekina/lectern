/**
 * What gets spoken, and where one utterance ends.
 *
 * SPEC section 4 and 5. Pure by contract: the decisions live here and are
 * tested without a window, while the DOM walk that finds the text and the
 * engine that says it out loud live in the renderer.
 */

/** Why a block is not spoken. Recorded rather than dropped, so a gap is explicable. */
export type SkipReason = 'code' | 'empty' | 'navigation' | 'math-too-complex' | 'table' | 'graphic'

export type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'caption'; readonly text: string }
  | { readonly kind: 'math'; readonly latex: string; readonly speech: string | null; readonly display: boolean }
  | { readonly kind: 'skip'; readonly reason: SkipReason }

/**
 * Symbols a speech engine either mispronounces or silently drops.
 *
 * A textbook is full of these, and "section five point one" is the difference
 * between a sentence and a swallowed one. Kept short deliberately: every entry
 * is a claim about how something should sound, and a long list of those is a
 * long list of things to be wrong about.
 */
const SPOKEN_SYMBOLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/§\s*/g, 'section '],
  [/&/g, ' and '],
  [/→/g, ' gives '],
  [/↔/g, ' is equivalent to '],
  [/⇒/g, ' implies '],
  [/×/g, ' by '],
  [/≤/g, ' at most '],
  [/≥/g, ' at least '],
  [/≠/g, ' is not equal to '],
  [/±/g, ' plus or minus '],
  [/…/g, ' '],
  // Dashes used as parenthetical punctuation become a pause, not a word.
  [/\s+[–—]\s+/g, ', ']
]

/**
 * Abbreviations whose full stop does not end a sentence.
 *
 * Splitting after "Dr." or "Fig." produces a fragment and a sentence starting
 * mid-clause, which is far more audible than a missed pause.
 */
const ABBREVIATIONS = [
  'dr', 'prof', 'mr', 'mrs', 'ms', 'st', 'vs', 'etc', 'eg', 'ie', 'cf',
  'fig', 'figs', 'eq', 'eqs', 'ch', 'sec', 'no', 'vol', 'approx', 'al'
]

const ABBREVIATION_PATTERN = new RegExp(`\\b(?:${ABBREVIATIONS.join('|')})$`, 'i')

/**
 * Text prepared for a speech engine, with an index back to the original.
 *
 * The map exists for word-follow. `speakable` rewrites the text -- "§5.1"
 * becomes "section 5.1" -- so a character offset in the spoken string does not
 * address the same character on screen. The engine reports boundaries against
 * what it was given, and the highlight has to land on what the reader sees, so
 * every spoken character records where it came from.
 */
export interface Speakable {
  readonly text: string
  /** For each character of `text`, its index in the source. */
  readonly map: readonly number[]
}

export function speakableWithMap(source: string): Speakable {
  // Built character by character rather than with `replace`, because a
  // replacement changes every offset after it and reconstructing that
  // afterwards is harder than never losing it.
  let out = ''
  const map: number[] = []
  let i = 0

  const push = (text: string, sourceIndex: number): void => {
    for (const char of text) {
      out += char
      map.push(sourceIndex)
    }
  }

  outer: while (i < source.length) {
    for (const [pattern, replacement] of SPOKEN_SYMBOLS) {
      const anchored = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'y')
      anchored.lastIndex = i
      const match = anchored.exec(source)
      if (match && match[0].length > 0) {
        push(replacement, i)
        i += match[0].length
        continue outer
      }
    }
    push(source[i] ?? '', i)
    i += 1
  }

  // Whitespace collapse, keeping the map aligned.
  let collapsed = ''
  const collapsedMap: number[] = []
  let pendingSpace = false
  for (let index = 0; index < out.length; index += 1) {
    const char = out[index] ?? ''
    if (/\s/.test(char)) {
      pendingSpace = collapsed.length > 0
      continue
    }
    if (pendingSpace) {
      collapsed += ' '
      collapsedMap.push(map[index] ?? 0)
      pendingSpace = false
    }
    collapsed += char
    collapsedMap.push(map[index] ?? 0)
  }

  return { text: collapsed, map: collapsedMap }
}

/** Text prepared for a speech engine. */
export function speakable(text: string): string {
  return speakableWithMap(text).text
}

/**
 * Split into sentences.
 *
 * Sentences, not whole blocks, are the unit of speech. Three reasons, and all
 * of them are load-bearing: browser speech engines truncate or stall on long
 * utterances; pausing should stop at the end of a sentence rather than mid
 * clause; and a short utterance is what makes seeking and word-follow
 * responsive.
 */
/** A sentence, and where it sits in the prepared text. */
export interface Span {
  readonly text: string
  readonly start: number
  readonly end: number
}

export function sentences(text: string): string[] {
  return sentenceSpans(speakableWithMap(text).text).map((span) => span.text)
}

/**
 * Sentence boundaries within already-prepared text, keeping offsets so a
 * boundary event inside one sentence can be located in the whole block.
 */
export function sentenceSpans(prepared: string): Span[] {
  if (!prepared) return []

  const out: Span[] = []
  let start = 0

  for (let i = 0; i < prepared.length; i += 1) {
    const char = prepared[i]
    if (char !== '.' && char !== '!' && char !== '?') continue

    // A terminator only ends a sentence when whitespace follows, which rules
    // out decimals (3.14) and file names in one test rather than two.
    const after = prepared[i + 1]
    if (after !== undefined && after !== ' ') continue

    const head = prepared.slice(start, i)
    if (char === '.') {
      // "Dr." and friends, and a lone initial such as "J. Smith".
      const lastWord = head.split(' ').pop() ?? ''
      if (ABBREVIATION_PATTERN.test(lastWord)) continue
      if (/(?:^|\s)[A-Z]$/.test(head)) continue
    }

    pushSpan(out, prepared, start, i + 1)
    start = i + 1
  }

  pushSpan(out, prepared, start, prepared.length)
  return out
}

/** Record a span, trimming the edges but keeping the offsets truthful. */
function pushSpan(out: Span[], source: string, from: number, to: number): void {
  let start = from
  let end = to
  while (start < end && /\s/.test(source[start] ?? '')) start += 1
  while (end > start && /\s/.test(source[end - 1] ?? '')) end -= 1
  if (end > start) out.push({ text: source.slice(start, end), start, end })
}

/**
 * Everything a block contributes to the queue, in order.
 *
 * A heading is one utterance however long it is: it is a label, and breaking a
 * label into sentences makes it sound like prose.
 */
export function utterancesFor(block: Block): string[] {
  switch (block.kind) {
    case 'heading':
      return [speakable(block.text)].filter(Boolean)
    case 'paragraph':
    case 'caption':
      return sentences(block.text)
    case 'math':
      return block.speech ? [speakable(block.speech)] : []
    case 'skip':
      return []
  }
}

/** How long an utterance should take, for progress estimates. */
export function estimateSeconds(text: string, rate: number): number {
  const words = (text.match(/\S+/g) ?? []).length
  // 180 words per minute at rate 1 is roughly a comfortable reading pace.
  return (words / 180) * 60 / (rate > 0 ? rate : 1)
}

/** Estimated time from the current utterance to the end of the queue. */
export function estimateRemainingSeconds(
  utterances: readonly string[],
  current: number,
  rate: number
): number {
  const start = Math.max(0, Math.min(Math.trunc(current), utterances.length))
  return utterances
    .slice(start)
    .reduce((total, text) => total + estimateSeconds(text, rate), 0)
}

/** Playback speed the engine will actually honour. */
export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1
  return Math.min(Math.max(rate, 0.5), 3)
}
