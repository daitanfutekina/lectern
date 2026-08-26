import { pagesToHtml, preprocess, recognisePage, renderPage, type PageText, type PdfPageLike } from './ocr'

/**
 * The background OCR job. SPEC section 6 and invariant 7.
 *
 * Reading is never blocked. A page is recognised, cached, and the chapter is
 * rebuilt around it, so the reader watches a scan fill in rather than watching
 * a spinner. A 600-page book is roughly an hour of this, which is why it has to
 * be resumable, has to show progress, and has to be abandonable the moment the
 * reader opens something else.
 */

export interface ScanProgress {
  readonly done: number
  readonly total: number
  readonly running: boolean
  readonly failed: number
}

type OnPage = (pages: readonly PageText[]) => void
type OnProgress = (progress: ScanProgress) => void

let pdfjsPromise: Promise<PdfjsLike | null> | null = null

interface PdfjsLike {
  getDocument: (options: unknown) => { promise: Promise<{ getPage: (n: number) => Promise<PdfPageLike> }> }
  GlobalWorkerOptions: { workerSrc: string }
}

async function pdfjs(): Promise<PdfjsLike | null> {
  pdfjsPromise ??= (async () => {
    try {
      const lib = (await import('pdfjs-dist')) as unknown as PdfjsLike
      // Vendored, not fetched: SPEC invariant 2. pdf.js otherwise reaches for a
      // CDN copy of its worker and fails silently offline.
      lib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'
      return lib
    } catch (error) {
      console.error(`PDF rendering unavailable: ${String(error)}`)
      return null
    }
  })()
  return pdfjsPromise
}

/**
 * A running job. Held so opening another chapter can stop the previous one --
 * without that, three chapters of a long book would fight over one CPU and all
 * three would crawl.
 */
let active: { cancelled: boolean } | null = null

export function cancelScan(): void {
  if (active) active.cancelled = true
  active = null
}

/**
 * Recognise a page range, newest results first to the caller.
 *
 * Cached pages are delivered immediately and in one go, so reopening a chapter
 * already read is instant; only the gaps are recognised.
 */
export async function scanRange(
  bookId: string,
  from: number,
  to: number,
  onPage: OnPage,
  onProgress: OnProgress
): Promise<void> {
  cancelScan()
  const job = { cancelled: false }
  active = job

  const total = to - from + 1
  const results = new Map<number, PageText>()
  let failed = 0

  const report = (running: boolean): void =>
    onProgress({ done: results.size, total, running, failed })

  // Anything already recognised comes back at once.
  const cached = await window.lectern.scan.cached(bookId, from, to)
  cached.forEach((entry, at) => {
    if (entry) results.set(from + at, { page: from + at, lines: entry.lines, confidence: entry.confidence })
  })

  if (results.size > 0) {
    onPage(ordered(results))
    report(results.size < total)
  }
  if (job.cancelled) return
  if (results.size === total) {
    report(false)
    return
  }

  const lib = await pdfjs()
  const bytes = await window.lectern.scan.bytes(bookId)
  if (!lib || !bytes || job.cancelled) {
    report(false)
    return
  }

  const document = await lib.getDocument({
    data: new Uint8Array(bytes),
    // Vendored too. Without these, any page using a CID-keyed font renders its
    // glyphs as blanks -- and a blank page recognises as an empty one.
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
  report(true)

  for (let page = from; page <= to; page += 1) {
    if (job.cancelled) return
    if (results.has(page)) continue

    try {
      const rendered = preprocess(await renderPage(await document.getPage(page)))
      if (job.cancelled) return

      const recognised = await recognisePage(rendered, page)
      if (job.cancelled) return

      if (recognised) {
        results.set(page, recognised)
        void window.lectern.scan.store(bookId, page, recognised.lines, recognised.confidence)
        // Delivered as each page lands, so a chapter fills in while it is read
        // rather than appearing all at once at the end.
        onPage(ordered(results))
      } else {
        failed += 1
      }
    } catch (error) {
      failed += 1
      console.warn(`OCR failed on page ${page}: ${String(error)}`)
    }

    report(page < to)
  }

  report(false)
  if (active === job) active = null
}

const ordered = (results: Map<number, PageText>): PageText[] =>
  [...results.values()].sort((a, b) => a.page - b.page)

export { pagesToHtml }
