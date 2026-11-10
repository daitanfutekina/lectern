import { describe, expect, it } from 'vitest'
import { SHORTCUTS, shortcutForEvent } from './shortcuts'

describe('keyboard shortcuts', () => {
  it('matches the bindings used by the application', () => {
    expect(shortcutForEvent({ key: '?', shiftKey: true })?.id).toBe('help')
    expect(shortcutForEvent({ key: 'F', ctrlKey: true })?.id).toBe('find')
    expect(shortcutForEvent({ key: 'ArrowRight', altKey: true })?.id).toBe('next-chapter')
    expect(shortcutForEvent({ key: '=', ctrlKey: true })?.id).toBe('zoom-in')
  })

  it('does not turn modified typing into an application command', () => {
    expect(shortcutForEvent({ key: 'f' })).toBeNull()
    expect(shortcutForEvent({ key: '?', shiftKey: true, ctrlKey: true })).toBeNull()
  })

  it('has one help row for every dispatched action', () => {
    expect(new Set(SHORTCUTS.map((shortcut) => shortcut.id)).size).toBe(SHORTCUTS.length)
    expect(SHORTCUTS.every((shortcut) => shortcut.keys && shortcut.description)).toBe(true)
  })
})
