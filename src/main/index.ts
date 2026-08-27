import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_ROOT, readChapterSource, saveIndex, scanLibrary } from './library'
import { configureMath, speakMath } from './math-speech'
import { pdfBytes } from './pdf'
import { epubCover } from './epub'
import { cachedPages, configureOcrCache, documentKey, readRange, writePage } from './ocr-cache'
import { addFlag, configureFlags, exportIndex, loadFlags, removeFlag } from './flags'
import { watchLibrary } from './watch'
import { addDocuments, configureDocuments, livingDocuments } from './documents'
import {
  characterDir,
  charactersReady,
  configurePiper,
  listCharacters,
  listVoices,
  speak as speakPiper
} from './piper'
import { configureSettings, loadSettings, saveSettings } from './settings'
import { cancelPrepare, prepareChapter } from './prepare'
import {
  clearSpeechStore,
  configureSpeechStore,
  readSpeech,
  speechStoreSize,
  writeSpeech
} from './speech-store'
import type { SpeechRequest } from '@shared/speech-cache'
import { BOOK_VOICE, clampShape, type VoiceShape } from '@shared/voice'
import { flagId, type Flag, type FlagKind } from '@shared/flags'
import {
  addBookmark,
  flushProgress,
  getProgress,
  loadProgress,
  recordOpen,
  recordPosition,
  removeBookmark
} from './progress'
import { findBook } from '@shared/library'
import { bookmarkId } from '@shared/progress'
import type { LibraryIndex } from '@shared/library'
import type { ReadingPosition } from '@shared/progress'

/**
 * The renderer is served from `app://` rather than `file://`.
 *
 * A `file://` page is not a real origin, and the restrictions that follow from
 * that broke two things outright: Tesseract could not `importScripts` inside
 * its worker, and the Speech Rule Engine hung fetching its rule files. Both are
 * ordinary web behaviour that only fails on `file://`.
 *
 * Registering a standard, secure scheme costs a few lines and removes the whole
 * class of problem, rather than working around each instance of it.
 */
const SCHEME = 'app'

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

/**
 * Main process: window, filesystem, library index. Nothing here renders.
 *
 * SPEC section 10. The renderer is a reading surface with no Node access, and
 * every capability it has is listed by hand in the preload bridge.
 */

let cached: LibraryIndex | null = null

async function library(rescan = false): Promise<LibraryIndex> {
  if (!cached || rescan) {
    cached = await scanLibrary(root())
    void saveIndex(cached)
  }
  return cached
}

/**
 * The library root.
 *
 * Overridable so the application can be pointed at a scratch library for
 * verification. Testing against the reader's own shelf means putting files on
 * it, and a library that fills up with test fixtures is exactly what this
 * application is supposed to stop happening.
 */
function root(): string {
  return process.env['LECTERN_ROOT'] || DEFAULT_ROOT
}

/**
 * IPC arguments arrive as `unknown` and are shaped by the renderer, which is
 * the least trusted process. Nothing is stored without being checked here.
 */
function isPosition(value: unknown): value is ReadingPosition {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['block'] === 'number' && typeof candidate['within'] === 'number'
}

/**
 * The two conversion controls, clamped to the ranges the converter behaves in.
 *
 * Both change the audio, so both are checked here and both are part of what
 * identifies a stored sentence: a slider that appears to do nothing because the
 * old audio came back is a worse bug than a cache that misses.
 */
