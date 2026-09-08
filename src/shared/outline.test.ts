import { describe, expect, it } from 'vitest'
import { countWords, extractHeadings, outline, plainMath, readingMinutes } from './outline'

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

  /*
    The chapter that first carried figures reported 48,000 words against a real
    8,000: sampled path data is thousands of `L` commands and every one matched
    [A-Za-z]. A single figure here stands in for that, and the caption beside it
    must survive -- it is prose, and it is what the speech pipeline reads.
  */
  it('drops a diagram but keeps its caption', () => {
    const chapter = [
      'Before the figure.',
      '',
      '<figure class="fig">',
      '<svg class="fig-hue-1" viewBox="0 0 150 150" role="img" aria-label="A circle">',
      '<path class="fig-curve" d="M12.00,75.00 L13.00,76.00 L14.00,77.00 L15.00,78.00"/>',
      '<text class="fig-label" x="10" y="20">x</text>',
      '</svg>',
      '<figcaption>Four caption words here</figcaption>',
      '</figure>',
      '',
      'After the figure.'
    ].join('\n')

    expect(countWords(chapter)).toBe(3 + 4 + 3)
  })

  /*
    Inequalities are prose with angle brackets in them. Stripping tags before
    the mathematics is removed matches from the `<` in one to the `>` in the
    next and deletes the sentence between -- which is how the same chapter went
    on to under-report by a quarter.
  */
  it('does not treat an inequality as an HTML tag', () => {
    expect(countWords('If $a < b$ the loop appears, and when $r > 0$ it does not')).toBe(9)
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

describe('plainMath', () => {
  it('reduces a bold matrix equation to the characters a person would read', () => {
    expect(plainMath(String.raw`\mathbf{A}\mathbf{x} = \mathbf{b}`)).toBe('Ax = b')
  })

  it('keeps plain mathematics untouched', () => {
    expect(plainMath('x_1 + 2x_3 = -5')).toBe('x_1 + 2x_3 = -5')
  })

  it('drops sizing commands rather than printing them', () => {
    expect(plainMath(String.raw`\left[ a \right]`)).toBe('[ a ]')
  })

  /*
    A heading made only of mathematics is the case that decides this exists:
    dropping the equation outright would leave the sidebar an empty row, which
    is indistinguishable from a bug.
  */
  it('leaves something behind for a heading that is only an equation', () => {
    expect(plainMath(String.raw`\mathbf{A}\mathbf{x} = \mathbf{0}`)).toBe('Ax = 0')
  })
})
