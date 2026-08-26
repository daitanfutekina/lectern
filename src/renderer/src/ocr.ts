/**
 * Reading a scanned page. SPEC section 6.
 *
 * OCR exists here for one reason: to produce speakable text from pages that
 * carry only pixels. It is not a search index and its output is never presented
 * as a text layer, which narrows the requirements a great deal --
 * **reading order and junk removal matter more than word accuracy**, because a
 * listener's ear corrects a misread word but cannot recover from a page read in
 * the wrong order.
 *
 * Everything is local. Tesseract's worker, its WebAssembly core and the English
 * language data are all vendored under `public/tesseract`, because the defaults
 * fetch them from a CDN and SPEC invariant 2 does not allow that.
 *
 * It runs in the renderer because rendering a PDF page to an image needs a
 * canvas, and the alternative is a native canvas binding in the main process --
 * the packaging pain this project has avoided everywhere else.
 */

import { assemblePage, cleanPage, repeatedLines, type TextItem } from '@shared/pdf-text'

const BASE = './tesseract'

interface TesseractWorker {
  recognize: (image: unknown) => Promise<{ data: { text: string; confidence: number } }>
  terminate: () => Promise<void>
  setParameters: (params: Record<string, string>) => Promise<void>
}

let workerPromise: Promise<TesseractWorker | null> | null = null

/**
 * One worker for the session.
 *
 * Starting it costs a second or two and loading the language data costs more,
 * so a worker per page would spend most of its time starting up. It is created
 * on first use rather than at launch: a library of Markdown books should never
 * pay for OCR it does not need.
 */
async function worker(): Promise<TesseractWorker | null> {
  workerPromise ??= (async () => {
    try {
      const { createWorker } = await import('tesseract.js')
      return (await createWorker('eng', 1, {
        workerPath: `${BASE}/worker.min.js`,
        corePath: BASE,
        langPath: `${BASE}/lang`,
        // The data is vendored uncompressed alongside the app; without this
        // tesseract.js looks for a `.gz` it expects to have downloaded.
        gzip: true
      })) as unknown as TesseractWorker
    } catch (error) {
      console.error(`OCR unavailable: ${String(error)}`)
      return null
    }
  })()
  return workerPromise
}

export interface PageImage {
  readonly canvas: HTMLCanvasElement
  readonly width: number
  readonly height: number
}

/**
 * Render one PDF page to a canvas at a resolution worth reading.
 *
 * Scan quality dominates OCR accuracy far more than engine choice does, and the
 * single cheapest improvement is resolution: a page rendered at screen size
 * gives Tesseract about 90 DPI, well under the 300 it is tuned for. Upscaling
 * to roughly 300 DPI is worth more than any parameter on the engine.
 */
export async function renderPage(page: PdfPageLike, targetDpi = 300): Promise<PageImage> {
  const base = page.getViewport({ scale: 1 })
  // A PDF point is 1/72 inch, so this is the scale that reaches targetDpi.
  const scale = Math.min(targetDpi / 72, 4)
  const viewport = page.getViewport({ scale })

  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)

  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('No 2D context for page rendering')

  // White behind the page: a transparent background reads as black once
  // flattened, and Tesseract then sees a solid rectangle.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)

  await page.render({ canvasContext: context, viewport, background: '#ffffff' }).promise

  void base
  return { canvas, width: canvas.width, height: canvas.height }
}

/**
 * Grey, stretch, then threshold.
 *
 * Tesseract does its own binarisation and does it well on clean input. What it
 * handles badly is low contrast -- a grey photocopy, a yellowed page -- so the
 * useful preprocessing is to stretch the range before it decides. Deskewing is
 * deliberately absent: Tesseract already corrects small rotations, and a
 * hand-rolled deskew that guesses wrong makes a readable page unreadable.
 */
