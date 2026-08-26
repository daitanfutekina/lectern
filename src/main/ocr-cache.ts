import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Recognised pages, cached to disk. SPEC section 6.
 *
 * OCR is the slowest thing this application does -- a 600-page scan is roughly
 * an hour of work -- so the cost is paid once per book and survives restarts,
 * reinstalls, and closing the app halfway through.
 *
 * One file per page rather than one per book. A page is the unit of work, so it
 * is also the unit that has to survive being interrupted: a book-level file
 * would be rewritten constantly and lost entirely if the app closed mid-write.
 */

export interface CachedPage {
  readonly page: number
  readonly lines: readonly string[]
  readonly confidence: number
}

let root = ''

export function configureOcrCache(libraryRoot: string): void {
  root = join(libraryRoot, '.library', 'ocr-cache')
}

/**
 * Cache key for a document.
 *
 * The file's path, size and modification time together: renaming a book should
 * not discard an hour of work, but editing one must not serve stale text for a
 * page that has changed.
 */
export function documentKey(path: string, size: number, modified: number): string {
  return createHash('sha1').update(`${path}|${size}|${modified}`).digest('hex').slice(0, 16)
}

const pageFile = (key: string, page: number): string => join(root, key, `${page}.json`)

export async function readPage(key: string, page: number): Promise<CachedPage | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pageFile(key, page), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (!Array.isArray(record['lines'])) return null
    return {
      page,
      lines: record['lines'].filter((line): line is string => typeof line === 'string'),
      confidence: typeof record['confidence'] === 'number' ? record['confidence'] : 0
    }
  } catch {
    return null
  }
}

export async function writePage(key: string, entry: CachedPage): Promise<void> {
  try {
    await mkdir(join(root, key), { recursive: true })
    await writeFile(
      pageFile(key, entry.page),
      JSON.stringify({ lines: entry.lines, confidence: entry.confidence }),
      'utf8'
    )
  } catch {
    // A cache that cannot be written costs time on the next run and nothing
    // else. It must never stop the page being read now.
  }
}

/** Which pages of a range are already done, so a resumed job skips them. */
export async function cachedPages(key: string): Promise<Set<number>> {
  try {
    const names = await readdir(join(root, key))
    return new Set(
      names
        .map((name) => Number.parseInt(name.replace('.json', ''), 10))
        .filter((page) => Number.isInteger(page))
    )
  } catch {
    return new Set()
  }
}

export async function readRange(key: string, from: number, to: number): Promise<(CachedPage | null)[]> {
  const pages: (CachedPage | null)[] = []
  for (let page = from; page <= to; page += 1) pages.push(await readPage(key, page))
  return pages
}
