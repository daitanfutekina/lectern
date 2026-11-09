import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { LibraryIndex } from '@shared/library'
import type { Bookmark, ChapterProgress, LibraryProgress, ReadingPosition } from '@shared/progress'

import type { Flag, FlagStore } from '@shared/flags'
import type { PiperVoice, VoiceShape } from '@shared/voice'
import type { Settings } from '@shared/settings'
import type { PrepareProgress } from '@shared/speech-cache'
import type { VoiceDownloadProgress, VoiceDownloadResult } from '@shared/voice-download'

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
    /**
     * Add documents to the library, referenced where they live.
     *
     * Takes paths rather than files because only the main process should be
     * touching the filesystem.
     */
    add: (paths: readonly string[]): Promise<{ added: number; rejected: string[] }> =>
      ipcRenderer.invoke('library:add', paths),
    /** Choose the new path for a registered file while keeping its progress id. */
    locate: (
      bookId: string
    ): Promise<{
      located: boolean
      reason?: 'not-found' | 'cancelled' | 'wrong-format' | 'already-added' | 'unreadable'
    }> => ipcRenderer.invoke('library:locate', bookId),
    /**
     * Take an added document off the shelf, after the main process has asked.
     *
     * The file is never deleted and the book's progress is kept. `reason` says
     * why nothing happened: the reader cancelled, the book is one of ours, or
     * the file was placed in `pdfs/` or `epubs/` by hand and has to leave from
     * there.
     */
    remove: (
      bookId: string
    ): Promise<{ removed: boolean; reason?: 'not-found' | 'not-added' | 'placed-by-hand' | 'cancelled' }> =>
      ipcRenderer.invoke('library:remove', bookId),
    /**
     * The real path of a dropped file.
     *
     * `File.path` was removed from Electron; `webUtils` is the supported way to
     * get it, and it has to happen here because the renderer has no `webUtils`.
     */
    pathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
    /** When each added document joined the library, keyed by book id. */
    addedTimes: (): Promise<Record<string, number>> => ipcRenderer.invoke('library:added-times'),
    /** A book's cover as a data URL, where its format carries one. */
    cover: (bookId: string): Promise<string | null> => ipcRenderer.invoke('library:cover', bookId),
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
    /** Store the final position before a chapter or renderer goes away. */
    recordNow: (
      bookId: string,
      file: string,
      position: ReadingPosition,
      blocks: number
    ): ChapterProgress | null =>
      ipcRenderer.sendSync('progress:record-now', bookId, file, position, blocks),
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

  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    /** Apply a change; the whole record comes back revalidated. */
    set: (change: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke('settings:set', change),
    /** Open the library folder in the file manager. */
    reveal: (): Promise<void> => ipcRenderer.invoke('settings:reveal'),
    /** Choose a different library folder; the app restarts after a change. */
    changeLibrary: (): Promise<boolean> => ipcRenderer.invoke('settings:change-library')
  },

  voice: {
    /** Neural voices present on disk. Empty until one is installed. */
    list: (): Promise<PiperVoice[]> => ipcRenderer.invoke('voice:list'),
    /** Download the built-in free Piper voice. No request happens before this call. */
    download: (): Promise<VoiceDownloadResult> => ipcRenderer.invoke('voice:download'),
    cancelDownload: (): Promise<void> => ipcRenderer.invoke('voice:cancel-download'),
    onDownloadProgress: (listener: (progress: VoiceDownloadProgress) => void): (() => void) => {
      const handler = (_event: unknown, progress: VoiceDownloadProgress): void => listener(progress)
      ipcRenderer.on('voice:download-progress', handler)
      return () => ipcRenderer.removeListener('voice:download-progress', handler)
    },
    /**
     * Synthesise one utterance. Returns 16-bit PCM for the renderer to play,
     * because the main process has no audio output and the renderer already
     * owns the queue.
     */
    speak: (
      voiceId: string,
      text: string,
      shape: VoiceShape,
      speed: number,
      character?: string | null,
      semitones?: number,
      indexRate?: number,
      protect?: number
    ): Promise<{ pcm: Int16Array; sampleRate: number } | null> =>
      ipcRenderer.invoke(
        'voice:speak',
        voiceId,
        text,
        shape,
        speed,
        character,
        semitones,
        indexRate,
        protect
      ),
    /** Where voices are installed, for the message shown when there are none. */
    folder: (): Promise<string> => ipcRenderer.invoke('voice:folder'),
    /**
     * Character voices installed, and whether the shared models they all run
     * through are present. Asked together because the settings page has to
     * distinguish "none installed" from "installed but missing its encoders".
     */
    characters: (): Promise<{ names: string[]; ready: boolean; folder: string }> =>
      ipcRenderer.invoke('voice:characters'),

    /**
     * Prepare a chapter's sentences in the background.
     *
     * The renderer hands over the sentence list because it is the side that
     * walked the document and knows what will actually be spoken -- including
     * the equations it turned into words.
     */
    prepare: (
      bookId: string,
      file: string,
      sentences: readonly string[],
      voiceId: string,
      shape: VoiceShape,
      speed: number,
      character: string,
      semitones: number,
      indexRate: number,
      protect: number
    ): Promise<void> =>
      ipcRenderer.invoke(
        'voice:prepare',
        bookId,
        file,
        sentences,
        voiceId,
        shape,
        speed,
        character,
        semitones,
        indexRate,
        protect
      ),
    cancelPrepare: (): Promise<void> => ipcRenderer.invoke('voice:cancelPrepare'),

    /** How far the background job has got. Fires once per sentence. */
    onPrepared: (listener: (progress: PrepareProgress) => void): (() => void) => {
      const handler = (_event: unknown, progress: PrepareProgress): void => listener(progress)
      ipcRenderer.on('voice:prepared', handler)
      return () => ipcRenderer.removeListener('voice:prepared', handler)
    },

    /** Disk used by prepared speech, and a way to reclaim it. */
    storeSize: (): Promise<{ files: number; bytes: number }> =>
      ipcRenderer.invoke('voice:storeSize'),
    clearStore: (): Promise<void> => ipcRenderer.invoke('voice:clearStore')
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

  /** Ctrl +, Ctrl - or Ctrl 0, forwarded so the document zooms instead of the window. */
  onZoomKey: (listener: (direction: 'in' | 'out' | 'reset') => void): (() => void) => {
    const handler = (_event: unknown, direction: 'in' | 'out' | 'reset'): void => listener(direction)
    ipcRenderer.on('zoom:key', handler)
    return () => ipcRenderer.removeListener('zoom:key', handler)
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