function conversion(indexRate: unknown, protect: unknown): { indexRate: number; protect: number } {
  return {
    indexRate:
      typeof indexRate === 'number' && Number.isFinite(indexRate)
        ? Math.min(Math.max(indexRate, 0), 1)
        : 0.75,
    protect:
      typeof protect === 'number' && Number.isFinite(protect)
        ? Math.min(Math.max(protect, 0), 0.5)
        : 0.33
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    // Width is overridable so a resize can be verified end to end: the point
    // of anchoring to blocks is that reopening narrower lands on the same
    // paragraph, not the same pixel.
    width: Number(process.env['LECTERN_WIDTH']) || 1100,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    title: 'Lectern',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The renderer reads books. It has no reason to touch Node, and the
      // sandbox is what keeps a malformed chapter from mattering.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Paint only once there is something to show, rather than flashing an empty
  // frame while the library scan runs.
  //
  // A verification run stays hidden and silent. It is still the real
  // application doing real work, but it must not take the screen or start
  // talking over whoever is using the machine.
  const verifying = Boolean(process.env['LECTERN_CAPTURE'])
  if (verifying) window.webContents.setAudioMuted(true)
  else window.once('ready-to-show', () => window.show())

  /*
    The window itself never zooms.

    Chromium's Ctrl+/- scales the whole interface, and it *persists per origin
    in the session* -- so zooming out once left the application small on every
    later launch with no obvious way back, because Ctrl+= is a different
    keystroke from Ctrl+- and was never reaching it. Zoom belongs to the page
    being read, not to the application around it.
  */
  window.webContents.setVisualZoomLevelLimits(1, 1)
  window.webContents.on('did-finish-load', () => {
    window.webContents.setZoomFactor(1)
    window.webContents.setZoomLevel(0)
  })

  // Swallow the browser's own zoom keys and hand them to the renderer, which
  // applies them to the document rather than to the window.
  window.webContents.on('before-input-event', (event, input) => {
    if (!input.control && !input.meta) return
    const key = input.key
    if (key === '+' || key === '=' || key === '-' || key === '_' || key === '0') {
      event.preventDefault()
      window.webContents.send('zoom:key', key === '0' ? 'reset' : key === '-' || key === '_' ? 'out' : 'in')
    }
  })

  // A link in a book opens in the real browser. Nothing navigates this window
  // away from the reader.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadURL(`${SCHEME}://lectern/index.html`)
  }

  return window
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.lectern.app')
  configureOcrCache(root())
  configureFlags(root())
  configureDocuments(root())
  configurePiper(root())
  configureSettings(root())
  configureSpeechStore(root())
  serveRenderer()

  ipcMain.handle('library:get', () => library())
  ipcMain.handle('library:rescan', () => library(true))

  ipcMain.handle('math:configure', (_event, macros: unknown) => {
    configureMath(
      macros && typeof macros === 'object' ? (macros as Record<string, string>) : {}
    )
  })

  ipcMain.handle('math:speak', async (_event, items: unknown) => {
    if (!Array.isArray(items)) return []
    const cleaned = items
      .filter(
        (item): item is { latex: string; display: boolean } =>
          Boolean(item) && typeof item.latex === 'string' && typeof item.display === 'boolean'
      )
      .slice(0, 2000)
    return speakMath(cleaned)
  })

  ipcMain.handle('settings:get', () => loadSettings())

  ipcMain.handle('settings:set', async (_event, change: unknown) => {
    if (typeof change !== 'object' || change === null) return loadSettings()
    return saveSettings(change as Record<string, never>)
  })

  ipcMain.handle('settings:reveal', async () => {
    await shell.openPath(root())
  })

  ipcMain.handle('voice:list', () => listVoices())
  ipcMain.handle('voice:folder', () => join(root(), '.library', 'voices'))

  /*
    Character voices are reported as a list of names, and as whether the two
    shared models they all need are actually on disk. Those are separate
    questions: a reader can have unpacked a character and not the 700 MB of
    encoders it runs through, and the settings page should say so rather than
    offer a voice that will silently do nothing.
  */
  /*
    Prepare a chapter ahead of reading it.

    The renderer owns the sentence split -- it is the one that walked the
    document and knows what will actually be spoken, including the equations it
    turned into words -- so it hands the list over rather than having the main
    process guess at it a second time.
  */
  ipcMain.handle(
    'voice:prepare',
    (
      _event,
      bookId: unknown,
      file: unknown,
      sentences: unknown,
      voiceId: unknown,
      shape: unknown,
      speed: unknown,
      character: unknown,
      semitones: unknown,
      indexRate: unknown,
      protect: unknown
    ) => {
      if (typeof bookId !== 'string' || typeof file !== 'string') return
      if (!Array.isArray(sentences) || typeof voiceId !== 'string') return
      if (typeof character !== 'string' || !character) return

      prepareChapter(
        bookId,
        file,
        sentences.filter((line): line is string => typeof line === 'string' && line.trim().length > 0),
        {
          voiceId,
          shape: clampShape(shape && typeof shape === 'object' ? (shape as VoiceShape) : BOOK_VOICE),
          speed:
            typeof speed === 'number' && Number.isFinite(speed)
              ? Math.min(Math.max(speed, 0.5), 3)
              : 1,
          character,
          semitones:
            typeof semitones === 'number' && Number.isFinite(semitones)
              ? Math.round(Math.min(Math.max(semitones, -12), 12))
              : 0,
          ...conversion(indexRate, protect)
        }
      )
    }
  )

  ipcMain.handle('voice:cancelPrepare', () => cancelPrepare())
  ipcMain.handle('voice:storeSize', () => speechStoreSize())
  ipcMain.handle('voice:clearStore', () => clearSpeechStore())

  ipcMain.handle('voice:characters', async () => ({
    names: await listCharacters(),
    ready: await charactersReady(),
    folder: characterDir()
  }))

  ipcMain.handle(
    'voice:speak',
    async (
      _event,
      voiceId: unknown,
      text: unknown,
      shape: unknown,
      speed: unknown,
      character: unknown,
      semitones: unknown,
      indexRate: unknown,
      protect: unknown
    ) => {
      if (typeof voiceId !== 'string' || typeof text !== 'string' || !text.trim()) return null

      const request: SpeechRequest = {
        text,
        voiceId,
        shape: clampShape(shape && typeof shape === 'object' ? (shape as VoiceShape) : BOOK_VOICE),
        speed:
          typeof speed === 'number' && Number.isFinite(speed)
            ? Math.min(Math.max(speed, 0.5), 3)
            : 1,
        character: typeof character === 'string' && character ? character : null,
        semitones:
          typeof semitones === 'number' && Number.isFinite(semitones)
            ? Math.round(Math.min(Math.max(semitones, -12), 12))
            : 0,
        ...conversion(indexRate, protect)
      }

      /*
        The store first.

        A prepared chapter is entirely made of hits, which is the whole point of
        preparing it: reading a sentence off disk is instant, and converting one
        takes about as long as saying it.
      */
      const stored = await readSpeech(request)
      if (stored) return { pcm: stored.pcm, sampleRate: stored.sampleRate }

      const result = await speakPiper(
        request.voiceId,
        request.text,
        request.shape,
        request.speed,
        request.character
          ? {
              name: request.character,
              semitones: request.semitones,
              indexRate: request.indexRate,
              protect: request.protect
            }
          : undefined
      )
      if (!result) return null
      // Kept, so the next time through this sentence is free. Not awaited: the
      // reader is waiting on the audio, not on the disk.
      void writeSpeech(request, result)
      // Structured clone carries a typed array across intact, so the samples do
      // not have to be copied into a plain array on the way.
      return { pcm: result.pcm, sampleRate: result.sampleRate }
    }
  )

  ipcMain.handle('flags:get', () => loadFlags())

  ipcMain.handle('flags:add', async (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) return loadFlags()
    const candidate = input as Record<string, unknown>
    const text = typeof candidate['text'] === 'string' ? candidate['text'].trim() : ''
    // Without the passage there is nothing to find later, so there is nothing
    // worth storing.
    if (!text) return loadFlags()

    const now = Date.now()
    const flag: Flag = {
      id: flagId(now, Math.random()),
      book: typeof candidate['book'] === 'string' ? candidate['book'] : '',
      chapter: typeof candidate['chapter'] === 'string' ? candidate['chapter'] : '',
      kind: (typeof candidate['kind'] === 'string' ? candidate['kind'] : 'confusing') as FlagKind,
      text: text.slice(0, 4000),
      heading: typeof candidate['heading'] === 'string' ? candidate['heading'] : null,
      block: typeof candidate['block'] === 'number' ? candidate['block'] : 0,
      note: typeof candidate['note'] === 'string' ? candidate['note'].slice(0, 1000) : '',
      createdAt: now
    }
    return addFlag(flag, await library())
  })

  ipcMain.handle('flags:remove', async (_event, id: unknown) => {
    if (typeof id !== 'string') return loadFlags()
    return removeFlag(id, await library())
  })

  ipcMain.handle('flags:export-index', async () => exportIndex(await library()))

  ipcMain.handle('scan:bytes', async (_event, bookId: unknown) => {
    if (typeof bookId !== 'string') return null
    const book = findBook(await library(), bookId)
    if (!book || book.format !== 'pdf') return null
    return pdfBytes(book.path)
  })

  ipcMain.handle('scan:cached', async (_event, bookId: unknown, from: unknown, to: unknown) => {
    if (typeof bookId !== 'string' || typeof from !== 'number' || typeof to !== 'number') return []
    const key = await keyFor(bookId)
    if (!key) return []
    return readRange(key, from, to)
  })

  ipcMain.handle(
    'scan:store',
    async (_event, bookId: unknown, page: unknown, lines: unknown, confidence: unknown) => {
      if (typeof bookId !== 'string' || typeof page !== 'number' || !Array.isArray(lines)) return
      const key = await keyFor(bookId)
      if (!key) return
      await writePage(key, {
        page,
        lines: lines.filter((line): line is string => typeof line === 'string'),
        confidence: typeof confidence === 'number' ? confidence : 0
      })
    }
  )

  ipcMain.handle('library:add', async (_event, paths: unknown) => {
    if (!Array.isArray(paths)) return { added: 0, rejected: [] }
    const cleaned = paths.filter((path): path is string => typeof path === 'string' && path.length > 0)
    const result = await addDocuments(cleaned)
    // The index is derived from what is on the shelf, so adding to the shelf
    // invalidates it.
    if (result.added > 0) cached = null
    return result
  })

  ipcMain.handle('library:added-times', async () => {
    const times: Record<string, number> = {}
    for (const entry of await livingDocuments()) {
      // Both separators, or a Windows path comes back whole.
      const name = entry.path.split(/[\\/]/).pop() ?? entry.path
      const format = name.toLowerCase().endsWith('.epub') ? 'epub' : 'pdf'
      times[`${format}:${name}`] = entry.addedAt
    }
    return times
  })

  ipcMain.handle('library:cover', async (_event, bookId: unknown) => {
    if (typeof bookId !== 'string') return null
    const book = findBook(await library(), bookId)
    if (!book || book.format !== 'epub') return null
    try {
      return await epubCover(book.path)
    } catch {
      return null
    }
  })

  ipcMain.handle('library:chapter', async (_event, bookId: unknown, file: unknown) => {
    if (typeof bookId !== 'string' || typeof file !== 'string') return null
    const book = findBook(await library(), bookId)
    if (!book) return null
    return readChapterSource(book, file)
  })

  ipcMain.handle('progress:get', async () => loadProgress(root()))

  ipcMain.handle(
    'progress:record',
    (_event, bookId: unknown, file: unknown, position: unknown, blocks: unknown) => {
      if (typeof bookId !== 'string' || typeof file !== 'string') return null
      if (typeof blocks !== 'number' || !isPosition(position)) return null
      return recordPosition(bookId, file, position, blocks)
    }
  )

  ipcMain.handle('progress:open', (_event, bookId: unknown, file: unknown) => {
    if (typeof bookId !== 'string' || typeof file !== 'string') return null
    recordOpen(bookId, file)
    return getProgress()
  })

  ipcMain.handle(
    'bookmark:add',
    (_event, bookId: unknown, file: unknown, position: unknown, label: unknown) => {
      if (typeof bookId !== 'string' || typeof file !== 'string') return null
      if (!isPosition(position)) return null
      const now = Date.now()
      return addBookmark(bookId, {
        id: bookmarkId(now, Math.random()),
        chapter: file,
        position,
        label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : 'Bookmark',
        createdAt: now
      })
    }
  )

  ipcMain.handle('bookmark:remove', (_event, bookId: unknown, id: unknown) => {
    if (typeof bookId !== 'string' || typeof id !== 'string') return null
    return removeBookmark(bookId, id)
  })

  const window = createWindow()

  // Editing a chapter in Claude Code and seeing it in the reader is the loop
  // M7 exists to close, so the reader is told rather than having to be told.
  watchLibrary(root(), (file) => {
    if (!window.isDestroyed()) window.webContents.send('library:changed', file)
  })

  // Verification hook. "Does a chapter actually render" is the only question
  // that matters at the end of each milestone, and it cannot be answered from a
  // unit test or from the build succeeding. Set LECTERN_CAPTURE to a path and
  // the app renders, screenshots itself, reports what is on screen, and exits.
  const capturePath = process.env['LECTERN_CAPTURE']
  if (capturePath) void captureAndExit(window, capturePath)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

