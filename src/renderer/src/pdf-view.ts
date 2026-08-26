/**
 * Showing a PDF as a PDF. SPEC section 3, as amended.
 *
 * The first version of this extracted the text and rendered it in the
 * application's own theme, which threw away the thing the reader asked for. A
 * PDF is a laid-out page: its figures, its equations, its margins are the
 * document. Reading a PDF means seeing it.
 *
 * Pages are drawn to canvases, and pdf.js's own text layer is placed over each
 * one -- invisible, positioned to match the glyphs. That is what gives
 * selection, and it is also what lets word-follow highlight a spoken word on a
 * page made of pixels.
 */

interface PdfDocumentLike {
  numPages: number
  getPage: (n: number) => Promise<PdfPageLike>
}

interface PdfPageLike {
  getViewport: (options: { scale: number }) => Viewport
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: Viewport }) => {
    promise: Promise<void>
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
    cMapPacked: true
  }).promise

  documents.set(bookId, document)
  return document
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

export interface PdfViewOptions {
  readonly from: number
  readonly to: number
  /** Multiplier applied on top of the fit-to-width scale. */
  readonly zoom: number
  /** Pixels available to the page, so it can be fitted to them. */
  readonly availableWidth: number
}

/** Margin left around a page, so it does not touch the edges of the pane. */
const PAGE_MARGIN = 48

/**
 * The scale that fits a page to the pane.
 *
 * A fixed zoom cannot work: page sizes vary, panes are resizable, and a fixed
 * 1.35 made a US Letter page wider than the window and cut the right-hand
 * margin off every line. Fitting to width is what a PDF reader does, and the
 * zoom multiplier then means what a reader expects it to mean.
 */
function fitScale(pageWidth: number, available: number, zoom: number): number {
  const usable = Math.max(available - PAGE_MARGIN, 240)
  return Math.max((usable / pageWidth) * zoom, 0.1)
}

/**
 * Render a page range into a container.
 *
 * Pages are drawn one at a time and appended as they finish, so a fifty-page
 * chapter shows its first page immediately rather than nothing for ten seconds.
 */
export async function renderPages(
  container: HTMLElement,
  bookId: string,
  options: PdfViewOptions,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const document = await openDocument(bookId)
  const lib = await pdfjs()
  if (!document) {
    container.textContent = 'This PDF could not be opened.'
    return
  }

  container.replaceChildren()
  const total = options.to - options.from + 1
  let done = 0

  for (let number = options.from; number <= options.to; number += 1) {
    // The container was replaced by another chapter while this was running.
    if (!container.isConnected) return

    const page = await document.getPage(number)
    const natural = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({
      scale: fitScale(natural.width, options.availableWidth, options.zoom)
    })

    const wrapper = window.document.createElement('div')
    wrapper.className = 'pdf-page'
    wrapper.dataset['page'] = String(number)
    wrapper.style.width = `${Math.ceil(viewport.width)}px`
    wrapper.style.height = `${Math.ceil(viewport.height)}px`

    const canvas = window.document.createElement('canvas')
    // Drawn at device resolution and displayed at CSS resolution, or the page
    // is soft on any screen that is not exactly 1x.
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
    wrapper.append(canvas)

    const textLayer = window.document.createElement('div')
    textLayer.className = 'pdf-text-layer'
    wrapper.append(textLayer)
    await addTextLayer(lib, page, viewport, textLayer)

    container.append(wrapper)
    done += 1
    onProgress?.(done, total)
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
