/**
 * Showing a PDF as a PDF. SPEC section 3, as amended.
 *
 * The whole document is one continuous scroller. Reading a book should not mean
 * clicking through it a chapter at a time -- the outline is for jumping to a
 * place, not for cutting the book into pieces that have to be opened
 * separately.
 *
 * Pages are **virtualised**: every page gets a correctly-sized placeholder
 * immediately, so the scrollbar tells the truth from the first frame, and only
 * pages near the viewport are actually drawn. A 948-page textbook cannot be
 * rasterised in one go, and the first attempt at this rendered a chapter's
 * worth of pages in a loop and showed nothing at all until it finished.
 */

interface PdfDocumentLike {
  numPages: number
  getPage: (n: number) => Promise<PdfPageLike>
}

interface PdfPageLike {
  getViewport: (options: { scale: number }) => Viewport
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: Viewport }) => {
    promise: Promise<void>
    cancel?: () => void
  }
  getTextContent: () => Promise<{ items: unknown[] }>
}

interface Viewport {
  width: number
  height: number
  scale: number
}

interface PdfjsLike {
  getDocument: (options: unknown) => { promise: Promise<PdfDocumentLike> }
  GlobalWorkerOptions: { workerSrc: string }
  renderTextLayer?: (options: unknown) => { promise: Promise<void> }
  TextLayer?: new (options: unknown) => { render: () => Promise<void> }
}

let libPromise: Promise<PdfjsLike | null> | null = null

async function pdfjs(): Promise<PdfjsLike | null> {
  libPromise ??= (async () => {
    try {
      const lib = (await import('pdfjs-dist')) as unknown as PdfjsLike
      lib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'
      return lib
    } catch (error) {
      console.error(`PDF rendering unavailable: ${String(error)}`)
      return null
    }
  })()
  return libPromise
}

const documents = new Map<string, PdfDocumentLike>()

export async function openDocument(bookId: string): Promise<PdfDocumentLike | null> {
  const cached = documents.get(bookId)
  if (cached) return cached

  const lib = await pdfjs()
  const bytes = await window.lectern.scan.bytes(bookId)
  if (!lib || !bytes) return null

  const document = await lib.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: './cmaps/',
    cMapPacked: true,
    /*
      Vendored too, and all of them load-bearing. A book whose pages are JPEG
      2000 images renders entirely white without the OpenJPEG decoder, and the
      only sign of it is a console warning about `wasmUrl` -- which looks
      nothing like "every page in this book is blank".
    */
    wasmUrl: './wasm/',
    standardFontDataUrl: './standard_fonts/',
    iccUrl: './iccs/'
  }).promise

  documents.set(bookId, document)
  return document
}

/**
 * One page's text, for searching.
 *
 * Read in the renderer, where pdf.js runs its parsing in a Web Worker, rather
 * than in the main process, where the same library runs on the thread every
 * other request waits on. A first search of a thousand-page book reads every
 * page, and invariant 7 says reading is never blocked by work like that.
 *
 * Built exactly as the text layer is: each item's string, and a space where
 * the layer puts a `<br>` at the end of a line. The page is later searched in
 * the rendered layer, and the two have to agree on where every match is.
 */
export async function pageText(bookId: string, page: number): Promise<string> {
  const document = await openDocument(bookId)
  if (!document || page < 1 || page > document.numPages) return ''
  const content = await (await document.getPage(page)).getTextContent()
  return (content.items as { str?: string; hasEOL?: boolean }[])
    .map((item) => (item.str ?? '') + (item.hasEOL ? ' ' : ''))
    .join('')
}

/** A thumbnail of page one, for the shelf. */
export async function pdfCover(bookId: string, height = 320): Promise<string | null> {
  try {
    const document = await openDocument(bookId)
    if (!document) return null

    const page = await document.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: height / base.height })

    const canvas = window.document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) return null

    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: context, viewport }).promise

    return canvas.toDataURL('image/jpeg', 0.75)
  } catch {
    return null
  }
}

