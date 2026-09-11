/**
 * Where the window was last time, as data.
 *
 * The file this is read from lives in the application's data directory rather
 * than in `settings.json`, and the distinction is the one that file already
 * draws: a library carries the preferences belonging to the books -- the voice,
 * the pacing, the maths threshold -- while which monitor a window sat on
 * belongs to the machine.
 *
 * Parsing and the off-screen check are here because both are pure and both are
 * worth a test: a window restored to a monitor that is no longer attached is
 * indistinguishable, to whoever is looking at the screen, from the application
 * failing to start.
 */

export interface WindowBounds {
  readonly width: number
  readonly height: number
  readonly x: number | null
  readonly y: number | null
  readonly maximized: boolean
}

/** A display's usable area. Structurally `Electron.Rectangle`, without the import. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export const DEFAULT_BOUNDS: WindowBounds = {
  width: 1100,
  height: 820,
  x: null,
  y: null,
  maximized: false
}

/** Matches `minWidth`/`minHeight` on the window itself. */
export const MIN_WIDTH = 640
export const MIN_HEIGHT = 480

/** Enough of a title bar to grab with a mouse. */
const GRABBABLE_WIDTH = 120
const GRABBABLE_HEIGHT = 24
const TITLE_BAR = 48

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const size = (value: unknown, fallback: number, min: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.round(value) : fallback

const position = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null

export function parseBounds(source: string): WindowBounds {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return DEFAULT_BOUNDS
  }
  if (!isRecord(raw)) return DEFAULT_BOUNDS

  return {
    width: size(raw['width'], DEFAULT_BOUNDS.width, MIN_WIDTH),
    height: size(raw['height'], DEFAULT_BOUNDS.height, MIN_HEIGHT),
    x: position(raw['x']),
    y: position(raw['y']),
    maximized: raw['maximized'] === true
  }
}

/**
 * Drop a position that no longer lands on a screen.
 *
 * The monitor a window was closed on may be gone -- a laptop undocked, a second
 * display unplugged -- and restoring the old coordinates then opens the window
 * where nobody can reach it. Losing the position and keeping the size is the
 * half that is safe to keep.
 *
 * A shared corner is not the test. A window dragged almost entirely off a
 * screen still overlaps it by a pixel, so the question asked here is whether
 * enough of the title bar is visible to take hold of.
 */
export function onScreen(bounds: WindowBounds, areas: readonly Rect[]): WindowBounds {
  const { x, y } = bounds
  if (x === null || y === null) return bounds

  const reachable = areas.some((area) => {
    const overlapWidth = Math.min(area.x + area.width, x + bounds.width) - Math.max(area.x, x)
    const overlapHeight = Math.min(area.y + area.height, y + TITLE_BAR) - Math.max(area.y, y)
    return overlapWidth >= GRABBABLE_WIDTH && overlapHeight >= GRABBABLE_HEIGHT
  })

  return reachable ? bounds : { ...bounds, x: null, y: null }
}
