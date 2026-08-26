import { sentenceSpans, speakableWithMap, type Block, type SkipReason } from '@shared/speech'

/**
 * Turning a rendered chapter into a queue of things to say.
 *
 * SPEC section 4. Extraction works on the **rendered DOM**, not the Markdown
 * source, for two reasons that both matter. Markdown books and HTML books
 * become the same problem the moment they are on screen, so one walk serves
 * both formats rather than two adapters that drift. And word-follow needs the
 * elements anyway -- a highlight has to land on something real.
 */

export interface Utterance {
  /** What the engine is asked to say. */
  readonly text: string
  /** The block it came from, for scrolling it into view. */
  readonly element: HTMLElement
  /** The block's source text, for locating a highlight. */
  readonly source: string
  /** Spoken-character index to source-character index, for the whole block. */
  readonly map: readonly number[]
  /** Where this utterance begins within the block's spoken text. */
  readonly offset: number
  readonly kind: Block['kind']
  /** Set for mathematics only: the source the spoken form is generated from. */
  readonly latex?: string
  readonly display?: boolean
}

/** Elements that are chrome or are never read aloud. */
const SKIPPED: ReadonlyArray<readonly [string, SkipReason]> = [
  ['PRE', 'code'],
  ['TABLE', 'table'],
  ['NAV', 'navigation'],
  ['ASIDE', 'navigation'],
  ['BUTTON', 'navigation']
]

/**
 * A <figure> is deliberately absent: its image is not speakable but its
 * caption is, and skipping the whole figure would silently drop the one part
 * of it a listener can use.
 */
function skipReasonFor(element: HTMLElement): SkipReason | null {
  for (const [tag, reason] of SKIPPED) if (element.tagName === tag) return reason
  return null
}

/**
 * Elements that hold prose directly. A directive box is a container, so it is
 * descended into rather than read as one lump -- otherwise a theorem and its
 * three paragraphs become a single utterance minutes long.
 */
const LEAF_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'SUMMARY', 'DD', 'DT'])

const HEADING_LEVEL: Readonly<Record<string, number>> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 }

function kindOf(element: HTMLElement): Block['kind'] {
  if (element.tagName in HEADING_LEVEL) return 'heading'
  if (element.classList.contains('box-label') || element.tagName === 'SUMMARY') return 'heading'
  if (element.tagName === 'FIGCAPTION') return 'caption'
  return 'paragraph'
}

/**
 * Walk a rendered chapter and produce everything to say, in reading order.
 *
 * Collapsed content is included. A reader listening to a chapter wants the
 * worked answer read out in place; hiding it visually is about not spoiling a
 * problem on the page, and it is the same decision either way once they have
 * chosen to listen through it.
 */
export function extract(body: HTMLElement): Utterance[] {
  const out: Utterance[] = []

  const walk = (element: HTMLElement): void => {
    if (skipReasonFor(element)) return
    // MathJax replaces equations with its own element tree; the LaTeX is
    // recoverable but speaking it is M4's problem, so it is passed over here
    // rather than read as a string of symbol names.
    if (element.tagName.startsWith('MJX')) return

    // Mathematics is a block of its own, spoken from the LaTeX carried on the
    // wrapper. Reading MathJax's rendered tree as text would produce a string
    // of glyph names, which is worse than silence.
    if (element.classList.contains('math-display') || element.classList.contains('math-inline')) {
      addMath(out, element)
      return
    }

    if (LEAF_TAGS.has(element.tagName)) {
      addBlock(out, element, kindOf(element))
      return
    }

    for (const child of Array.from(element.children)) {
      if (child instanceof HTMLElement) walk(child)
    }
  }

  for (const child of Array.from(body.children)) {
    if (child instanceof HTMLElement) walk(child)
  }

  return out
}

/**
 * A placeholder utterance for an equation.
 *
 * The text is empty at extraction time and filled in later, once the main
 * process has converted the batch. Speech generation is not something to do
 * one equation at a time inside a DOM walk, and the queue has to exist before
 * the conversion can be requested for it.
 */
function addMath(out: Utterance[], element: HTMLElement): void {
  const latex = element.dataset['latex']
  if (!latex) return
  out.push({
    text: '',
    element,
    source: latex,
    map: [],
    offset: 0,
    kind: 'math',
    latex,
    display: element.classList.contains('math-display')
  })
}

export interface Equation {
  readonly element: HTMLElement
  readonly latex: string
  readonly display: boolean
}

