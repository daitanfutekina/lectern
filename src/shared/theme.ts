export type Theme = 'dark' | 'light'

interface ThemePalette {
  readonly window: string
  readonly epubBackground: string
  readonly epubText: string
  readonly epubLink: string
  readonly epubSelection: string
}

export const THEME_PALETTES: Record<Theme, ThemePalette> = {
  dark: {
    window: '#0d1117',
    epubBackground: '#14181f',
    epubText: '#e6edf3',
    epubLink: '#58a6ff',
    epubSelection: 'rgba(88,166,255,0.35)'
  },
  light: {
    window: '#f6f8fa',
    epubBackground: '#ffffff',
    epubText: '#1f2328',
    epubLink: '#0969da',
    epubSelection: 'rgba(9,105,218,0.22)'
  }
}

export function windowBackground(theme: Theme): string {
  return THEME_PALETTES[theme].window
}

/**
 * Host defaults for an EPUB frame, kept at zero selector specificity so any
 * colour chosen by the publisher wins regardless of its selector shape.
 */
export function epubHostSheet(theme: Theme, fontScale = 1): string {
  const palette = THEME_PALETTES[theme]
  return `
  :where(:root) { color-scheme: ${theme}; }
  :where(html) {
    background: ${palette.epubBackground};
    color: ${palette.epubText};
  }
  :where(body) {
    zoom: ${fontScale};
    margin: 0;
    padding: 32px 40px 96px;
    max-width: 46em;
    margin-inline: auto;
    line-height: 1.7;
  }
  :where(img, svg, video) { max-width: 100%; height: auto; }
  :where(a) { color: ${palette.epubLink}; }
  ::selection { background: ${palette.epubSelection}; }
  ::highlight(spoken) { background: ${palette.epubSelection}; }
`
}
