import { describe, expect, it } from 'vitest'
import {
  classifyDocumentAddFailure,
  classifyDocumentFailure,
  createAddedDocument,
  documentAddFailureMessage,
  missingDocumentBook,
  parseAddedDocuments,
  relocateAddedDocument
} from './added-document'

describe('added document classification', () => {
  it('classifies a missing path separately from an open failure', () => {
    expect(classifyDocumentFailure({ code: 'ENOENT' })).toBe('absent')
    expect(classifyDocumentFailure({ code: 'ENOTDIR' })).toBe('absent')
    expect(classifyDocumentFailure({ code: 'EACCES' })).toBe('failed-to-open')
    expect(classifyDocumentFailure(new Error('corrupt PDF'))).toBe('failed-to-open')
  })

  it('keeps legacy registry entries instead of filtering absent paths', () => {
    const entries = parseAddedDocuments([{ path: 'D:\\Books\\Signals.pdf', addedAt: 42 }])
    expect(entries).toEqual([
      {
        id: 'pdf:Signals.pdf',
        path: 'D:\\Books\\Signals.pdf',
        addedAt: 42,
        format: 'pdf',
        title: 'Signals'
      }
    ])
    expect(missingDocumentBook(entries[0]!)).toMatchObject({
      id: 'pdf:Signals.pdf',
      path: 'D:\\Books\\Signals.pdf',
      unavailable: 'file-moved'
    })
  })

  it('preserves the progress identity when a file is relocated and renamed', () => {
    const entry = createAddedDocument('D:\\Downloads\\Signals.pdf', 42)
    expect(entry).not.toBeNull()
    const relocated = relocateAddedDocument(entry!, 'E:\\Textbooks\\Signals-and-Systems.pdf')

    expect(relocated?.id).toBe('pdf:Signals.pdf')
    expect(relocated?.path).toBe('E:\\Textbooks\\Signals-and-Systems.pdf')
    expect(relocateAddedDocument(entry!, 'E:\\Textbooks\\Signals.epub')).toBeNull()
  })
})

describe('document add failures', () => {
  it('distinguishes unsupported, protected, corrupt, and unreadable files', () => {
    expect(classifyDocumentAddFailure('notes.txt')).toBe('unsupported')
    expect(classifyDocumentAddFailure('locked.epub', { name: 'DrmProtectedError' })).toBe('protected')
    expect(classifyDocumentAddFailure('broken.pdf', new Error('Invalid PDF'))).toBe('corrupt')
    expect(classifyDocumentAddFailure('missing.pdf', { code: 'ENOENT' })).toBe('unreadable')
  })

  it('names every failed file in one batch message', () => {
    expect(documentAddFailureMessage([
      { path: 'C:\\Books\\notes.txt', reason: 'unsupported' },
      { path: 'C:\\Books\\locked.epub', reason: 'protected' },
      { path: 'C:\\Books\\broken.pdf', reason: 'corrupt' }
    ])).toBe(
      'notes.txt — not supported (add a PDF or EPUB); ' +
      'locked.epub — DRM-protected and cannot be opened; ' +
      'broken.pdf — corrupt or not a valid document'
    )
  })
})
