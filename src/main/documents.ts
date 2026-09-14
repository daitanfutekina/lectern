import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'

/**
 * Documents the reader added deliberately. SPEC section 3, as amended.
 *
 * `books/` is scanned because it holds our own textbooks. Nothing else is found
 * automatically: a reader's disk holds hundreds of PDFs they have no wish to
 * see in a library, and a library that fills itself with them is not a library.
 *
 * Added documents are **referenced where they live**, not copied. A 90 MB
 * textbook should not become 180 MB because it was opened once, and a reader
 * who moves their own file expects the library to notice rather than to keep
 * serving a stale duplicate.
 */

export interface AddedDocument {
  readonly path: string
  readonly addedAt: number
}

const ACCEPTED = new Set(['.pdf', '.epub'])

let root = ''
let documents: AddedDocument[] = []
let loaded = false

export function configureDocuments(libraryRoot: string): void {
  root = libraryRoot
  documents = []
  loaded = false
}

const storePath = (): string => join(root, '.library', 'documents.json')

export async function loadDocuments(): Promise<AddedDocument[]> {
  if (loaded) return documents
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath(), 'utf8'))
    documents = Array.isArray(parsed)
      ? parsed
          .filter(
            (entry): entry is AddedDocument =>
              Boolean(entry) && typeof (entry as AddedDocument).path === 'string'
          )
          .map((entry) => ({ path: entry.path, addedAt: entry.addedAt ?? 0 }))
      : []
  } catch {
    documents = []
  }
  loaded = true
  return documents
}

async function persist(): Promise<void> {
  try {
    await mkdir(join(root, '.library'), { recursive: true })
    await writeFile(storePath(), JSON.stringify(documents, null, 2), 'utf8')
  } catch {
    // The document is still open; it just will not be there next time.
  }
}

export interface AddResult {
  readonly added: number
  readonly rejected: readonly string[]
}

/**
 * Add files, ignoring anything that is not a document and anything already
 * present. Returns what was refused so the reader is told rather than left
 * wondering why a file they dropped did not appear.
 */
export async function addDocuments(paths: readonly string[]): Promise<AddResult> {
  await loadDocuments()

  const known = new Set(documents.map((entry) => entry.path.toLowerCase()))
  const rejected: string[] = []
  let added = 0

  for (const path of paths) {
    if (!ACCEPTED.has(extname(path).toLowerCase())) {
      rejected.push(path)
      continue
    }
    if (known.has(path.toLowerCase())) continue

    try {
      const info = await stat(path)
      if (!info.isFile()) {
        rejected.push(path)
        continue
      }
    } catch {
      rejected.push(path)
      continue
    }

    documents.push({ path, addedAt: Date.now() })
    known.add(path.toLowerCase())
    added += 1
  }

  if (added > 0) await persist()
  return { added, rejected }
}

/**
 * The stored entry for a path, if the reader added it.
 *
 * Compared resolved and case-folded: the book's path is rebuilt by joining a
 * folder and a file name, the stored one is whatever the drop reported, and on
 * Windows the two can differ in separators and case while naming one file.
 */
export async function findAddedDocument(path: string): Promise<AddedDocument | null> {
  const wanted = resolve(path).toLowerCase()
  const all = await loadDocuments()
  return all.find((entry) => resolve(entry.path).toLowerCase() === wanted) ?? null
}

export async function removeDocument(path: string): Promise<void> {
  await loadDocuments()
  const before = documents.length
  documents = documents.filter((entry) => entry.path.toLowerCase() !== path.toLowerCase())
  if (documents.length !== before) await persist()
}

/** Paths that still exist, so a moved or deleted file quietly drops out. */
export async function livingDocuments(): Promise<AddedDocument[]> {
  const all = await loadDocuments()
  const alive: AddedDocument[] = []
  for (const entry of all) {
    try {
      if ((await stat(entry.path)).isFile()) alive.push(entry)
    } catch {
      // Gone. Left in the store rather than deleted: a file on a drive that is
      // not plugged in right now has not been thrown away.
    }
  }
  return alive
}
