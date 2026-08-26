import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { bodyOf, opfPath, parseOpf, titleFromDocument, type EpubStructure } from '@shared/epub'
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

  const chapters: Chapter[] = structure.spine.map((item) => {
    const raw = entries[item.href]
    const xhtml = raw ? strFromU8(raw) : ''
    const body = bodyOf(xhtml)
    // Word counts drive the reading-time estimate, and tags are not words.
    const words = (body.replace(/<[^>]*>/g, ' ').match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length

    return {
      file: item.href,
      title: titleFromDocument(xhtml, basename(item.href).replace(/\.[^.]+$/, '')),
      crumb: structure.title,
      headings: headingsOf(xhtml),
      words
    }
  })

  const book: EpubBook = { structure, chapters, entries }
  opened.set(path, book)
  return book
}

function headingsOf(xhtml: string): string[] {
  return [...xhtml.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
    .map((match) => (match[1] ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** One chapter's HTML, ready for the renderer. */
export async function epubChapter(path: string, href: string): Promise<string | null> {
  const book = await openEpub(path)
  // The href must be one the spine already listed, or a crafted name could
  // reach any entry in the archive.
  if (!book.chapters.some((chapter) => chapter.file === href)) return null

  const raw = book.entries[href]
  return raw ? bodyOf(strFromU8(raw)) : null
}
