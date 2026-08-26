import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_ROOT, readChapterSource, saveIndex, scanLibrary } from './library'
import { configureMath, speakMath } from './math-speech'
import { pdfBytes } from './pdf'
import { cachedPages, configureOcrCache, documentKey, readRange, writePage } from './ocr-cache'
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

/** The root is a setting in a later milestone; for now it is the default. */
function root(): string {
  return DEFAULT_ROOT
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
    Optional second half of the hook: scroll somewhere, then quit. Resuming is
    the whole point of M2 and cannot be verified in one run -- it needs a
    session that reads and leaves, and a second that comes back. The wait after
    scrolling is longer than the progress debounce, so the position is recorded
    the way it would be for a real reader.
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

  // Click something before capturing, for verifying a milestone's controls.
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

  const image = await window.webContents.capturePage()
  await writeFile(path, image.toPNG())

  const report = await window.webContents.executeJavaScript(`({
    chapters: document.querySelectorAll('.chapter-link').length,
    bookTitles: [...document.querySelectorAll('.book-title')].map((b) => b.textContent).slice(0, 6),
    scanProgress: document.querySelector('#scan-progress')?.textContent || null,

    typesetMath: document.querySelectorAll('mjx-container').length,
    boxes: document.querySelectorAll('.box').length,
    heading: document.querySelector('#content h1')?.textContent ?? null,
    text: document.querySelector('#content')?.innerText?.slice(0, 300) ?? null,
    // Whether the reader itself scrolls sideways -- the only overflow that is
    // visible to a reader. MathJax's internal glyph pieces always report huge
    // widths and are clipped, so measuring them says nothing.
    scrollTop: Math.round(document.querySelector('#content')?.scrollTop ?? -1),
    blocks: document.querySelector('.chapter-body')?.children.length ?? 0,
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
