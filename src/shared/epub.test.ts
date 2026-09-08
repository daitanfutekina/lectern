import { describe, expect, it } from 'vitest'
import {
  bodyOf,
  navigationOf,
  opfPath,
  parseNavXhtml,
  parseNcx,
  parseOpf,
  resolveHref,
  splitHref,
  titleFromDocument
} from './epub'

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

const OPF = `<?xml version="1.0"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Physical Game</dc:title>
    <dc:creator opf:role="aut">Ozzie</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="styles/main.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="cover" linear="no"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`

describe('opfPath', () => {
  it('reads the path rather than assuming it', () => {
    // Real EPUBs disagree about where the OPF lives, so it must be read.
    expect(opfPath(CONTAINER)).toBe('OEBPS/content.opf')
  })

  it('accepts single quotes', () => {
    expect(opfPath(`<rootfile full-path='content.opf'/>`)).toBe('content.opf')
  })

  it('strips a leading slash', () => {
    expect(opfPath(`<rootfile full-path="/OEBPS/content.opf"/>`)).toBe('OEBPS/content.opf')
  })

  it('is null when there is no rootfile', () => {
    expect(opfPath('<container></container>')).toBeNull()
  })
})

describe('resolveHref', () => {
  it('resolves against the folder holding the OPF, not the archive root', () => {
    expect(resolveHref('OEBPS/content.opf', 'text/chapter1.xhtml')).toBe(
      'OEBPS/text/chapter1.xhtml'
    )
  })

  it('handles an OPF at the root', () => {
    expect(resolveHref('content.opf', 'chapter1.xhtml')).toBe('chapter1.xhtml')
  })

  it('walks up a level', () => {
    expect(resolveHref('OEBPS/xml/content.opf', '../text/a.xhtml')).toBe('OEBPS/text/a.xhtml')
  })

  it('leaves an absolute URL alone', () => {
    expect(resolveHref('OEBPS/content.opf', 'https://example.com/a')).toBe('https://example.com/a')
  })
})

describe('parseOpf', () => {
  const parsed = parseOpf(OPF, 'OEBPS/content.opf')

  it('reads the metadata', () => {
    expect(parsed.title).toBe('The Physical Game')
    expect(parsed.author).toBe('Ozzie')
    expect(parsed.language).toBe('en')
  })

  it('resolves manifest hrefs', () => {
    expect(parsed.manifest['ch1']?.href).toBe('OEBPS/text/chapter1.xhtml')
    expect(parsed.manifest['css']?.mediaType).toBe('text/css')
  })

  it('orders the spine as the book intends', () => {
    expect(parsed.spine.map((item) => item.id)).toEqual(['ch1', 'ch2'])
  })

  it('drops linear="no" entries', () => {
    // Covers and notes panels are outside the reading sequence, and reading one
    // aloud in place would interrupt the book.
    expect(parsed.spine.some((item) => item.id === 'cover')).toBe(false)
  })

  it('survives an empty package', () => {
    const empty = parseOpf('<package></package>', 'content.opf')
    expect(empty.spine).toEqual([])
    expect(empty.title).toBeNull()
  })

  /*
    The EPUB 2 cover, which is how most real files declare one.

    Untested until a real book arrived with no cover on the shelf: the word
    boundary in the meta pattern had been flattened to a literal backspace
    byte, so the pattern demanded a control character no OPF contains and every
    EPUB 2 cover in existence parsed as absent. A test that names the id is the
    only thing that can fail against that, since the corruption is invisible in
    a terminal -- `cat` renders the byte by moving the cursor back one column.
  */
  it('finds the cover a meta tag names', () => {
    const withCover = parseOpf(
      `<package><metadata>
        <meta property="dcterms:modified">2019-10-11T20:00:00Z</meta>
        <meta name="cover" content="cover-image"/>
      </metadata><manifest>
        <item id="cover-image" href="graphics/9780136886020.jpg" media-type="image/jpeg"/>
      </manifest><spine></spine></package>`,
      'OEBPS/content.opf'
    )
    expect(withCover.coverId).toBe('cover-image')
    expect(withCover.manifest['cover-image']?.href).toBe('OEBPS/graphics/9780136886020.jpg')
  })

  it('reports no cover when nothing declares one', () => {
    expect(parseOpf(OPF, 'OEBPS/content.opf').coverId).toBeNull()
  })
})

