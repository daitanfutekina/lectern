import { describe, expect, it } from 'vitest'
import { bodyOf, opfPath, parseOpf, resolveHref, titleFromDocument } from './epub'

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
