import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, screen, type BrowserWindow } from 'electron'
import { DEFAULT_BOUNDS, onScreen, parseBounds, type WindowBounds } from '@shared/window-state'

/**
 * Remembering the window between launches.
 *
 * The shape, the parsing and the off-screen check are in `@shared/window-state`
 * where they can be tested; this is the part that needs Electron -- the file,
 * the displays, and the events worth writing on.
 */

export { DEFAULT_BOUNDS, type WindowBounds }

const path = (): string => join(app.getPath('userData'), 'window.json')

export async function loadWindowBounds(): Promise<WindowBounds> {
  let stored: WindowBounds
  try {
    stored = parseBounds(await readFile(path(), 'utf8'))
  } catch {
    return DEFAULT_BOUNDS
  }
  return onScreen(
    stored,
    screen.getAllDisplays().map((display) => display.workArea)
  )
}

/**
 * Record where the window is, from then on.
 *
 * The *normal* bounds, not the current ones: a maximized window reports the
 * whole screen, so storing that and restoring it un-maximized would grow the
 * window by a title bar every time it was closed while maximized.
 */
export function rememberWindow(window: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null

  const write = async (): Promise<void> => {
    if (window.isDestroyed()) return
    const normal = window.getNormalBounds()
    const bounds: WindowBounds = {
      width: normal.width,
      height: normal.height,
      x: normal.x,
      y: normal.y,
      maximized: window.isMaximized()
    }
    try {
      await mkdir(dirname(path()), { recursive: true })
      await writeFile(path(), JSON.stringify(bounds, null, 2), 'utf8')
    } catch {
      // A window position that cannot be stored is not worth a word to the
      // reader. The window still opens; it opens in the default place.
    }
  }

  // Dragging a window fires move events by the hundred and each one would be a
  // file write. Letting it settle costs nothing, because nothing reads this
  // until the next launch.
  const later = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void write()
    }, 400)
  }

  window.on('resize', later)
  window.on('move', later)
  window.on('maximize', later)
  window.on('unmaximize', later)

  // Closing beats the debounce, so the last move before a quit is not lost.
  window.on('close', () => {
    if (timer) clearTimeout(timer)
    void write()
  })
}