async function captureAndExit(window: BrowserWindow, path: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  // Renderer console output, so a failure inside the page is visible from the
  // command line rather than only to someone with devtools open.
  const logs: string[] = []
  window.webContents.on('console-message', (event) => {
    if (logs.length < 60) logs.push(`${event.level}: ${event.message}`)
  })

  // The listener is wrapped rather than passed directly: `resolve` accepts an
  // argument, which sends TypeScript to the wrong `once` overload.
  await new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => resolve())
  })
  /*
    The library scan, the render, the typeset and the mathematics-speech batch
    all have to settle. LECTERN_WAIT extends this, and it applies whether or not
    a click follows -- an earlier version honoured it only after a click, so a
    run with no click captured at six seconds and reported a feature missing
    that was in fact still working.
  */
  const settle = Number(process.env['LECTERN_WAIT'] ?? '') || 6000
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), settle)
  })

  /*
    Click, then scroll, in that order.

    They used to run the other way round, which made the one sequence a resume
    test actually needs -- open a book, read into it, leave -- impossible to
    express: the scroll landed on the shelf and the book opened at the top
    afterwards. Nothing wants to scroll before clicking.
  */
  const click = process.env['LECTERN_CLICK']
  if (click) {
    await window.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(click)})?.click()`
    )
    const settle = Number(process.env['LECTERN_WAIT'] ?? '') || 1200
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), settle)
    })
  }

  /*
    Scroll somewhere, then quit. Resuming cannot be verified in one run -- it
    needs a session that reads and leaves, and a second that comes back. The
    wait after scrolling is longer than the progress debounce, so the position
    is recorded the way it would be for a real reader.
  */
  const scrollTo = Number(process.env['LECTERN_SCROLL'] ?? '')
  if (Number.isFinite(scrollTo) && scrollTo > 0) {
    await window.webContents.executeJavaScript(
      `document.querySelector('#content').scrollTo({ top: ${scrollTo}, behavior: 'instant' })`
    )
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 1600)
    })
  }

  // A click *after* the scroll, which is what leaving a book looks like: read
  // into it, then press Library. Whether the position survives that is a
  // separate question from whether it survives quitting.
  const thenClick = process.env['LECTERN_CLICK_AFTER']
  if (thenClick) {
    await window.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(thenClick)})?.click()`
    )
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 1600)
    })
  }

  // Flagging is a right-click, which no click hook can reach. This dispatches a
  // real contextmenu event at a selector so the whole path -- open the bar,
  // choose a kind, write the file -- is exercised rather than simulated.
  const flagAt = process.env['LECTERN_FLAG']
  if (flagAt) {
    const [selector = '', kind = 'confusing'] = flagAt.split('|')
    await window.webContents.executeJavaScript(`
      (() => {
        const target = document.querySelector(${JSON.stringify(selector)});
        if (!target) return 'no target';
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        const note = document.querySelector('#flag-note');
        if (note) note.value = 'Flagged by a verification run.';
        document.querySelector('[data-flag=' + JSON.stringify(${JSON.stringify(kind)}) + ']')?.click();
        return 'ok';
      })()
    `)
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 1500)
    })
  }


  /*
    Live reload cannot be verified in one shot: it needs the file to change
    while the application is watching. This edits a real chapter, waits for the
    watcher, then puts it back -- so the whole path is exercised against the
    real filesystem rather than a simulated event.
  */
  const touch = process.env['LECTERN_TOUCH']
  if (touch) {
    const { readFile, writeFile } = await import('node:fs/promises')
    const original = await readFile(touch, 'utf8')
    try {
      await writeFile(touch, `${original}

LIVE-RELOAD-MARKER
`, 'utf8')
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 4000)
      })
      const seen = await window.webContents.executeJavaScript(
        `(document.querySelector('#content')?.innerText ?? '').includes('LIVE-RELOAD-MARKER')`
      )
      process.stdout.write(`RELOAD ${seen ? 'seen' : 'not seen'}
`)
    } finally {
      await writeFile(touch, original, 'utf8')
    }
  }

  const image = await window.webContents.capturePage()
  await writeFile(path, image.toPNG())

  const report = await window.webContents.executeJavaScript(`({
    chapters: document.querySelectorAll('.chapter-link').length,
    bookTitles: [...document.querySelectorAll('.book-title')].map((b) => b.textContent).slice(0, 6),
    scanProgress: document.querySelector('#scan-progress')?.textContent || null,
    pdfPages: document.querySelectorAll('.pdf-page').length,
    pdfDrawn: document.querySelectorAll('.pdf-page canvas').length,
    shelfCards: document.querySelectorAll('.shelf-card').length,
    shelfIds: [...document.querySelectorAll('.shelf-card')].map((c) => c.dataset.book).slice(0, 6),
    flagCount: document.querySelectorAll('.flag').length,
    prepareBar: document.querySelector('#prepare-progress')?.textContent || null,
    // The player's own voice picker: what it offers and what is selected.
    playerVoices: [...(document.querySelector('#voice')?.options ?? [])].map((o) => o.value),
    playerVoice: document.querySelector('#voice')?.value ?? null,
    prepareHidden: document.querySelector('#prepare-progress')?.hidden ?? null,
    // The settings page, read from the controls themselves rather than from
    // what we believe we rendered.
    settingsGroups: [...document.querySelectorAll('.settings-heading')].map((h) => h.textContent),
    settingsRows: [...document.querySelectorAll('.settings-label')].map((l) => l.textContent),
    characterOptions: [...document.querySelectorAll('.settings-select')]
      .map((s) => [...s.options].map((o) => o.value))
      .find((values) => values.includes('')) ?? null,
    // Whether a scrollbar is actually visible, not whether the content is
    // wider than the box -- an element hiding its overflow reports the second
    // and shows neither, which had this reporting a bug that was not there.
    // (No backticks in here: this whole block is a template literal.)
    sidebarScrolls: (() => {
      const el = document.querySelector('#sidebar');
      if (!el) return null;
      const style = getComputedStyle(el);
      const scrollable = style.overflowX === 'auto' || style.overflowX === 'scroll';
      return scrollable && el.scrollWidth > el.clientWidth + 1;
    })(),
    flagBarOpen: document.querySelector('#flag-bar')?.classList.contains('is-open') ?? false,

    typesetMath: document.querySelectorAll('mjx-container').length,
    boxes: document.querySelectorAll('.box').length,
    heading: document.querySelector('#content h1')?.textContent ?? null,
    text: document.querySelector('#content')?.innerText?.slice(0, 300) ?? null,
    // Whether the reader itself scrolls sideways -- the only overflow that is
    // visible to a reader. MathJax's internal glyph pieces always report huge
    // widths and are clipped, so measuring them says nothing.
    scrollTop: Math.round(document.querySelector('#content')?.scrollTop ?? -1),
    blocks: document.querySelector('.chapter-body')?.children.length ?? 0,
    // What a reading position is anchored to in whichever view is open. Zero
    // here means positions are not being recorded at all, which is exactly the
    // state PDFs and EPUBs were in.
    anchorBlocks: (() => {
      const b =
        document.querySelector('.chapter-body') ||
        document.querySelector('.pdf-pages') ||
        document.querySelector('.epub-frame')?.contentDocument?.body;
      return b ? b.children.length : 0;
    })(),
    // What the reader is actually looking at. Comparing this across window
    // widths is the real test of the anchoring; comparing scrollTop is not.
    atTop: (() => {
      const c = document.querySelector('#content');
      const b = document.querySelector('.chapter-body');
      if (!c || !b) return null;
      const y = c.getBoundingClientRect().top;
      const kids = [...b.children];
      for (let i = 0; i < kids.length; i += 1) {
        const r = kids[i].getBoundingClientRect();
        if (r.bottom > y + 4) return i + ': ' + (kids[i].textContent || '').trim().slice(0, 50);
      }
      return null;
    })(),
    bookmarks: document.querySelectorAll('.bookmark').length,
    // Speech, read from the real controls rather than from a debug hook.
    queue: document.querySelector('#speech-position')?.textContent || null,
    mathBlocks: document.querySelectorAll('[data-latex]').length,
    speechSpans: document.querySelectorAll('.math-speech').length,

    inlineMathParagraph: (() => {
      const p = [...document.querySelectorAll('.chapter-body p')]
        .find((el) => el.querySelector('.math-inline'));
      return p ? p.textContent.slice(0, 220) : 'none found';
    })(),
    playing: document.querySelector('#play')?.getAttribute('aria-pressed') || null,
    voices: document.querySelector('#voice')?.options?.length ?? 0,
    rawVoices: (typeof speechSynthesis !== 'undefined') ? speechSynthesis.getVoices().length : 'NO speechSynthesis',
    rawVoiceNames: (typeof speechSynthesis !== 'undefined') ? speechSynthesis.getVoices().slice(0,4).map(v => v.name + '/' + v.lang) : [],
    speaking: (typeof speechSynthesis !== 'undefined') ? speechSynthesis.speaking : null,
    voice: document.querySelector('#voice')?.value || null,
    highlighted: (() => {
      try {
        const h = CSS.highlights.get('spoken');
        if (!h) return null;
        for (const r of h) return r.toString().slice(0, 40);
        return 'empty';
      } catch (e) { return 'unsupported'; }
    })(),
    progressBars: document.querySelectorAll('.progress-fill').length,
    hScroll: (() => {
      const c = document.querySelector('#content');
      if (!c) return null;
      return { scrollWidth: c.scrollWidth, clientWidth: c.clientWidth,
               scrolls: c.scrollWidth > c.clientWidth + 1 };
    })()
  })`)
  process.stdout.write(`CAPTURE ${JSON.stringify({ ...report, logs })}\n`)
  app.quit()
}

/**
 * Cache key for a book's recognised pages: path, size and modification time, so
 * renaming a book keeps an hour of work and editing one discards it.
 */
/**
 * Serve the built renderer over the custom scheme.
 *
 * Paths are resolved inside the bundle and refused if they escape it: the
 * handler is reachable from page content, so a crafted URL must not be able to
 * read the rest of the disk.
 */
function serveRenderer(): void {
  const bundle = join(__dirname, '../renderer')

  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url)
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'
    const target = join(bundle, relative)

    if (!target.startsWith(bundle)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(target).toString())
  })
}

async function keyFor(bookId: string): Promise<string | null> {
  const book = findBook(await library(), bookId)
  if (!book) return null
  try {
    const { stat } = await import('node:fs/promises')
    const info = await stat(book.path)
    return documentKey(book.path, info.size, info.mtimeMs)
  } catch {
    return null
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * The debounce must not eat the last write. Closing the window a moment after
 * reading is the most ordinary way to leave, and it is exactly the case where
 * an unflushed position would be lost.
 */
app.on('before-quit', (event) => {
  if (flushed) return
  event.preventDefault()
  void flushProgress().then(() => {
    flushed = true
    app.quit()
  })
})

let flushed = false
