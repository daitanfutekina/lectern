/**
 * EPUB structure. SPEC section 3.
 *
 * An EPUB is a ZIP holding XHTML, a manifest of what is in it, and a spine
 * saying what order to read it in. So an EPUB reader is an HTML reader plus a
 * chapter order, and everything downstream of here -- rendering, speech,
 * reading position -- is the machinery that already exists.
 *
 * Parsing is by pattern rather than by XML tree. The two files involved are
 * small, machine-generated, and rigidly specified, and the alternative is an
 * XML parser in the main process for two files. Every assumption it makes is
 * covered by a test.
 */

export interface EpubItem {
  readonly id: string
  /** Path within the archive, already resolved against the OPF's own folder. */
  readonly href: string
  readonly mediaType: string
  /** EPUB 3 `properties`, which is where `cover-image` is declared. */
  readonly properties: string | null
}

export interface EpubStructure {
  readonly title: string | null
  readonly author: string | null
  readonly language: string | null
  /** Documents in reading order. */
  readonly spine: readonly EpubItem[]
  /** Everything the manifest lists, by id. */
  readonly manifest: Readonly<Record<string, EpubItem>>
  /** EPUB 2 declares its cover as a meta tag naming a manifest id. */
  readonly coverId: string | null
}

export const EMPTY_EPUB: EpubStructure = {
  title: null,
  author: null,
  language: null,
  spine: [],
  manifest: {},
  coverId: null
}

const decode = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')

/** Attribute value from a tag, tolerant of either quote style. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag)
  const raw = match?.[2] ?? match?.[3]
  return raw === undefined ? null : decode(raw)
}

/**
 * Where the OPF lives, from `META-INF/container.xml`.
 *
 * The path is not fixed by the specification and real files disagree about it,
 * so it must be read rather than assumed.
 */
export function opfPath(containerXml: string): string | null {
  for (const tag of containerXml.match(/<rootfile\b[^>]*>/g) ?? []) {
    const path = attribute(tag, 'full-path')
    if (path) return path.replace(/^\/+/, '')
  }
  return null
}

/**
 * Resolve an href against the folder holding the OPF.
 *
 * Manifest hrefs are relative to the OPF, not to the archive root, and the two
 * coincide often enough that assuming it works until it suddenly does not.
 */
export function resolveHref(opf: string, href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href

  const base = opf.includes('/') ? opf.slice(0, opf.lastIndexOf('/')) : ''
  const parts = (base ? `${base}/${href}` : href).split('/')
  const stack: string[] = []

  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

/** Parse the OPF into metadata, manifest and spine. */
export function parseOpf(opfXml: string, opfLocation: string): EpubStructure {
  const manifest: Record<string, EpubItem> = {}

  for (const tag of opfXml.match(/<item\b[^>]*>/g) ?? []) {
    const id = attribute(tag, 'id')
    const href = attribute(tag, 'href')
    if (!id || !href) continue
    manifest[id] = {
      id,
      href: resolveHref(opfLocation, href),
      mediaType: attribute(tag, 'media-type') ?? '',
      properties: attribute(tag, 'properties')
    }
  }

  const spine: EpubItem[] = []
  for (const tag of opfXml.match(/<itemref\b[^>]*>/g) ?? []) {
    const idref = attribute(tag, 'idref')
    // `linear="no"` marks matter outside the reading sequence -- covers, notes
    // panels. Reading it aloud in place would interrupt the book.
    if (!idref || attribute(tag, 'linear') === 'no') continue
    const item = manifest[idref]
    if (item) spine.push(item)
  }

  const meta = (name: string): string | null => {
    const match = new RegExp(`<dc:${name}\\b[^>]*>([\\s\\S]*?)</dc:${name}>`).exec(opfXml)
    const value = match?.[1]?.replace(/<[^>]*>/g, '').trim()
    return value ? decode(value) : null
  }

  // EPUB 2: <meta name="cover" content="cover-image-id"/>
  const coverMeta = /<meta[^>]*name\s*=\s*["']cover["'][^>]*>/i.exec(opfXml)?.[0]

  return {
    title: meta('title'),
    author: meta('creator'),
    language: meta('language'),
    spine,
    manifest,
    coverId: coverMeta ? attribute(coverMeta, 'content') : null
  }
}

/**
 * Titles that carry no information. Converters emit these by the thousand, and
 * a chapter list reading "Unknown" seven times is worse than one built from the
 * headings underneath.
 */
const EMPTY_TITLES = new Set(['unknown', 'untitled', 'no title', 'document', 'page', 'chapter'])

/**
 * A readable chapter title, since EPUB spines carry ids rather than names.
 *
 * The document's own `<title>` or first heading is what a reader recognises;
 * the file name is the last resort and usually says `chapter_007`.
 */
export function titleFromDocument(xhtml: string, fallback: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(xhtml)?.[1]
  const cleanTitle = title?.replace(/<[^>]*>/g, '').trim()
  if (cleanTitle && !EMPTY_TITLES.has(cleanTitle.toLowerCase())) return decode(cleanTitle)

  const heading = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(xhtml)?.[1]
  const cleanHeading = heading?.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  if (cleanHeading) return decode(cleanHeading)

  return fallback
}

/**
 * Strip an XHTML document down to what belongs in the reader.
 *
 * Scripts go because nothing in a book needs to run. Styles go because the
 * application supplies the design -- SPEC invariant 3, and a book bringing its
 * own stylesheet is exactly the drift that invariant exists to prevent.
 */
export function bodyOf(xhtml: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(xhtml)?.[1] ?? xhtml
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .trim()
}
