import { contextBridge, ipcRenderer } from 'electron'
import type { LibraryIndex } from '@shared/library'

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
  }
} as const

export type LecternApi = typeof api

contextBridge.exposeInMainWorld('lectern', api)
