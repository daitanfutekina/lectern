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
  /** `<spine toc="...">`, naming the NCX in the manifest. EPUB 2's table of contents. */
  readonly ncxId: string | null
}

export const EMPTY_EPUB: EpubStructure = {
  title: null,
  author: null,
  language: null,
  spine: [],
  manifest: {},
  coverId: null,
  ncxId: null
}

const FONT_OBFUSCATION_ALGORITHMS = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC'
])

/**
 * Whether an EPUB encryption manifest describes protected content.
 *
 * EPUB uses the same manifest for DRM and for reversible font obfuscation.
 * The latter does not protect the book's text and must not make the reader
 * reject an otherwise readable EPUB.
 */
export function hasDrmEncryption(encryptionXml: string): boolean {
  const entries = encryptionXml.match(
    /<(?:[A-Za-z_][\w.-]*:)?EncryptedData\b[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?EncryptedData\s*>/gi
  ) ?? []

  return entries.some((entry) => {
    const method = /<(?:[A-Za-z_][\w.-]*:)?EncryptionMethod\b[^>]*\bAlgorithm\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(entry)
    const algorithm = method?.[1] ?? method?.[2]
    return !algorithm || !FONT_OBFUSCATION_ALGORITHMS.has(algorithm)
  })
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
  const coverMeta = /<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i.exec(opfXml)?.[0]
  const spineTag = /<spine\b[^>]*>/i.exec(opfXml)?.[0]

  return {
    title: meta('title'),
    author: meta('creator'),
    language: meta('language'),
    spine,
    manifest,
    coverId: coverMeta ? attribute(coverMeta, 'content') : null,
    ncxId: spineTag ? attribute(spineTag, 'toc') : null
  }
}

/**
 * The book's own table of contents, whichever of the two forms it ships.
 *
 * EPUB 3 declares a navigation document with `properties="nav"`; EPUB 2 points
 * the spine at an NCX. Both are read because publishers ship both and neither
 * is reliably present -- and without one, chapter titles fall back to whatever
 * heading a document happens to open with, which in a real book is as likely
 * to be the bare chapter number as the title.
 */
export function navigationOf(
  structure: EpubStructure,
  read: (href: string) => string | null
): NavEntry[] {
  const navItem = Object.values(structure.manifest).find((item) =>
    item.properties?.split(/\s+/).includes('nav')
  )
  if (navItem) {
    const source = read(navItem.href)
    const entries = source ? parseNavXhtml(source, navItem.href) : []
    if (entries.length > 0) return entries
  }

  const ncxItem = structure.ncxId ? structure.manifest[structure.ncxId] : undefined
  if (ncxItem) {
    const source = read(ncxItem.href)
    if (source) return parseNcx(source, ncxItem.href)
  }
  return []
}

/* ── The navigation document ────────────────────────────────────────── */

/**
 * One entry in the book's own table of contents.
 *
 * `depth` is 0 for a top-level entry and rises with nesting, which is what
 * separates a chapter from the sections inside it.
 */
export interface NavEntry {
  /** Archive path, already resolved. The fragment is kept separately. */
  readonly href: string
  /** The `#id` the entry points at, or null for the top of the document. */
  readonly fragment: string | null
  readonly label: string
  readonly depth: number
}

/** Split `text/ch05.xhtml#ch05lev1sec1` into its two halves. */
export function splitHref(href: string): { path: string; fragment: string | null } {
  const hash = href.indexOf('#')
  if (hash < 0) return { path: href, fragment: null }
  return { path: href.slice(0, hash), fragment: href.slice(hash + 1) || null }
}

/** Tag soup to plain text, for a label that may wrap its words in markup. */
const textOf = (html: string): string =>
  decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()

/**
 * The EPUB 3 navigation document: `<nav epub:type="toc">` holding nested lists.
 *
 * Depth comes from counting list nesting rather than from parsing a tree,
 * which is the same trade the rest of this module makes: the file is
 * machine-generated and rigidly specified, and an XML parser for one document
 * is not worth the dependency.
 */
export function parseNavXhtml(xhtml: string, navLocation: string): NavEntry[] {
  // The toc nav specifically. A file may also carry a page-list or a landmarks
  // nav, and those are not the table of contents.
  const nav =
    /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(xhtml)?.[1]
  if (!nav) return []

  const entries: NavEntry[] = []
  let depth = -1

  // One pass over the list tags and anchors, in document order.
  for (const match of nav.matchAll(/<(\/?)(ol|a)\b([^>]*)>([\s\S]*?)(?=<)/gi)) {
    const closing = match[1] === '/'
    const tag = (match[2] ?? '').toLowerCase()

    if (tag === 'ol') {
      depth += closing ? -1 : 1
      continue
    }
    if (closing) continue

    const href = attribute(`<a ${match[3] ?? ''}>`, 'href')
    const label = textOf(match[4] ?? '')
    if (!href || !label) continue

    const { path, fragment } = splitHref(href)
    entries.push({
      href: resolveHref(navLocation, path),
      fragment,
      label,
      depth: Math.max(0, depth)
    })
  }
  return entries
}

/**
 * The EPUB 2 navigation map, from the NCX the spine's `toc` attribute names.
 *
 * Still worth reading in an EPUB 3 file: publishers ship both, and a book that
 * carries only the NCX is not rare enough to treat as broken.
 */
export function parseNcx(ncxXml: string, ncxLocation: string): NavEntry[] {
  const entries: NavEntry[] = []
  let depth = -1

  for (const match of ncxXml.matchAll(
    /<(\/?)navPoint\b[^>]*>|<navLabel\b[^>]*>([\s\S]*?)<\/navLabel>|<content\b([^>]*)>/gi
  )) {
    const whole = match[0]

    if (/^<navPoint/i.test(whole)) {
      depth += 1
      continue
    }
    if (/^<\/navPoint/i.test(whole)) {
      depth -= 1
      continue
    }
    if (/^<navLabel/i.test(whole)) {
      // The label arrives before the content it labels, so it is held until
      // the `<content>` that follows names the file.
      entries.push({ href: '', fragment: null, label: textOf(match[2] ?? ''), depth })
      continue
    }

    const src = attribute(`<content ${match[3] ?? ''}>`, 'src')
    const pending = entries[entries.length - 1]
    if (!src || !pending || pending.href) continue

    const { path, fragment } = splitHref(src)
    entries[entries.length - 1] = {
      ...pending,
      href: resolveHref(ncxLocation, path),
      fragment
    }
  }

  return entries.filter((entry) => entry.href && entry.label)
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
