import type { Book, DocumentFormat } from './library'

export type AddedDocumentFormat = Extract<DocumentFormat, 'pdf' | 'epub'>

/** The durable identity and display fallback for a deliberately added file. */
export interface AddedDocument {
  readonly id: string
  readonly path: string
  readonly addedAt: number
  readonly format: AddedDocumentFormat
  readonly title: string
}

export type DocumentFailure = 'absent' | 'failed-to-open'

export type DocumentAddFailureReason = 'unsupported' | 'protected' | 'corrupt' | 'unreadable'

export interface DocumentAddFailure {
  readonly path: string
  readonly reason: DocumentAddFailureReason
}

export interface DocumentAddResult {
  readonly added: number
  readonly duplicates: number
  readonly failures: readonly DocumentAddFailure[]
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function documentFormat(path: string): AddedDocumentFormat | null {
  const lower = fileName(path).toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.epub')) return 'epub'
  return null
}

/** Classify an import failure without exposing an implementation error to the reader. */
export function classifyDocumentAddFailure(
  path: string,
  error?: unknown
): DocumentAddFailureReason {
  if (!documentFormat(path)) return 'unsupported'

  const detail = error && typeof error === 'object'
    ? error as { readonly name?: unknown; readonly code?: unknown }
    : {}
  if (detail.name === 'DrmProtectedError' || detail.name === 'PasswordException') return 'protected'
  if (typeof detail.code === 'string') return 'unreadable'
  return 'corrupt'
}

/** One compact message for a batch, so T16 can replace its presentation in one place. */
export function documentAddFailureMessage(failures: readonly DocumentAddFailure[]): string {
  const description: Record<Exclude<DocumentAddFailureReason, 'protected'>, string> = {
    unsupported: 'not supported (add a PDF or EPUB)',
    corrupt: 'corrupt or not a valid document',
    unreadable: 'could not be read'
  }
  return failures
    .map((failure) => {
      const why = failure.reason === 'protected'
        ? documentFormat(failure.path) === 'epub'
          ? 'DRM-protected and cannot be opened'
          : 'password-protected and no password was provided'
        : description[failure.reason]
      return `${fileName(failure.path)} — ${why}`
    })
    .join('; ')
}

/** New entries keep this id when their path changes, because progress is keyed by it. */
export function createAddedDocument(path: string, addedAt: number): AddedDocument | null {
  const format = documentFormat(path)
  if (!format) return null
  const name = fileName(path)
  return {
    id: `${format}:${name}`,
    path,
    addedAt,
    format,
    title: name.replace(/\.(?:pdf|epub)$/i, '')
  }
}

/** Parse both the current registry and legacy path/addedAt-only entries. */
export function parseAddedDocuments(value: unknown): AddedDocument[] {
  if (!Array.isArray(value)) return []

  const parsed: AddedDocument[] = []
  for (const valueEntry of value) {
    if (!valueEntry || typeof valueEntry !== 'object') continue
    const entry = valueEntry as Partial<AddedDocument>
    if (typeof entry.path !== 'string') continue
    const fallback = createAddedDocument(entry.path, typeof entry.addedAt === 'number' ? entry.addedAt : 0)
    if (!fallback) continue
    parsed.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : fallback.id,
      path: entry.path,
      addedAt: fallback.addedAt,
      format: entry.format === 'pdf' || entry.format === 'epub' ? entry.format : fallback.format,
      title: typeof entry.title === 'string' && entry.title ? entry.title : fallback.title
    })
  }
  return parsed
}

/** Missing is actionable; every other filesystem/open failure remains an open error. */
export function classifyDocumentFailure(error: unknown): DocumentFailure {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'failed-to-open'
}

/** Change only the location. Identity and progress must survive a rename or move. */
export function relocateAddedDocument(entry: AddedDocument, path: string): AddedDocument | null {
  if (documentFormat(path) !== entry.format) return null
  return { ...entry, path }
}

/** Shelf representation for a registry entry whose path is absent. */
export function missingDocumentBook(entry: AddedDocument): Book {
  return {
    id: entry.id,
    title: entry.title,
    format: entry.format,
    path: entry.path,
    chapters: [],
    parts: [],
    macros: {},
    unavailable: 'file-moved'
  }
}
