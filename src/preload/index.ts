import { contextBridge, ipcRenderer } from 'electron'
import type { LibraryIndex } from '@shared/library'
import type { Bookmark, ChapterProgress, LibraryProgress, ReadingPosition } from '@shared/progress'
import type { Flag, FlagStore } from '@shared/flags'

/**
 * The bridge. SPEC section 10.
 *
 * Every capability the renderer has is named here by hand. `ipcRenderer` is
 * never exposed, and there is no generic invoke passthrough, so the renderer's
 * power is exactly this list and can be audited by reading it.
 */
const api = {
  library: {
    /** The current index, scanning once on first call. */
    get: (): Promise<LibraryIndex> => ipcRenderer.invoke('library:get'),
    /** Force a re-scan of the root, for when books changed on disk. */
    rescan: (): Promise<LibraryIndex> => ipcRenderer.invoke('library:rescan'),
    /** Raw Markdown for one chapter, or null if the book or file is unknown. */
    chapter: (bookId: string, file: string): Promise<string | null> =>
      ipcRenderer.invoke('library:chapter', bookId, file)
  },

  progress: {
    /** Every stored reading position and bookmark in the library. */
    get: (): Promise<LibraryProgress> => ipcRenderer.invoke('progress:get'),
    /** Store where the reader is. Writes are debounced on the other side. */
    record: (
      bookId: string,
      file: string,
      position: ReadingPosition,
      blocks: number
    ): Promise<ChapterProgress | null> =>
      ipcRenderer.invoke('progress:record', bookId, file, position, blocks),
    /** Note which chapter is open, without disturbing its stored position. */
    open: (bookId: string, file: string): Promise<LibraryProgress | null> =>
      ipcRenderer.invoke('progress:open', bookId, file)
  },

  math: {
    /**
     * Spoken forms for a batch of equations. Batched deliberately: a chapter
     * holds hundreds, and one round trip each would be hundreds of round trips.
     */
    speak: (
      items: ReadonlyArray<{ latex: string; display: boolean }>
    ): Promise<(string | null)[]> => ipcRenderer.invoke('math:speak', items),
    /** Register a book's macros before converting any of its equations. */
    configure: (macros: Readonly<Record<string, string>>): Promise<void> =>
      ipcRenderer.invoke('math:configure', macros)
  },

  flags: {
    /** Every flagged passage in the library. */
    get: (): Promise<FlagStore> => ipcRenderer.invoke('flags:get'),
    /** Record a passage. Also rewrites FLAGGED.md, the handoff document. */
    add: (flag: Omit<Flag, 'id' | 'createdAt'>): Promise<FlagStore> =>
      ipcRenderer.invoke('flags:add', flag),
    remove: (id: string): Promise<FlagStore> => ipcRenderer.invoke('flags:remove', id),
    /** Write INDEX.md: the whole library's chapters and headings, in one file. */
    exportIndex: (): Promise<string | null> => ipcRenderer.invoke('flags:export-index')
  },

  /** A source file changed on disk; the open chapter should be re-read. */
  onLibraryChange: (listener: (file: string) => void): (() => void) => {
    const handler = (_event: unknown, file: string): void => listener(file)
    ipcRenderer.on('library:changed', handler)
    return () => ipcRenderer.removeListener('library:changed', handler)
  },

  scan: {
    /** Raw bytes of a PDF, so the renderer can rasterise its pages. */
    bytes: (bookId: string): Promise<ArrayBuffer | null> =>
      ipcRenderer.invoke('scan:bytes', bookId),
    /** Pages of a range already recognised, in order; nulls are still to do. */
    cached: (
      bookId: string,
      from: number,
      to: number
    ): Promise<({ page: number; lines: string[]; confidence: number } | null)[]> =>
      ipcRenderer.invoke('scan:cached', bookId, from, to),
    /** Store one recognised page. */
    store: (
      bookId: string,
      page: number,
      lines: readonly string[],
      confidence: number
    ): Promise<void> => ipcRenderer.invoke('scan:store', bookId, page, lines, confidence)
  },

  bookmarks: {
    add: (
      bookId: string,
      file: string,
      position: ReadingPosition,
      label: string
    ): Promise<readonly Bookmark[] | null> =>
      ipcRenderer.invoke('bookmark:add', bookId, file, position, label),
    remove: (bookId: string, id: string): Promise<readonly Bookmark[] | null> =>
      ipcRenderer.invoke('bookmark:remove', bookId, id)
  }
} as const

export type LecternApi = typeof api

contextBridge.exposeInMainWorld('lectern', api)
