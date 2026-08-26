import { positionAt, scrollTopFor, type ReadingPosition } from '@shared/progress'

/**
 * The DOM half of reading position. The arithmetic lives in `@shared/progress`
 * and is tested without a window; this only measures.
 *
 * A "block" is a top-level child of the chapter body -- a paragraph, a heading,
 * a directive box, an equation. Anchoring to those is what makes a position
 * survive a resize, a font change, or a chapter being edited between sessions.
 */

/** Each block's top, relative to the scroll container's content. */
export function blockTops(container: HTMLElement, body: HTMLElement): number[] {
  const base = container.getBoundingClientRect().top - container.scrollTop
  const tops: number[] = []
  for (const child of Array.from(body.children)) {
    if (!(child instanceof HTMLElement)) continue
    tops.push(Math.round(child.getBoundingClientRect().top - base))
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
 * Scroll fires far more often than a frame, so measurement is deferred to the
 * next animation frame and coalesced -- reading block geometry on every scroll
 * event would force a layout on each one.
 */
export function trackPosition(
  container: HTMLElement,
  getBody: () => HTMLElement | null,
  report: (position: ReadingPosition, blocks: number) => void
): () => void {
  let queued = false

  const onScroll = (): void => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      const body = getBody()
      if (!body) return
      report(currentPosition(container, body), blockCount(body))
    })
  }

  container.addEventListener('scroll', onScroll, { passive: true })
  return () => container.removeEventListener('scroll', onScroll)
}
