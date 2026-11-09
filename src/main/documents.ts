import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import {
  createAddedDocument,
  documentFormat,
  parseAddedDocuments,
  relocateAddedDocument,
  type AddedDocument
} from '@shared/added-document'

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
    documents = parseAddedDocuments(JSON.parse(await readFile(storePath(), 'utf8')))
  } catch {
    documents = []
  }
  loaded = true
  return documents
}

async function persist(): Promise<void> {
  const target = storePath()
  const temporary = `${target}.tmp`
  try {
    await mkdir(join(root, '.library'), { recursive: true })
    await writeFile(temporary, JSON.stringify(documents, null, 2), 'utf8')
    await rename(temporary, target)
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

    const entry = createAddedDocument(path, Date.now())
    if (!entry) {
      rejected.push(path)
      continue
    }
    documents.push(entry)
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

export async function findAddedDocumentById(id: string): Promise<AddedDocument | null> {
  const all = await loadDocuments()
  return all.find((entry) => entry.id === id) ?? null
}

export type RelocateResult = 'relocated' | 'not-found' | 'wrong-format' | 'already-added' | 'unreadable'

/** Update only a registry path; the id is the progress key and must not change. */
export async function relocateDocument(id: string, path: string): Promise<RelocateResult> {
  await loadDocuments()
  const at = documents.findIndex((entry) => entry.id === id)
  if (at < 0) return 'not-found'

  const current = documents[at]
  if (!current || documentFormat(path) !== current.format) return 'wrong-format'
  if (
    documents.some(
      (entry, index) => index !== at && resolve(entry.path).toLowerCase() === resolve(path).toLowerCase()
    )
  ) {
    return 'already-added'
  }
  try {
    if (!(await stat(path)).isFile()) return 'unreadable'
  } catch {
    return 'unreadable'
  }

  const relocated = relocateAddedDocument(current, path)
  if (!relocated) return 'wrong-format'
  documents = documents.map((entry, index) => (index === at ? relocated : entry))
  await persist()
  return 'relocated'
}

export async function removeDocument(path: string): Promise<void> {
  await loadDocuments()
  const before = documents.length
  documents = documents.filter((entry) => entry.path.toLowerCase() !== path.toLowerCase())
  if (documents.length !== before) await persist()
}