/** Margin left around a page, so it does not touch the edges of the pane. */
const PAGE_MARGIN = 48

/**
 * How far outside the viewport pages are kept drawn.
 *
 * Generous enough that scrolling never shows a blank page, small enough that a
 * long book holds a few dozen canvases rather than nine hundred.
 */
const RENDER_MARGIN = '150% 0px'

/** Beyond this many drawn pages, the ones furthest from view are released. */
const MAX_DRAWN = 24

export interface PdfView {
  /**
   * Scroll a page into view. Used by the outline, smoothly; a search result
   * asks for `instant`, since its landing is corrected as the page draws and an
   * animation in between only delays that.
   */
  goToPage: (page: number, instant?: boolean) => void
  /**
   * Draw a page now rather than when the scroll brings it into view. For a jump
   * that needs the page's text: waiting on the observer made the jump's timing
   * hostage to how promptly the browser delivered it.
   */
  drawPage: (page: number) => Promise<void>
  /** The page at the middle of the view, 1-based. What "the section I am in" is measured against. */
  currentPage: () => number
  /** Redraw at a new scale, keeping the reader where they were. */
  setZoom: (zoom: number) => Promise<void>
  zoom: () => number
  destroy: () => void
}

type OnPageRendered = (page: number, textLayer: HTMLElement) => void

/**
 * Render the whole document into `container` as a continuous scroller.
 *
 * `onPageRendered` fires as each page's text arrives, so the speech queue can
 * grow with the document rather than being built once from whatever happened to
 * be drawn at the time.
 */