/**
 * Every equation in the chapter, in document order.
 *
 * Collected by query rather than from the speech queue, because inline
 * mathematics sits inside a paragraph and the prose walk stops at paragraphs
 * -- it treats them as leaves, which is right for reading them and wrong for
 * finding what is nested in them. Only display equations ever reach the queue
 * as blocks of their own, and they are the minority.
 */
export function collectMath(body: HTMLElement): Equation[] {
  return Array.from(body.querySelectorAll<HTMLElement>('[data-latex]')).map((element) => ({
    element,
    latex: element.dataset['latex'] ?? '',
    display: element.classList.contains('math-display')
  }))
}

/**
 * Replace each equation placeholder with what it should say.
 *
 * Returns a new queue: entries the gate silenced are dropped rather than left
 * as empty utterances, because an utterance with no text still costs a turn in
 * the queue and a pause in the reading.
 */
export function withMathSpeech(
  utterances: Utterance[],
  speech: ReadonlyMap<HTMLElement, string | null>
): Utterance[] {
  const out: Utterance[] = []
  for (const utterance of utterances) {
    if (utterance.kind !== 'math') {
      out.push(utterance)
      continue
    }
    const said = speech.get(utterance.element)
    if (!said) continue
    out.push({ ...utterance, text: said, source: said, map: [] })
  }
  return out
}

/** Class on the hidden node that carries an inline equation's spoken form. */
export const MATH_SPEECH_CLASS = 'math-speech'

/**
 * Put an inline equation's spoken form into the page, hidden.
 *
 * Inline mathematics sits inside a sentence, so it cannot be a separate
 * utterance without breaking the sentence in two. Instead the spoken form is
 * placed in the paragraph as hidden text, and the ordinary prose walk picks it
 * up in the right position with the right offsets -- which is also what keeps
 * word-follow working across it.
 */
export function injectInlineSpeech(element: HTMLElement, speech: string | null): void {
  for (const old of Array.from(element.querySelectorAll(`.${MATH_SPEECH_CLASS}`))) old.remove()

  /*
    MathJax leaves a hidden MathML copy beside the visual output, and its text
    lands in `textContent` -- so the paragraph read "x1,x2,…,xn" followed by the
    real speech, saying the equation twice and the first time badly. Setting
    `enableAssistiveMml: false` did not remove it, so it is removed here where
    the outcome is observable rather than configured.

    This does cost external screen-reader semantics. The trade is deliberate:
    this application supplies its own spoken form, and a better one.
  */
  for (const mml of Array.from(element.querySelectorAll('mjx-assistive-mml'))) mml.remove()

  if (!speech) return
  const hidden = document.createElement('span')
  hidden.className = MATH_SPEECH_CLASS
  // Spaces around it, or the equation runs into the words on either side.
  hidden.textContent = ` ${speech} `
  element.append(hidden)
}

function addBlock(out: Utterance[], element: HTMLElement, kind: Block['kind']): void {
  const source = element.textContent ?? ''
  if (!source.trim()) return

  const { text, map } = speakableWithMap(source)
  if (!text) return

  // A heading is a label, spoken whole. Prose is split into sentences, which is
  // what keeps utterances short enough for the engine and pausing sensible.
  const spans =
    kind === 'heading' ? [{ text, start: 0, end: text.length }] : sentenceSpans(text)

  for (const span of spans) {
    out.push({ text: span.text, element, source, map, offset: span.start, kind })
  }
}

/**
 * A DOM range covering `[from, to)` of an element's text content.
 *
 * The offsets address `textContent`, which concatenates every descendant text
 * node, so the walk converts a flat offset back into the node and offset a
 * Range needs. Returns null rather than an approximate range: a highlight in
 * the wrong place is worse than none.
 */
export function rangeWithin(element: HTMLElement, from: number, to: number): Range | null {
  if (to <= from) return null

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let seen = 0
  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0

  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const length = node.data.length

    if (!startNode && seen + length > from) {
      startNode = node
      startOffset = from - seen
    }
    if (seen + length >= to) {
      endNode = node
      endOffset = to - seen
      break
    }
    seen += length
  }

  if (!startNode || !endNode) return null

  const range = document.createRange()
  try {
    range.setStart(startNode, Math.max(0, Math.min(startOffset, startNode.data.length)))
    range.setEnd(endNode, Math.max(0, Math.min(endOffset, endNode.data.length)))
  } catch {
    return null
  }
  return range
}

/** Where a spoken offset lands in the source text. */
export function sourceIndex(utterance: Utterance, spokenOffset: number): number {
  const index = utterance.offset + spokenOffset
  return utterance.map[Math.min(index, utterance.map.length - 1)] ?? 0
}
