/**
 * Landing on a search result in the rendered page.
 *
 * The result list was built from each chapter's text; this finds the same
 * occurrence among the page's own text nodes and marks it. The walk skips
 * exactly what the text extraction removed -- drawings and typeset mathematics
 * -- so "the fourth occurrence" means the same passage in both.
 */

/** Rendered but never searched: a drawing's labels, and mathematics in any state. */
function isSkipped(element: Element): boolean {
  const tag = element.tagName.toUpperCase()
  if (tag === 'SVG' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MATH') return true
  if (tag.startsWith('MJX-')) return true
  return element.classList.contains('math-inline') || element.classList.contains('math-display')
}

interface Piece {
  /** Null for a line break, which the text search reads as a space. */
  readonly node: Text | null
  readonly start: number
  readonly length: number
}

/**
 * A Range over one occurrence of `pattern` inside `root`.
 *
 * `occurrence` counts from zero. Past the end, the last occurrence is used: the
 * page and the extracted text can differ by a match at the margins -- a phrase
 * split across a hyphenated line, say -- and landing one occurrence early is
 * far better than landing nowhere.
 */
export function locate(root: Element, pattern: RegExp, occurrence: number): Range | null {
  const document = root.ownerDocument
  const pieces: Piece[] = []
  let text = ''

  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const data = (child as Text).data
        pieces.push({ node: child as Text, start: text.length, length: data.length })
        text += data
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const element = child as Element
        if (element.tagName.toUpperCase() === 'BR') {
          pieces.push({ node: null, start: text.length, length: 1 })
          text += ' '
        } else if (!isSkipped(element)) {
          walk(element)
        }
      }
    }
  }
  walk(root)

  const found = [...text.matchAll(new RegExp(pattern.source, 'gi'))]
  if (found.length === 0) return null
  const chosen = found[Math.min(Math.max(occurrence, 0), found.length - 1)]
  if (!chosen) return null

  const from = chosen.index ?? 0
  const to = from + chosen[0].length

  // A boundary that falls on a line break moves to the nearest real text.
  const startAt = (offset: number): [Text, number] | null => {
    for (const piece of pieces) {
      if (!piece.node || piece.start + piece.length <= offset) continue
      return [piece.node, Math.max(0, offset - piece.start)]
    }
    return null
  }
  const endAt = (offset: number): [Text, number] | null => {
    for (let index = pieces.length - 1; index >= 0; index -= 1) {
      const piece = pieces[index]
      if (!piece?.node || piece.start >= offset) continue
      return [piece.node, Math.min(piece.length, offset - piece.start)]
    }
    return null
  }

  const start = startAt(from)
  const end = endAt(to)
  if (!start || !end) return null

  const range = document.createRange()
  range.setStart(start[0], start[1])
  range.setEnd(end[0], end[1])
  return range
}

type Registry = { set: (name: string, highlight: unknown) => void; delete: (name: string) => void }
type HighlightWindow = Window & { CSS?: { highlights?: Registry }; Highlight?: new (...ranges: Range[]) => unknown }

/** Where the current mark lives, so it can be cleared from there. */
let marked: HighlightWindow | null = null
let selected: Window | null = null
/** Cancels the settling scrolls of a previous jump when the next one starts. */
let settling: ReturnType<typeof setTimeout>[] = []

/**
 * Mark a result and bring it into view.
 *
 * Two ways of marking, because the two kinds of page disagree about what is
 * safe. On our own pages it is a custom highlight, which leaves the reader's
 * selection alone. Inside an EPUB's frame it is the frame's own selection:
 * registering a custom highlight there made Chromium skip the notifications of
 * the observer that sizes the frame to its content, and every jump logged a
 * stream of "ResizeObserver loop" errors -- sixteen per jump, measured, against
 * one for opening the same chapter by hand. The selection costs nothing but the
 * colour.
 */
export function showResult(range: Range): void {
  clearResult()
  const view = range.startContainer.ownerDocument?.defaultView as HighlightWindow | null
  if (!view) return

  if (view.frameElement) {
    const selection = view.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    selected = view
  } else {
    const registry = view.CSS?.highlights
    const Highlight = view.Highlight
    if (registry && Highlight) {
      try {
        registry.set('find', new Highlight(range))
        marked = view
      } catch {
        // Without the registry the result is still scrolled to; it just is not marked.
      }
    }
  }
  bringIntoView(range)
}

export function clearResult(): void {
  for (const timer of settling) clearTimeout(timer)
  settling = []
  try {
    marked?.CSS?.highlights?.delete('find')
    selected?.getSelection()?.removeAllRanges()
  } catch {
    // A frame that has gone away takes its mark with it.
  }
  marked = null
  selected = null
}

/** The nearest ancestor that actually scrolls. */
function scrollerOf(element: Element): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

/**
 * Scroll a range to the middle of the reader, and keep it there while the page
 * settles.
 *
 * A jump lands in a page that is still arriving, in a different way for each
 * format, and each was found by measuring where a jump actually left the mark:
 *
 * - An EPUB's frame is sized to its content by a resize observer and starts at
 *   the browser's default 150 pixels. A target computed at once is clamped to
 *   what a 150-pixel frame can scroll, and every early jump landed at the top
 *   of the chapter.
 * - A PDF draws the pages around the one jumped to as they come into view, and
 *   a page that is not the size of the placeholder -- front matter usually is
 *   not -- moves everything below it when it arrives. The mark ended just under
 *   the bottom of the reader.
 *
 * So the target is recomputed from live measurements a few times as the page
 * settles, and given up the moment the reader scrolls somewhere themselves.
 * The outer reader is scrolled by arithmetic rather than `scrollIntoView`,
 * which from inside a frame would also move the frame's own document by the
 * few pixels its padding allows.
 */
function bringIntoView(range: Range): void {
  const view = range.startContainer.ownerDocument?.defaultView
  const frame = (view?.frameElement as HTMLElement | null | undefined) ?? null
  const anchor = frame ?? range.startContainer.parentElement
  if (!anchor) return

  let placed: number | null = null
  const place = (): void => {
    const scroller = scrollerOf(anchor)
    if (!scroller) return
    // The reader has moved since the last placement; stop following.
    if (placed !== null && Math.abs(scroller.scrollTop - placed) > 4) return

    const inside = range.getBoundingClientRect()
    // A range not laid out yet measures as nothing, and a target computed from
    // nothing is the top of the page.
    if (inside.width === 0 && inside.height === 0) return
    const offset = frame ? frame.getBoundingClientRect().top : 0
    const viewport = scroller.getBoundingClientRect()
    const target = Math.max(
      0,
      scroller.scrollTop + offset + inside.top - viewport.top - scroller.clientHeight / 2
    )
    scroller.scrollTop = target
    placed = scroller.scrollTop
  }

  place()
  settling = [150, 500, 1100, 2000].map((delay) => setTimeout(place, delay))
}
