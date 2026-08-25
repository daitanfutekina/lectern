import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { DEFAULT_ROOT, readChapterSource, saveIndex, scanLibrary } from './library'
import { findBook } from '@shared/library'
import type { LibraryIndex } from '@shared/library'

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

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
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
  window.once('ready-to-show', () => window.show())

  // A link in a book opens in the real browser. Nothing navigates this window
  // away from the reader.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.lectern.app')

  ipcMain.handle('library:get', () => library())
  ipcMain.handle('library:rescan', () => library(true))

  ipcMain.handle('library:chapter', async (_event, bookId: unknown, file: unknown) => {
    if (typeof bookId !== 'string' || typeof file !== 'string') return null
    const book = findBook(await library(), bookId)
    if (!book) return null
    return readChapterSource(book, file)
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
  // The listener is wrapped rather than passed directly: `resolve` accepts an
  // argument, which sends TypeScript to the wrong `once` overload.
  await new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => resolve())
  })
  // The library scan, the render, and the MathJax typeset all have to settle.
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 6000)
  })

  const image = await window.webContents.capturePage()
  await writeFile(path, image.toPNG())

  const report = await window.webContents.executeJavaScript(`({
    chapters: document.querySelectorAll('.chapter-link').length,
    typesetMath: document.querySelectorAll('mjx-container').length,
    boxes: document.querySelectorAll('.box').length,
    heading: document.querySelector('#content h1')?.textContent ?? null,
    text: document.querySelector('#content')?.innerText?.slice(0, 300) ?? null,
    // Whether the reader itself scrolls sideways -- the only overflow that is
    // visible to a reader. MathJax's internal glyph pieces always report huge
    // widths and are clipped, so measuring them says nothing.
    hScroll: (() => {
      const c = document.querySelector('#content');
      if (!c) return null;
      return { scrollWidth: c.scrollWidth, clientWidth: c.clientWidth,
               scrolls: c.scrollWidth > c.clientWidth + 1 };
    })()
  })`)
  process.stdout.write(`CAPTURE ${JSON.stringify(report)}\n`)
  app.quit()
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
