import { describe, expect, it } from 'vitest'
import { countWords, extractHeadings, outline, readingMinutes } from './outline'

describe('outline', () => {
  it('returns headings with their levels, in document order', () => {
    expect(outline('# One\n\ntext\n\n## Two\n\n### Three')).toEqual([
      { level: 1, text: 'One' },
      { level: 2, text: 'Two' },
      { level: 3, text: 'Three' }
    ])
  })

  it('ignores a hash inside a fenced code block', () => {
    // The whole reason this module is hand-written rather than delegating to the
    // Markdown parser: a shell comment is not a chapter heading.
    const source = '# Real\n\n```bash\n# not a heading\nls -la\n```\n\n## Also real'
    expect(extractHeadings(source)).toEqual(['Real', 'Also real'])
  })

  it('handles tilde fences and longer fence runs', () => {
    expect(extractHeadings('# A\n\n~~~\n# no\n~~~\n\n# B')).toEqual(['A', 'B'])
    expect(extractHeadings('# A\n\n````\n# no\n````\n\n# B')).toEqual(['A', 'B'])
  })

  it('does not treat a shorter run inside a longer fence as a close', () => {
    const source = '# A\n\n````\n```\n# still code\n```\n````\n\n# B'
    expect(extractHeadings(source)).toEqual(['A', 'B'])
  })

  it('strips inline syntax from heading text', () => {
    expect(extractHeadings('## The **bold** and `code` bit')).toEqual(['The bold and code bit'])
  })

  it('skips front matter', () => {
    expect(extractHeadings('---\ntitle: "Not a heading"\n---\n\n# Real')).toEqual(['Real'])
  })

  it('requires a space after the hashes', () => {
    // `#hashtag` is not a heading, and a chapter mentioning one should not gain
    // a phantom entry in the library index.
    expect(extractHeadings('#nothashtag\n\n# Real')).toEqual(['Real'])
  })

  it('is empty for a chapter with no headings', () => {
    expect(extractHeadings('just a paragraph')).toEqual([])
  })
})

describe('countWords', () => {
  it('counts prose', () => {
    expect(countWords('one two three')).toBe(3)
  })

  it('ignores mathematics, so dense algebra is not counted as long prose', () => {
    expect(countWords('The value $\\lambda=7$ works')).toBe(3)
    expect(countWords('text $$\n\\begin{bmatrix}1&6\\end{bmatrix}\n$$ more')).toBe(2)
  })

  it('ignores code blocks', () => {
    expect(countWords('two words\n\n```ts\nconst manyWordsHere = true\n```')).toBe(2)
  })

  it('ignores front matter and directive syntax', () => {
    expect(countWords('---\ntitle: "Skip me"\n---\n\n:::theorem[Label]\nreal words here\n:::')).toBe(3)
  })
})

describe('readingMinutes', () => {
  it('rounds to whole minutes', () => {
    expect(readingMinutes(2000)).toBe(10)
  })

  it('never reports zero, because every chapter takes some time', () => {
    expect(readingMinutes(0)).toBe(1)
    expect(readingMinutes(10)).toBe(1)
  })
})
