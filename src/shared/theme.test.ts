import { describe, expect, it } from 'vitest'
import { epubHostSheet, THEME_PALETTES, windowBackground } from './theme'

describe('theme palettes', () => {
  it('uses the selected palette for the native window and EPUB fallback', () => {
    expect(windowBackground('dark')).toBe('#0d1117')
    expect(windowBackground('light')).toBe('#f6f8fa')
    expect(epubHostSheet('dark')).toContain('background: #14181f')
    expect(epubHostSheet('light')).toContain('background: #ffffff')
    expect(epubHostSheet('light')).toContain('color-scheme: light')
  })

  it('keeps EPUB defaults weaker than a publisher rule', () => {
    for (const theme of ['dark', 'light'] as const) {
      const sheet = epubHostSheet(theme)
      expect(sheet).toContain(':where(html)')
      expect(sheet).toContain(':where(body)')
      expect(sheet).toContain(':where(a)')
      expect(sheet).not.toContain('!important')
    }
  })

  it('keeps the light EPUB text distinct from its page', () => {
    expect(THEME_PALETTES.light.epubText).not.toBe(THEME_PALETTES.light.epubBackground)
  })

  it('applies the reader text size as a relative EPUB scale', () => {
    expect(epubHostSheet('dark', 1.25)).toContain('zoom: 1.25')
  })
})