export async function renderBook(
  container: HTMLElement,
  scroller: HTMLElement,
  bookId: string,
  initialZoom: number,
  onPageRendered: OnPageRendered
): Promise<PdfView | null> {
  const document = await openDocument(bookId)
  const lib = await pdfjs()
  if (!document) {
    container.textContent = 'This PDF could not be opened.'
    return null
  }

  let zoom = initialZoom
  let scale = 1
  const wrappers: HTMLElement[] = []
  const drawn = new Set<number>()
  const drawing = new Set<number>()

  // Page one decides the placeholder size for the rest. Documents with mixed
  // page sizes correct themselves as each page is actually drawn.
  const first = await document.getPage(1)
  const natural = first.getViewport({ scale: 1 })

  const computeScale = (): number => {
    const usable = Math.max(scroller.clientWidth - PAGE_MARGIN, 240)
    return Math.max((usable / natural.width) * zoom, 0.1)
  }

  const build = (): void => {
    scale = computeScale()
    const width = Math.ceil(natural.width * scale)
    const height = Math.ceil(natural.height * scale)

    container.replaceChildren()
    wrappers.length = 0
    drawn.clear()

    for (let number = 1; number <= document.numPages; number += 1) {
      const wrapper = window.document.createElement('div')
      wrapper.className = 'pdf-page'
      wrapper.dataset['page'] = String(number)
      wrapper.style.width = `${width}px`
      wrapper.style.height = `${height}px`
      wrappers.push(wrapper)
      container.append(wrapper)
    }
  }

  build()

  const draw = async (number: number): Promise<void> => {
    const wrapper = wrappers[number - 1]
    if (!wrapper || drawn.has(number) || drawing.has(number)) return
    drawing.add(number)

    try {
      const page = await document.getPage(number)
      const viewport = page.getViewport({ scale })

      // The placeholder was sized from page one; correct it now that the real
      // page is known, or a document of mixed page sizes drifts as it scrolls.
      wrapper.style.width = `${Math.ceil(viewport.width)}px`
      wrapper.style.height = `${Math.ceil(viewport.height)}px`

      const canvas = window.document.createElement('canvas')
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.ceil(viewport.width * ratio)
      canvas.height = Math.ceil(viewport.height * ratio)
      canvas.style.width = `${Math.ceil(viewport.width)}px`
      canvas.style.height = `${Math.ceil(viewport.height)}px`

      const context = canvas.getContext('2d')
      if (context) {
        context.scale(ratio, ratio)
        await page.render({ canvasContext: context, viewport }).promise
      }

      // The reader scrolled away, or the zoom changed, while this was drawing.
      if (!wrapper.isConnected) return

      const textLayer = window.document.createElement('div')
      textLayer.className = 'pdf-text-layer'
      wrapper.replaceChildren(canvas, textLayer)
      await addTextLayer(lib, page, viewport, textLayer)

      drawn.add(number)
      release()
      onPageRendered(number, textLayer)
    } catch {
      // One page failing is not a reason to lose the document.
    } finally {
      drawing.delete(number)
    }
  }

  /** Free canvases far from the viewport, so a long book stays bounded. */
  const release = (): void => {
    if (drawn.size <= MAX_DRAWN) return
    const middle = currentPage()
    const ordered = [...drawn].sort((a, b) => Math.abs(b - middle) - Math.abs(a - middle))

    for (const number of ordered) {
      if (drawn.size <= MAX_DRAWN) break
      const wrapper = wrappers[number - 1]
      if (!wrapper) continue
      // The size is kept, so releasing a page does not move everything below it.
      wrapper.replaceChildren()
      drawn.delete(number)
    }
  }

  const currentPage = (): number => {
    const middle = scroller.scrollTop + scroller.clientHeight / 2
    for (const [at, wrapper] of wrappers.entries()) {
      if (wrapper.offsetTop + wrapper.offsetHeight >= middle) return at + 1
    }
    return 1
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const number = Number((entry.target as HTMLElement).dataset['page'])
        if (Number.isInteger(number)) void draw(number)
      }
    },
    { root: scroller, rootMargin: RENDER_MARGIN }
  )

  const observeAll = (): void => {
    for (const wrapper of wrappers) observer.observe(wrapper)
  }
  observeAll()

  return {
    goToPage: (page: number, instant = false) => {
      const wrapper = wrappers[Math.max(0, Math.min(page, wrappers.length) - 1)]
      if (wrapper) scroller.scrollTo({ top: wrapper.offsetTop - 12, behavior: instant ? 'auto' : 'smooth' })
    },
    drawPage: (page: number) => draw(page),
    currentPage,
    setZoom: async (next: number) => {
      // Keep the reader on the page they were looking at rather than at the
      // same pixel offset, which means nothing once everything has resized.
      const anchor = currentPage()
      zoom = Math.max(0.4, Math.min(next, 4))
      observer.disconnect()
      build()
      observeAll()
      const wrapper = wrappers[anchor - 1]
      if (wrapper) scroller.scrollTop = wrapper.offsetTop - 12
      await draw(anchor)
    },
    zoom: () => zoom,
    destroy: () => observer.disconnect()
  }
}

/**
 * pdf.js's text layer, placed over the canvas.
 *
 * The API changed shape between major versions -- a `TextLayer` class in recent
 * builds, a `renderTextLayer` function before that -- so both are tried. Losing
 * it costs selection and word-follow but not the page itself, so a failure here
 * is quiet.
 */
async function addTextLayer(
  lib: PdfjsLike | null,
  page: PdfPageLike,
  viewport: Viewport,
  container: HTMLElement
): Promise<void> {
  if (!lib) return
  try {
    const textContent = await page.getTextContent()

    if (lib.TextLayer) {
      const layer = new lib.TextLayer({ textContentSource: textContent, container, viewport })
      await layer.render()
      return
    }
    if (lib.renderTextLayer) {
      await lib.renderTextLayer({ textContentSource: textContent, container, viewport }).promise
    }
  } catch {
    // Selection is a convenience; the page is the point.
  }
}

export function forgetDocument(bookId: string): void {
  documents.delete(bookId)
}
