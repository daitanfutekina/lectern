/**
 * Files a chapter refers to, and frames a chapter embeds.
 *
 * The authoring rules ask for figures, and a figure can be a PNG beside the
 * chapter or an interactive page embedded in it. Neither worked: a chapter is
 * rendered into the application's own page, so `<img src="diagram.png">`
 * resolved against the application and asked for a file the renderer bundle
 * does not have. And the page's security policy allowed no frames at all, so an
 * embed rendered as nothing -- not a placeholder, nothing.
 *
 * A chapter's relative references are rewritten to `book://local/<id>/<path>`,
 * which the main process serves out of that book's folder and nowhere else. The
 * rules that make that safe are here, as strings, so they are testable without
 * a filesystem; `src/main` only joins the result onto a real path.
 */

export const ASSET_SCHEME = 'book'
export const ASSET_HOST = 'local'

/**
 * What a book folder may serve.
 *
 * Media, and the pieces an embedded widget is built from. Not Markdown: a
 * chapter's source is the library's business, and nothing in a figure needs to
 * fetch one. The stylesheet entry does not reintroduce per-book design
 * (invariant 3) -- a stylesheet served here can only style the embedded page
 * that asks for it, which is a document of its own inside a frame.
 */
export const ASSET_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript',
  css: 'text/css',
  json: 'application/json'
}

/** A reference that already says where it goes, and so is left alone. */
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i

/**
 * The `book://` URL for a reference found in a chapter, or null to leave it.
 *
 * Resolved against the chapter's own folder, the way a browser would resolve it
 * against a page. A reference that climbs out of the book (`../other-book/x`)
 * is refused here rather than trusted to the server: the server refuses it too,
 * but a chapter that silently reached into another book would be a bug the
 * reader could not see.
 */
export function assetUrl(bookId: string, chapterFile: string, reference: string): string | null {
  const trimmed = reference.trim()
  if (!trimmed || ABSOLUTE.test(trimmed)) return null

  const [pathPart = '', ...rest] = trimmed.split(/(?=[?#])/)
  const suffix = rest.join('')

  const folder = chapterFile.includes('/') ? chapterFile.slice(0, chapterFile.lastIndexOf('/')) : ''
  const segments = safeSegments(folder ? `${folder}/${pathPart}` : pathPart)
  if (!segments) return null

  return (
    `${ASSET_SCHEME}://${ASSET_HOST}/${encodeURIComponent(bookId)}/` +
    segments.map((segment) => encodeURIComponent(segment)).join('/') +
    suffix
  )
}

/**
 * A relative path as clean segments, or null if it is not one.
 *
 * Refused outright rather than normalised: a backslash, a drive letter, a
 * climb above the start, or an empty result. Normalising `a/../../b` to `b`
 * would be friendlier and would also be the exact move a traversal relies on.
 */
export function safeSegments(path: string): string[] | null {
  if (path.includes('\\') || path.includes('\0') || /^[a-z]:/i.test(path)) return null

  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    // A dotfile or dot-folder is tooling, not a figure: `.git`, `.library`,
    // an editor's settings. Nothing a chapter shows lives in one.
    if (segment.startsWith('.')) return null
    out.push(segment)
  }
  return out.length > 0 ? out : null
}

/** A `book://` request taken apart: which book, which file inside it, what type. */
export function parseAssetUrl(
  url: string
): { bookId: string; segments: string[]; type: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:` || parsed.hostname !== ASSET_HOST) return null

  let raw: string[]
  try {
    raw = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
  } catch {
    return null
  }
  const [bookId, ...rest] = raw
  if (!bookId || rest.length === 0) return null

  // Decoded segments are checked again: `%2e%2e` and `%2f` are the traversal
  // that a check on the encoded form never sees.
  const segments = safeSegments(rest.join('/'))
  if (!segments || rest.some((part) => part.includes('/'))) return null

  const name = segments[segments.length - 1] ?? ''
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const type = ASSET_TYPES[extension]
  if (!type) return null

  return { bookId, segments, type }
}

/**
 * The sandbox an embedded frame gets.
 *
 * The danger in a sandbox is not scripts and not same-origin, but the two
 * together on a frame that *shares the application's origin*: that frame can
 * reach up into the page and remove its own sandbox, and the page holds the
 * bridge to the filesystem. So:
 *
 * - A remote `https:` page keeps its own origin, which cannot reach this one.
 *   It needs `allow-same-origin` to work at all -- a video player without
 *   storage refuses to play -- and granting it there is safe.
 * - Anything else, a book's own widget included, runs scripts in an opaque
 *   origin and can touch nothing outside itself.
 *
 * An earlier note in the authoring guide said to sandbox every embed without
 * `allow-same-origin`. That would have broken most real embeds while guarding
 * against a danger remote pages never posed.
 */
export function frameSandbox(src: string): string {
  let protocol = ''
  try {
    protocol = new URL(src).protocol
  } catch {
    protocol = ''
  }
  return protocol === 'https:'
    ? 'allow-scripts allow-same-origin allow-popups allow-presentation'
    : 'allow-scripts'
}
