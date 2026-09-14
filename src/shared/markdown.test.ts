import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders a container directive as a titled box', () => {
    const html = renderMarkdown(':::theorem[Theorem 5.1]\nThe eigenvalues are the diagonal.\n:::')
    expect(html).toContain('<section')
    expect(html).toContain('theorem')
    expect(html).toContain('box-label')
    expect(html).toContain('Theorem 5.1')
    expect(html).toContain('The eigenvalues are the diagonal.')
  })

  it('renders solutions collapsed, so the reader attempts the problem first', () => {
    const html = renderMarkdown(':::solution\nBecause it is triangular.\n:::')
    expect(html).toContain('<details')
    expect(html).not.toContain('<section')
  })

  it('carries a difficulty attribute onto the element', () => {
    const html = renderMarkdown(':::problem[Practice 1]{difficulty="easy"}\nFind them.\n:::')
    expect(html).toContain('difficulty-easy')
    expect(html).toContain('data-difficulty="easy"')
  })

  it('nests a solution inside a problem', () => {
    const html = renderMarkdown(
      '::::problem[Practice 1]\nFind them.\n\n:::solution\nDiagonal entries.\n:::\n::::'
    )
    expect(html).toContain('problem')
    expect(html).toContain('<details')
    expect(html).toContain('Diagonal entries.')
  })

  it('renders an unknown directive rather than dropping its content', () => {
    // Silently discarding content is the one failure a reader cannot diagnose.
    const html = renderMarkdown(':::mystery[Some label]\nImportant text.\n:::')
    expect(html).toContain('Important text.')
    expect(html).toContain('box-unknown')
  })

  it('leaves mathematics as delimiters for MathJax to typeset in the page', () => {
    // Pre-rendering here would break book-scoped macros and leave M4's speech
    // path with no MathML to read.
    const inline = renderMarkdown('The value $\\lambda=7$ works.')
    expect(inline).toContain('\\(\\lambda=7\\)')

    // Display mathematics needs its delimiters on their own lines; written on
    // one line remark-math treats it as inline.
    const display = renderMarkdown('$$\nA\\mathbf{x} = \\lambda\\mathbf{x}\n$$')
    expect(display).toContain('\\[A\\mathbf{x} = \\lambda\\mathbf{x}\\]')
    expect(display).toContain('math-display')
  })

  it('does not corrupt backslashes or ampersands inside a matrix', () => {
    const html = renderMarkdown('$$\n\\begin{bmatrix}1&6\\\\5&2\\end{bmatrix}\n$$')
    expect(html).toContain('\\begin{bmatrix}')
    expect(html).toContain('\\\\')

    // The ampersand is a column separator. It is emitted as a character
    // reference, which is correct -- what matters is that MathJax reads a
    // literal `&` after the browser has parsed the markup, so the assertion is
    // on the decoded text rather than on one particular spelling of it.
    const decoded = html
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&amp;/g, '&')
    expect(decoded).toContain('\\begin{bmatrix}1&6\\\\5&2\\end{bmatrix}')
  })

  it('strips front matter from the rendered body', () => {
    const html = renderMarkdown('---\ntitle: "Eigenvalues"\n---\n\nBody text.')
    expect(html).toContain('Body text.')
    expect(html).not.toContain('title:')
  })

  it('renders tables and fenced code', () => {
    expect(renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')).toContain('<table>')
    expect(renderMarkdown('```ts\nconst x = 1\n```')).toContain('<code')
  })
})

/*
  A figure is raw HTML, so its caption never passes through remark-math. Every
  one of the library's 43 captions arrived in the page with its dollar signs
  and LaTeX source intact, untypeset and unspeakable. These are shaped after
  the real ones in calculus-3 chapter 1.
*/
describe('renderMarkdown, figure captions', () => {
  const figure = (caption: string): string =>
    renderMarkdown(`<figure class="fig">\n<svg></svg>\n<figcaption>${caption}</figcaption>\n</figure>`)

  it('gives caption mathematics the wrapper a paragraph gets', () => {
    const html = figure('Example 1.5. $x = 3t$, $y = t^{2}$ gives the whole parabola.')
    expect(html).toContain('<span class="math-inline" data-latex="x = 3t">\\(x = 3t\\)</span>')
    expect(html).toContain('data-latex="y = t^{2}"')
    expect(html).not.toContain('$')
    expect(html).toContain('Example 1.5.')
    expect(html).toContain('gives the whole parabola.')
  })

  it('keeps backslash commands intact', () => {
    const html = figure('The cardioid $r = 1+\\cos\\theta$: area $3\\pi/2$.')
    expect(html).toContain('data-latex="r = 1+\\cos\\theta"')
    expect(html).toContain('data-latex="3\\pi/2"')
  })

  it('leaves money alone', () => {
    // Pandoc's rule: a closing dollar followed by a digit is not a closing
    // dollar, which is what keeps a price from being typeset.
    const html = figure('Tickets cost $5 and $10 at the door.')
    expect(html).not.toContain('math-inline')
    expect(html).toContain('$5 and $10')
  })

  it('reaches into markup inside the caption', () => {
    expect(figure('<em>Area</em> is $\\pi r^2$.')).toContain('data-latex="\\pi r^2"')
  })

  it('does not touch raw HTML that is not a caption', () => {
    // Outside a caption a dollar sign is as likely to be money as mathematics.
    const html = renderMarkdown('<div class="note">Costs $x$ dollars</div>')
    expect(html).not.toContain('math-inline')
  })
})
