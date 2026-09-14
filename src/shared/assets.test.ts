import { describe, expect, it } from 'vitest'
import { assetUrl, frameSandbox, parseAssetUrl, safeSegments } from './assets'

describe('assetUrl', () => {
  it('points a reference beside the chapter into its book', () => {
    expect(assetUrl('linear-algebra', 'linalg_ch1.md', 'span.png')).toBe(
      'book://local/linear-algebra/span.png'
    )
    expect(assetUrl('godot', 'ch4.md', 'shots/inspector.png')).toBe(
      'book://local/godot/shots/inspector.png'
    )
  })

  it('resolves against a chapter kept in a subfolder', () => {
    expect(assetUrl('godot', 'part2/ch9.md', '../shots/a.png')).toBe('book://local/godot/shots/a.png')
  })

  it('keeps a query and a fragment', () => {
    expect(assetUrl('calc', 'c.md', 'widget.html?mode=polar#start')).toBe(
      'book://local/calc/widget.html?mode=polar#start'
    )
  })

  it('encodes names a URL cannot carry raw', () => {
    expect(assetUrl('calc', 'c.md', 'my figure (2).png')).toBe('book://local/calc/my%20figure%20(2).png')
  })

  it('reads a raw # as a fragment, the way a browser does', () => {
    // A file actually named with a # has to be written %23 in the chapter, as
    // it would on any web page.
    expect(assetUrl('calc', 'c.md', 'fig #2.png')).toBe('book://local/calc/fig%20#2.png')
  })

  it('leaves alone anything that already says where it goes', () => {
    for (const reference of [
      'https://www.youtube.com/embed/abc',
      'data:image/png;base64,AAAA',
      'blob:app://lectern/1',
      '//cdn.example.com/x.png',
      '/index.html',
      '#section-2',
      ''
    ]) {
      expect(assetUrl('calc', 'c.md', reference)).toBeNull()
    }
  })

  it('refuses a reference that climbs out of the book', () => {
    // The server refuses these too. Refusing here means a chapter reaching into
    // another book shows as a missing image, not as quietly working.
    expect(assetUrl('calc', 'c.md', '../linear-algebra/secret.png')).toBeNull()
    expect(assetUrl('calc', 'c.md', '../../../Windows/win.ini')).toBeNull()
  })
})

describe('safeSegments', () => {
  it('normalises within the path', () => {
    expect(safeSegments('a/./b/../c.png')).toEqual(['a', 'c.png'])
  })

  it('refuses what a traversal is made of', () => {
    expect(safeSegments('../x.png')).toBeNull()
    expect(safeSegments('a/../../x.png')).toBeNull()
    expect(safeSegments('a\\..\\x.png')).toBeNull()
    expect(safeSegments('C:/Windows/win.ini')).toBeNull()
    expect(safeSegments('x.png\0.html')).toBeNull()
    expect(safeSegments('')).toBeNull()
  })

  it('refuses dotfiles and dot-folders, which are tooling rather than figures', () => {
    expect(safeSegments('.git/config')).toBeNull()
    expect(safeSegments('figs/.hidden.png')).toBeNull()
    expect(parseAssetUrl('book://local/calc/.library/settings.json')).toBeNull()
  })
})

describe('parseAssetUrl', () => {
  it('takes a request apart', () => {
    expect(parseAssetUrl('book://local/linear-algebra/figs/span.png')).toEqual({
      bookId: 'linear-algebra',
      segments: ['figs', 'span.png'],
      type: 'image/png'
    })
  })

  it('round-trips what assetUrl builds', () => {
    const url = assetUrl('godot', 'ch4.md', 'shots/my inspector.PNG') ?? ''
    expect(parseAssetUrl(url)).toEqual({
      bookId: 'godot',
      segments: ['shots', 'my inspector.PNG'],
      type: 'image/png'
    })
  })

  it('refuses a traversal hidden by encoding', () => {
    // A check made on the encoded form never sees these.
    expect(parseAssetUrl('book://local/calc/%2e%2e/%2e%2e/secret.png')).toBeNull()
    expect(parseAssetUrl('book://local/calc/a%2F..%2F..%2Fsecret.png')).toBeNull()
    expect(parseAssetUrl('book://local/calc/..%5C..%5Csecret.png')).toBeNull()
  })

  it('serves only what a figure is made of', () => {
    // A chapter's own source is not an asset.
    expect(parseAssetUrl('book://local/calc/chapter1.md')).toBeNull()
    expect(parseAssetUrl('book://local/calc/data/points.json')).not.toBeNull()
    expect(parseAssetUrl('book://local/calc/tool.exe')).toBeNull()
    expect(parseAssetUrl('book://local/calc/noextension')).toBeNull()
  })

  it('refuses the wrong scheme, host, or shape', () => {
    expect(parseAssetUrl('app://lectern/index.html')).toBeNull()
    expect(parseAssetUrl('book://elsewhere/calc/a.png')).toBeNull()
    expect(parseAssetUrl('book://local/a.png')).toBeNull()
    expect(parseAssetUrl('not a url')).toBeNull()
  })
})

describe('frameSandbox', () => {
  it('lets a remote page keep its own origin, which cannot reach this one', () => {
    // A video player refuses to run without storage, and storage needs its origin.
    expect(frameSandbox('https://www.youtube.com/embed/abc')).toContain('allow-same-origin')
  })

  it('never lets anything else pair scripts with an origin', () => {
    // Scripts plus same-origin on a frame sharing the application's origin can
    // reach up, remove the sandbox, and find the bridge to the filesystem.
    for (const src of ['book://local/calc/widget.html', 'app://lectern/index.html', 'http://example.com', '']) {
      expect(frameSandbox(src)).not.toContain('allow-same-origin')
    }
  })
})
