import { contextBridge, ipcRenderer } from 'electron'
import type { LibraryIndex } from '@shared/library'
import type { Bookmark, ChapterProgress, LibraryProgress, ReadingPosition } from '@shared/progress'

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
