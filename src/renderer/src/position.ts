import { positionAt, scrollTopFor, type ReadingPosition } from '@shared/progress'
import { coalesceAction } from '@shared/scheduling'

/**
 * The DOM half of reading position. The arithmetic lives in `@shared/progress`
 * and is tested without a window; this only measures.
 *
 * A "block" is a top-level child of the chapter body -- a paragraph, a heading,
 * a directive box, an equation. Anchoring to those is what makes a position
 * survive a resize, a font change, or a chapter being edited between sessions.
 */

/**
 * Each block's top, relative to the scroll container's content.
 *
 * `body` may be the body of an EPUB's frame, which costs two things.
 *
 * Membership is decided by node type rather than `instanceof HTMLElement`: a
 * frame is a separate realm with its own constructors, and that check silently
 * rejects every element inside one.
 *
 * And a rect measured inside a frame is relative to *that* frame's viewport,
 * not this document's. The frame does not scroll internally, so those rects do
 * not move when the page scrolls -- which made every measured top drift by
 * exactly the scroll offset, and a position recorded at one offset restore to a
 * different place. Adding the frame's own position converts them into this
 * document's coordinates, where the rest of the arithmetic already lives.
 */
export function blockTops(container: HTMLElement, body: HTMLElement): number[] {
  const base = container.getBoundingClientRect().top - container.scrollTop
  const frame =
    body.ownerDocument === container.ownerDocument
      ? null
      : body.ownerDocument.defaultView?.frameElement
  const offset = frame ? frame.getBoundingClientRect().top : 0

  const tops: number[] = []
  for (const child of Array.from(body.children)) {
    if (child.nodeType !== 1) continue
    tops.push(Math.round(child.getBoundingClientRect().top + offset - base))
  }
  return tops
}

export function currentPosition(container: HTMLElement, body: HTMLElement): ReadingPosition {
  return positionAt(blockTops(container, body), container.scrollTop)
}

export function blockCount(body: HTMLElement): number {
  return body.children.length
}

/**
 * Restore a stored position.
 *
 * Deliberately not smooth: this runs on open, and animating from the top of a
 * chapter to somewhere in the middle is motion the reader did not ask for. The
 * container's scroll behaviour is overridden for the one assignment and put
 * back, because the stylesheet sets smooth scrolling for everything else.
 */
export function restorePosition(
  container: HTMLElement,
  body: HTMLElement,
  position: ReadingPosition
): void {
  const previous = container.style.scrollBehavior
  container.style.scrollBehavior = 'auto'
  container.scrollTop = scrollTopFor(blockTops(container, body), position)
  container.style.scrollBehavior = previous
}

/**
 * Report the reading position as it changes.
 *
 * Geometry and IPC are deliberately limited to four reports a second. A final
 * synchronous measurement is made separately when the chapter or window goes
 * away, so this delay cannot lose the reader's last position.
 */
export function trackPosition(
  container: HTMLElement,
  getBody: () => HTMLElement | null,
  report: (position: ReadingPosition, blocks: number) => void,
  reportNow: (position: ReadingPosition, blocks: number) => void = report
): { flush: () => void; stop: () => void } {
  let flushing = false
  const reporter = coalesceAction(() => {
    const body = getBody()
    if (!body) return
    ;(flushing ? reportNow : report)(currentPosition(container, body), blockCount(body))
  }, 250)

  const onScroll = (): void => {
    reporter.request()
  }

  container.addEventListener('scroll', onScroll, { passive: true })
  return {
    flush: () => {
      flushing = true
      reporter.request()
      reporter.flush()
      flushing = false
    },
    stop: () => {
      reporter.cancel()
      container.removeEventListener('scroll', onScroll)
    }
  }
}
