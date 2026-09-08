import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import {
  bodyOf,
  navigationOf,
  opfPath,
  parseOpf,
  resolveHref,
  titleFromDocument,
  type EpubStructure,
  type NavEntry
} from '@shared/epub'
import type { Chapter } from '@shared/library'

/**
 * Reading an EPUB. SPEC section 3.
 *
 * A ZIP of XHTML, so this unzips and hands the documents to the renderer, which
 * already knows how to display and speak HTML. Nothing downstream of here needs
 * to know the format existed.
 */

export interface EpubBook {
  readonly structure: EpubStructure
  readonly chapters: readonly Chapter[]
  /** Archive entries, kept so chapter bodies can be served without re-reading. */
  readonly entries: Readonly<Record<string, Uint8Array>>
}

/**
 * Archives are held for the session rather than re-read per chapter. A book is
 * a few megabytes and turning a page should not re-inflate it.
 */
const opened = new Map<string, EpubBook>()

export class DrmProtectedError extends Error {
  constructor() {
    super('This EPUB is DRM-protected and cannot be opened.')
  }
}

export async function openEpub(path: string): Promise<EpubBook> {
  const cached = opened.get(path)
  if (cached) return cached

  const entries = unzipSync(new Uint8Array(await readFile(path)))

  // DRM is a wall, not a bug. Saying so plainly beats failing later with
  // something that looks like corruption.
  if (Object.keys(entries).some((name) => name.endsWith('META-INF/encryption.xml'))) {
    throw new DrmProtectedError()
  }

  const container = entries['META-INF/container.xml']
  if (!container) throw new Error('Not an EPUB: no META-INF/container.xml')

  const opf = opfPath(strFromU8(container))
  if (!opf || !entries[opf]) throw new Error('Not an EPUB: the package file is missing')

  const structure = parseOpf(strFromU8(entries[opf]), opf)

  /*
    The book's own table of contents, in preference to anything scraped.

    A publisher's chapter opens `<h2>5</h2>` with the title in a styled
    paragraph underneath, so the first heading -- which is what this used to
    fall back on -- named every chapter after its number. The navigation
    document says "5. Deployability", and it is the only place that does.
  */
  const nav = navigationOf(structure, (href) => {
    const raw = entries[href]
    return raw ? strFromU8(raw) : null
  })
  const labels = navLabels(nav)

  const chapters: Chapter[] = structure.spine.map((item) => {
    const raw = entries[item.href]
    const xhtml = raw ? strFromU8(raw) : ''
    const body = bodyOf(xhtml)
    // Word counts drive the reading-time estimate, and tags are not words.
    const words = (body.replace(/<[^>]*>/g, ' ').match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length

    return {
      file: item.href,
      title:
        labels.get(item.href) ??
        titleFromDocument(xhtml, basename(item.href).replace(/\.[^.]+$/, '')),
      crumb: structure.title,
      headings: sectionsOf(nav, item.href, xhtml),
      words
    }
  })

  const book: EpubBook = { structure, chapters, entries }
  opened.set(path, book)
  return book
}

/**
 * The title each spine document goes by, from the navigation.
 *
 * A chapter and every section inside it point at the same file, so the
 * shallowest entry wins: that is the one naming the document rather than a
 * place within it.
 */
function navLabels(nav: readonly NavEntry[]): Map<string, string> {
  const labels = new Map<string, string>()
  const depths = new Map<string, number>()

  for (const entry of nav) {
    const seen = depths.get(entry.href)
    if (seen !== undefined && seen <= entry.depth) continue
    depths.set(entry.href, entry.depth)
    labels.set(entry.href, entry.label)
  }
  return labels
}

/**
 * The sections within one document.
 *
 * From the navigation where it has them, because a book's own contents knows
 * which headings are sections and which are the chapter's own title. Scraping
 * is the fallback, and it takes h2 *and* h3: a publisher who titles a chapter
 * with h2 numbers its sections h3, and reading only h2 found one "section"
 * per chapter, named after the chapter number.
 */
function sectionsOf(nav: readonly NavEntry[], href: string, xhtml: string): string[] {
  const mine = nav.filter((entry) => entry.href === href)
  if (mine.length > 1) {
    const top = Math.min(...mine.map((entry) => entry.depth))
    const deeper = mine.filter((entry) => entry.depth > top).map((entry) => entry.label)
    if (deeper.length > 0) return deeper
  }
  return headingsOf(xhtml)
}

function headingsOf(xhtml: string): string[] {
  return [...xhtml.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
    .map((match) => (match[1] ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * The book's cover, as a data URL.
 *
 * EPUB gives three ways to declare one and real files use all three, so all
 * three are tried: the `cover-image` property, a `<meta name="cover">` pointing
 * at a manifest id, and failing both, the first image whose href looks like a
 * cover.
 */
export async function epubCover(path: string): Promise<string | null> {
  const book = await openEpub(path)
  const items = Object.values(book.structure.manifest)

  const byProperty = items.find((item) => item.properties?.includes('cover-image'))
  const byMeta = book.structure.coverId ? book.structure.manifest[book.structure.coverId] : undefined
  const byName = items.find(
    (item) => item.mediaType.startsWith('image/') && /cover/i.test(item.href)
  )
  const item = byProperty ?? byMeta ?? byName
  if (!item) return null

  const raw = book.entries[item.href]
  if (!raw || raw.byteLength > 4_000_000) return null

  const type = item.mediaType || 'image/jpeg'
  return `data:${type};base64,${Buffer.from(raw).toString('base64')}`
}

/**
 * One chapter as a complete, self-contained HTML document.
 *
 * SPEC section 3, as amended: an EPUB keeps its own typography. That is part of
 * the book and not ours to replace -- the "one stylesheet" rule exists to stop
 * *our* seven textbooks diverging, and applying it here was a mistake that
 * repainted every downloaded book in our own colours.
 *
 * Everything the document references has to be inlined, because it will be
 * rendered in an isolated frame that cannot reach inside the archive: the
 * stylesheets it links, and the images it shows.
 */
export async function epubDocument(path: string, href: string): Promise<string | null> {
  const book = await openEpub(path)
  // The href must be one the spine already listed, or a crafted name could
  // reach any entry in the archive.
  if (!book.chapters.some((chapter) => chapter.file === href)) return null

  const raw = book.entries[href]
  if (!raw) return null

  let html = strFromU8(raw)
    /*
      The XML prolog has to go. These files are XHTML and carry
      `<?xml version="1.0"?>` at the top; an HTML parser reads that as a bogus
      comment, which pushes the DOCTYPE out of first position and leaves the
      document in quirks mode. Rendered in a frame the result was an empty body
      and a chapter that produced no speech at all.
    */
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')

  html = inlineStylesheets(html, book, href)
  html = inlineImages(html, book, href)
  return html
}

/** Replace `<link rel=stylesheet>` with the archive's own CSS. */
function inlineStylesheets(html: string, book: EpubBook, from: string): string {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/stylesheet/i.test(tag)) return ''
    const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)
    const target = href?.[2] ?? href?.[3]
    if (!target) return ''

    const entry = book.entries[resolveHref(from, target)]
    if (!entry) return ''
    return `<style>${strFromU8(entry)}</style>`
  })
}

/**
 * Replace image sources with data URLs.
 *
 * A relative `src` inside an isolated frame resolves to nothing, so every
 * illustration in every EPUB would be a broken-image icon.
 */
function inlineImages(html: string, book: EpubBook, from: string): string {
  return html.replace(/(<(?:img|image)\b[^>]*?(?:src|xlink:href)\s*=\s*)("([^"]*)"|'([^']*)')/gi,
    (whole, prefix: string, _quoted: string, doubleQuoted?: string, singleQuoted?: string) => {
      const target = doubleQuoted ?? singleQuoted
      if (!target || /^(data:|https?:)/i.test(target)) return whole

      const path = resolveHref(from, target)
      const entry = book.entries[path]
      if (!entry || entry.byteLength > 3_000_000) return whole

      const type = guessImageType(path)
      return `${prefix}"data:${type};base64,${Buffer.from(entry).toString('base64')}"`
    }
  )
}

function guessImageType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'svg') return 'image/svg+xml'
  if (extension === 'webp') return 'image/webp'
  return 'image/jpeg'
}