describe('titleFromDocument', () => {
  it('prefers the document title', () => {
    expect(titleFromDocument('<html><title>Chapter One</title></html>', 'x')).toBe('Chapter One')
  })

  it('falls back to the first heading', () => {
    expect(titleFromDocument('<body><h1>The Warm Up</h1></body>', 'x')).toBe('The Warm Up')
  })

  it('falls back to the file name last, because it usually says chapter_007', () => {
    expect(titleFromDocument('<body><p>text</p></body>', 'chapter_007')).toBe('chapter_007')
  })

  it('decodes entities', () => {
    expect(titleFromDocument('<title>Bats &amp; Balls</title>', 'x')).toBe('Bats & Balls')
  })
})

describe('bodyOf', () => {
  it('takes the body', () => {
    expect(bodyOf('<html><head><title>t</title></head><body><p>Hi</p></body></html>')).toBe('<p>Hi</p>')
  })

  it('removes scripts, because nothing in a book needs to run', () => {
    expect(bodyOf('<body><script>alert(1)</script><p>Hi</p></body>')).toBe('<p>Hi</p>')
  })

  it('removes the book\'s own styling, which the application supplies', () => {
    // SPEC invariant 3: books carry content, the app carries design.
    expect(bodyOf('<body><style>p{color:red}</style><p>Hi</p></body>')).toBe('<p>Hi</p>')
    expect(bodyOf('<body><link rel="stylesheet" href="a.css"><p>Hi</p></body>')).toBe('<p>Hi</p>')
  })

  it('removes inline event handlers', () => {
    expect(bodyOf('<body><p onclick="x()">Hi</p></body>')).toBe('<p>Hi</p>')
  })

  it('falls back to the whole document when there is no body tag', () => {
    expect(bodyOf('<p>Fragment</p>')).toBe('<p>Fragment</p>')
  })
})

describe('titleFromDocument, uninformative titles', () => {
  it('ignores a placeholder title in favour of the heading', () => {
    // Converters emit <title>Unknown</title> by the thousand, and a chapter
    // list reading "Unknown" seven times is no list at all.
    const doc = '<html><title>Unknown</title><body><h1>The Warm Up</h1></body></html>'
    expect(titleFromDocument(doc, 'main-1')).toBe('The Warm Up')
  })

  it('still falls back to the file name when there is nothing else', () => {
    expect(titleFromDocument('<title>Untitled</title><body><p>x</p></body>', 'main-1')).toBe('main-1')
  })
})

/* ── The navigation document ────────────────────────────────────────── */

/*
  Shaped after a real book. Its chapters open `<h2>5</h2>` with the title in a
  styled paragraph below, so every heuristic that reads the document itself
  names the chapter "5"; the navigation is the only place the title exists.
*/
const NAV = `<html xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc">
<h1>Contents</h1>
<ol class="none">
<li><a href="copyright.xhtml">Copyright Page</a></li>
<li><a href="part01.xhtml#part01">Part I: Introduction</a>
  <ol class="none">
  <li><a href="ch01.xhtml#ch01">1. What Is Software Architecture?</a>
    <ol class="none">
    <li><a href="ch01.xhtml#ch01lev1sec1">1.1 What It Is and What It Isn&#8217;t</a></li>
    <li><a href="ch01.xhtml#ch01lev1sec2">1.2 Structures and Views</a></li>
    </ol></li>
  </ol></li>
</ol>
</nav>
<nav epub:type="landmarks"><ol><li><a href="ch01.xhtml">Start</a></li></ol></nav>
</body></html>`

