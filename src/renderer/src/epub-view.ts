import { epubReadBlock } from '@shared/epub-click'
import { epubHostSheet, type Theme } from '@shared/theme'

/**
 * Showing an EPUB with its own typography. SPEC section 3, as amended.
 *
 * The "one stylesheet" invariant exists to stop *our* seven textbooks drifting
 * into seven designs. Applying it to a downloaded book was a mistake: an
 * EPUB's typography is part of the book, and repainting it in our colours
 * replaced something the publisher chose with something we did.
 *
 * The document is rendered in a same-origin frame. That is what real EPUB
 * readers do, and for the same reason: a book's CSS is written assuming it owns
 * the page, so `body { font-family: ... }` in a chapter would otherwise restyle
 * the application around it. A frame gives the book its page.
 */

export interface EpubFrame {
  readonly frame: HTMLIFrameElement
  readonly body: HTMLElement
}

type EpubReadHandler = (block: HTMLElement) => void

/**
 * Listen inside the frame, because DOM events do not cross its document boundary.
 *
 * The target is deliberately duck-typed. An EPUB element belongs to the frame's
 * realm, so checking it against the application's Element or HTMLElement would
 * reject every valid double-click.
 */
export function listenForEpubRead(doc: Document, onReadFrom: EpubReadHandler): void {
  doc.addEventListener('dblclick', (event) => {
    const block = epubReadBlock(event.target)
    if (!block) return

    // A double-click selects a word by default; reading from it is the gesture,
    // so leave ordinary drag selection untouched and clear only this selection.
    doc.getSelection()?.removeAllRanges()
    onReadFrom(block as HTMLElement)
  })
}

/**
 * Render a chapter into a frame inside `container`.
 *
 * Resolves once the document has parsed, so the caller can walk it for speech.
 */
export function renderEpub(
  container: HTMLElement,
  html: string,
  theme: Theme,
  onLink?: (href: string) => void,
  onReadFrom?: EpubReadHandler
): Promise<EpubFrame | null> {
  return new Promise((resolve) => {
    container.replaceChildren()

    const frame = document.createElement('iframe')
    frame.className = 'epub-frame'
    // No scripts: nothing in a book needs to run, and the document came from a
    // file the reader downloaded rather than from us.
    frame.setAttribute('sandbox', 'allow-same-origin')
    frame.setAttribute('title', 'Chapter')

    /*
      A frame fires `load` for the blank document it starts as, before `srcdoc`
      has been parsed -- so resolving on the first one handed the caller an
      empty body and the chapter produced no speech at all. The handler waits
      for a load that actually has the document in it.
    */
    let settled = false

    const onLoad = (): void => {
      if (settled) return
      const doc = frame.contentDocument
      if (!doc?.body) return
      /*
        The blank document a frame starts as reports `readyState: complete`
        immediately, so waiting on that resolved against the wrong document --
        an empty body, and the chapter's stylesheet injected into nothing. A
        `srcdoc` document identifies itself by its URL, which is the one signal
        the blank document cannot fake.
      */
      if (doc.URL === 'about:blank' && doc.body.children.length === 0) return
      settled = true

      const style = doc.createElement('style')
      // Inserted first as well as using zero-specificity selectors: these are
      // absent-style defaults, never a reason to overrule the publisher.
      style.textContent = epubHostSheet(theme)
      doc.head?.prepend(style)

      /*
        Every link in the book, handed back to the caller.

        The document is rendered from `srcdoc`, so it has no URL of its own and
        a relative `href` resolves against the application instead of against
        the archive. Clicking an entry in a book's own contents therefore aimed
        at a page that does not exist: the frame went blank, and the chapter it
        named was unreachable. Only the caller knows the spine, so resolving
        happens there and this just reports the href.
      */
      if (onLink) {
        doc.addEventListener('click', (event) => {
          // Duck-typed, not `instanceof`: the frame is its own realm, so the
          // parent's `Element` does not match anything inside it.
          const target = event.target as { closest?: (selector: string) => Element | null } | null
          const anchor = target?.closest?.('a[href]')
          const href = anchor?.getAttribute('href')
          if (!href) return
          event.preventDefault()
          onLink(href)
        })
      }

      if (onReadFrom) listenForEpubRead(doc, onReadFrom)

      fitToContent(frame, doc.body)
      resolve({ frame, body: doc.body })
    }

    frame.addEventListener('load', onLoad)
    container.append(frame)
    frame.srcdoc = html

    // A last resort, in case no further load event arrives.
    setTimeout(() => {
      if (settled) return
      const doc = frame.contentDocument
      if (doc?.body && doc.body.children.length > 0) onLoad()
      else if (!settled) {
        settled = true
        resolve(null)
      }
    }, 3000)
  })
}

/**
 * Grow the frame to its content so the page scrolls once, not twice.
 *
 * A frame with its own scrollbar inside a scrolling page is the two-scrollbar
 * problem, and it is worse here than it looks: reading position, word-follow
 * and scroll-into-view all measure against the outer scroller, and a frame that
 * scrolls internally hides the content's real position from all three.
 */
function fitToContent(frame: HTMLIFrameElement, body: HTMLElement): void {
  let applied = 0

  const apply = (): void => {
    const doc = frame.contentDocument
    if (!doc) return
    /*
      The body's own height, not the document element's. `documentElement`
      reports the viewport when the frame is taller than its content, so
      measuring it grows the frame every time it is measured and leaves a
      screenful of empty space under the chapter.
    */
    const style = frame.contentWindow?.getComputedStyle(body)
    const margins =
      Number.parseFloat(style?.marginTop ?? '0') + Number.parseFloat(style?.marginBottom ?? '0')
    const height = Math.ceil(body.getBoundingClientRect().height + margins)
    // Resizing the frame resizes its body, which fires the observer again. A
    // few pixels of tolerance breaks that loop; without it the browser reports
    // "ResizeObserver loop completed with undelivered notifications" forever.
    if (height > 0 && Math.abs(height - applied) > 4) {
      applied = height
      frame.style.height = `${height}px`
    }
  }

  apply()
  // Images and fonts land after parse and change the height when they do.
  const observer = new ResizeObserver(apply)
  observer.observe(body)
  frame.contentWindow?.addEventListener('load', apply)
  setTimeout(apply, 250)
  setTimeout(apply, 1200)
}
