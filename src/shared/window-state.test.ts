import { describe, expect, it } from 'vitest'
import { DEFAULT_BOUNDS, onScreen, parseBounds, type Rect, type WindowBounds } from './window-state'

const LAPTOP: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
/** A second monitor to the left, as an unplugged one would have been. */
const SECOND: Rect = { x: -1920, y: 0, width: 1920, height: 1080 }

const at = (x: number | null, y: number | null): WindowBounds => ({
  ...DEFAULT_BOUNDS,
  x,
  y
})

describe('parseBounds', () => {
  it('reads what was written', () => {
    const source = JSON.stringify({ width: 1400, height: 900, x: 120, y: 60, maximized: true })
    expect(parseBounds(source)).toEqual({
      width: 1400,
      height: 900,
      x: 120,
      y: 60,
      maximized: true
    })
  })

  it('falls back on a file that is not JSON', () => {
    // The file is small and written on every close, so a half-written one after
    // a crash is the ordinary failure, not an exotic one.
    expect(parseBounds('{"width":')).toEqual(DEFAULT_BOUNDS)
    expect(parseBounds('')).toEqual(DEFAULT_BOUNDS)
    expect(parseBounds('[1,2,3]')).toEqual(DEFAULT_BOUNDS)
  })

  it('refuses a size smaller than the window can be', () => {
    // Below the window's own minimum the value is not honoured anyway, so
    // storing it would mean reopening at a size that silently became another.
    const parsed = parseBounds(JSON.stringify({ width: 50, height: 10 }))
    expect(parsed.width).toBe(DEFAULT_BOUNDS.width)
    expect(parsed.height).toBe(DEFAULT_BOUNDS.height)
  })

  it('treats a missing or unusable position as no position', () => {
    expect(parseBounds('{}').x).toBeNull()
    expect(parseBounds(JSON.stringify({ x: null, y: 4 })).x).toBeNull()
    expect(parseBounds(JSON.stringify({ x: 'left', y: 4 })).x).toBeNull()
  })
})

describe('onScreen', () => {
  it('keeps a window that is where it was left', () => {
    expect(onScreen(at(200, 100), [LAPTOP])).toEqual(at(200, 100))
  })

  it('drops a position on a monitor that is no longer attached', () => {
    // Closed on the second display, reopened with only the laptop: restoring
    // those coordinates opens the window off the left edge of the world, which
    // looks exactly like the application failing to start.
    const moved = onScreen(at(-1200, 300), [LAPTOP])
    expect(moved.x).toBeNull()
    expect(moved.y).toBeNull()
    expect(moved.width).toBe(DEFAULT_BOUNDS.width)
  })

  it('keeps it when that monitor is still there', () => {
    expect(onScreen(at(-1200, 300), [LAPTOP, SECOND])).toEqual(at(-1200, 300))
  })

  it('drops a window hanging off an edge by a sliver', () => {
    // A shared corner is not a reachable window. Overlapping by ten pixels
    // leaves nothing to take hold of, and an earlier form of this that asked
    // only whether the rectangles intersected called it visible.
    const sliver = onScreen(at(1910, 500), [LAPTOP])
    expect(sliver.x).toBeNull()
  })

  it('keeps a window with enough title bar left to grab', () => {
    expect(onScreen(at(1700, 500), [LAPTOP]).x).toBe(1700)
  })

  it('drops one dragged below the bottom of the screen', () => {
    expect(onScreen(at(400, 1035), [LAPTOP]).y).toBeNull()
  })

  it('passes through a window that never had a position', () => {
    expect(onScreen(at(null, null), [LAPTOP])).toEqual(at(null, null))
  })
})