export function preprocess(image: PageImage): PageImage {
  const context = image.canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return image

  const data = context.getImageData(0, 0, image.width, image.height)
  const pixels = data.data

  let min = 255
  let max = 0
  const grey = new Uint8Array(pixels.length / 4)

  for (let i = 0, g = 0; i < pixels.length; i += 4, g += 1) {
    // Rec. 601 luma: green carries most of the perceived brightness.
    const value = (pixels[i]! * 299 + pixels[i + 1]! * 587 + pixels[i + 2]! * 114) / 1000
    grey[g] = value
    if (value < min) min = value
    if (value > max) max = value
  }

  const range = Math.max(max - min, 1)
  for (let i = 0, g = 0; i < pixels.length; i += 4, g += 1) {
    const stretched = ((grey[g]! - min) / range) * 255
    pixels[i] = stretched
    pixels[i + 1] = stretched
    pixels[i + 2] = stretched
    pixels[i + 3] = 255
  }

  context.putImageData(data, 0, 0)
  return image
}

export interface PageText {
  readonly page: number
  readonly lines: readonly string[]
  readonly confidence: number
}

/** Recognise one already-rendered page. */
export async function recognisePage(image: PageImage, page: number): Promise<PageText | null> {
  const engine = await worker()
  if (!engine) return null

  const result = await engine.recognize(image.canvas)
  const lines = result.data.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return { page, lines, confidence: result.data.confidence }
}

/**
 * Turn recognised pages into the same shape the digital PDF adapter produces,
 * so everything downstream cannot tell them apart.
 *
 * Hyphen rejoining and furniture removal are shared with the digital path
 * deliberately: a running head is a running head however the text was obtained,
 * and OCR produces more of them, not fewer.
 */
export function pagesToHtml(pages: readonly PageText[]): string {
  const asParagraphs = pages.map((page) => joinWrapped(page.lines))
  const repeated = repeatedLines(asParagraphs)

  const html: string[] = []
  for (const [at, paragraphs] of asParagraphs.entries()) {
    const kept = cleanPage(paragraphs, repeated)
    if (kept.length === 0) continue
    const number = pages[at]?.page ?? at + 1
    html.push(`<p class="page-mark" data-speak="no">Page ${number}</p>`)
    for (const paragraph of kept) html.push(`<p>${escapeHtml(paragraph)}</p>`)
  }
  return html.join('\n')
}

/**
 * Join OCR lines into paragraphs.
 *
 * Tesseract emits one line per visual line, so a paragraph arrives as six
 * fragments. A blank line separates paragraphs; a trailing hyphen means a word
 * was split and must be put back together, since "consider-" and "ation" spoken
 * as two words is the most audible defect in the whole pipeline.
 */
function joinWrapped(lines: readonly string[]): string[] {
  const paragraphs: string[] = []
  let current = ''

  for (const line of lines) {
    if (!line) {
      if (current) paragraphs.push(current.trim())
      current = ''
      continue
    }
    if (!current) current = line
    else if (current.endsWith('-')) current = current.slice(0, -1) + line
    else current = `${current} ${line}`

    // A line ending in sentence punctuation and short of the margin is the end
    // of a paragraph rather than a wrap.
    if (/[.!?]["')\]]?$/.test(line) && line.length < 45) {
      paragraphs.push(current.trim())
      current = ''
    }
  }

  if (current.trim()) paragraphs.push(current.trim())
  return paragraphs
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Minimal shape of a pdf.js page, so this module needs no pdf.js types. */
export interface PdfPageLike {
  getViewport: (options: { scale: number }) => { width: number; height: number }
  render: (options: {
    canvasContext: CanvasRenderingContext2D
    viewport: unknown
    background?: string
  }) => { promise: Promise<void> }
  getTextContent: () => Promise<{ items: TextItem[] }>
}

/** The digital path, for pages that turn out to have usable text after all. */
export async function textLayerOf(page: PdfPageLike): Promise<string[]> {
  const content = await page.getTextContent()
  return assemblePage(content.items)
}

export async function shutdownOcr(): Promise<void> {
  const engine = await workerPromise
  if (engine) await engine.terminate()
  workerPromise = null
}