const NCX = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<navMap>
<navPoint id="i1" playOrder="1">
<navLabel><text>Copyright Page</text></navLabel>
<content src="copyright.xhtml"/>
</navPoint>
<navPoint id="i2" playOrder="2">
<navLabel><text>Part I: Introduction</text></navLabel>
<content src="part01.xhtml#part01"/>
<navPoint id="i3" playOrder="3">
<navLabel><text>1. What Is Software Architecture?</text></navLabel>
<content src="ch01.xhtml#ch01"/>
</navPoint>
</navPoint>
</navMap>
</ncx>`

describe('splitHref', () => {
  it('separates the fragment', () => {
    expect(splitHref('text/ch05.xhtml#sec1')).toEqual({ path: 'text/ch05.xhtml', fragment: 'sec1' })
    expect(splitHref('text/ch05.xhtml')).toEqual({ path: 'text/ch05.xhtml', fragment: null })
  })
})

describe('parseNavXhtml', () => {
  const entries = parseNavXhtml(NAV, 'OEBPS/nav.xhtml')

  it('reads the labels the documents themselves do not carry', () => {
    expect(entries.map((entry) => entry.label)).toEqual([
      'Copyright Page',
      'Part I: Introduction',
      '1. What Is Software Architecture?',
      '1.1 What It Is and What It Isn’t',
      '1.2 Structures and Views'
    ])
  })

  it('nests, so a chapter can be told from a section inside it', () => {
    expect(entries.map((entry) => entry.depth)).toEqual([0, 0, 1, 2, 2])
  })

  it('resolves hrefs against the navigation document and keeps the fragment', () => {
    expect(entries[2]?.href).toBe('OEBPS/ch01.xhtml')
    expect(entries[2]?.fragment).toBe('ch01')
    expect(entries[0]?.fragment).toBeNull()
  })

  it('reads the toc nav and not the landmarks beside it', () => {
    // Both are <nav>; only one is the table of contents, and taking the wrong
    // one would put "Start" in the chapter list.
    expect(entries.some((entry) => entry.label === 'Start')).toBe(false)
  })
})

describe('parseNcx', () => {
  const entries = parseNcx(NCX, 'OEBPS/toc.ncx')

  it('reads a label and the file it labels', () => {
    expect(entries.map((entry) => entry.label)).toEqual([
      'Copyright Page',
      'Part I: Introduction',
      '1. What Is Software Architecture?'
    ])
    expect(entries[2]?.href).toBe('OEBPS/ch01.xhtml')
    expect(entries[2]?.fragment).toBe('ch01')
  })

  it('nests on navPoint, which is where an NCX keeps its depth', () => {
    expect(entries.map((entry) => entry.depth)).toEqual([0, 0, 1])
  })
})

describe('navigationOf', () => {
  const withNav = parseOpf(
    `<package><manifest>
      <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
      <item id="ncxtoc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    </manifest><spine toc="ncxtoc"></spine></package>`,
    'OEBPS/content.opf'
  )

  const read = (href: string): string | null =>
    href === 'OEBPS/nav.xhtml' ? NAV : href === 'OEBPS/toc.ncx' ? NCX : null

  it('prefers the EPUB 3 navigation document', () => {
    expect(navigationOf(withNav, read)).toHaveLength(5)
  })

  it('falls back to the NCX the spine names', () => {
    // Publishers ship both and neither is reliably present; a book carrying
    // only the NCX is not broken.
    expect(navigationOf(withNav, (href) => (href === 'OEBPS/toc.ncx' ? NCX : null))).toHaveLength(3)
  })

  it('reports nothing rather than failing when the book has neither', () => {
    expect(navigationOf(withNav, () => null)).toEqual([])
  })
})
