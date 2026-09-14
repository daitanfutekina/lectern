import { describe, expect, it } from 'vitest'
import { findMatches, htmlPlain, markdownPlain, queryPattern } from './find'

describe('markdownPlain', () => {
  it('keeps prose and drops what is never shown as text', () => {
    const text = markdownPlain(
      [
        '---',
        'title: "Eigenvalues"',
        '---',
        '# 5.1 Eigenvectors',
        'An eigenvector keeps its **direction** under $A\\mathbf{x}$.',
        '',
        '$$\\det(A - \\lambda I) = 0$$',
        '',
        '<figure><svg><text>eigen</text></svg><figcaption>The eigen line.</figcaption></figure>'
      ].join('\n')
    )
    expect(text).toContain('5.1 Eigenvectors')
    expect(text).toContain('keeps its direction under')
    expect(text).toContain('The eigen line.')
    // Front matter, typeset mathematics and a drawing's labels are not prose.
    expect(text).not.toContain('title:')
    expect(text).not.toContain('mathbf')
    expect(text).not.toContain('lambda')
    expect(text.match(/eigen/gi)?.length).toBe(3)
  })

  it('keeps a directive label, which is what is printed', () => {
    expect(markdownPlain(':::theorem[Theorem 5.1]\nThe diagonal.\n:::')).toContain('Theorem 5.1')
  })

  it('keeps underscores, which Godot readers search for', () => {
    expect(markdownPlain('Call `erase_cell(coords)` on the layer.')).toContain('erase_cell')
  })

  it('leaves money as money', () => {
    expect(markdownPlain('A ticket costs $5 and a season pass $10.')).toContain('$5 and a season pass $10')
  })

  it('keeps a link and drops where it points', () => {
    const text = markdownPlain('See [the rank theorem](ch4.md#rank).')
    expect(text).toContain('the rank theorem')
    expect(text).not.toContain('ch4.md')
  })
})

describe('htmlPlain', () => {
  it('reduces a publisher document to its prose', () => {
    const text = htmlPlain(
      '<html><head><title>x</title><style>p{color:red}</style></head>' +
        '<body><h2>5</h2><p class="chap_ttl">Deployability</p><p>Ship &amp; release&nbsp;often.</p></body></html>'
    )
    expect(text).toContain('Deployability')
    expect(text).toContain('Ship & release often.')
    expect(text).not.toContain('color:red')
  })
})

describe('queryPattern', () => {
  it('matches literally, ignoring case', () => {
    const pattern = queryPattern('A.x') as RegExp
    expect('solve a.x = b'.match(pattern)).not.toBeNull()
    expect('solve aZx = b'.match(pattern)).toBeNull()
  })

  it('treats a space as any run of whitespace', () => {
    // A phrase that wraps onto the next source line is one phrase on the page.
    expect('the null\n   space of A'.match(queryPattern('null space') as RegExp)).not.toBeNull()
  })

  it('refuses a query too short to mean anything', () => {
    expect(queryPattern('')).toBeNull()
    expect(queryPattern('  a  ')).toBeNull()
    expect(queryPattern('ab')).not.toBeNull()
  })
})

describe('findMatches', () => {
  const text = 'A matrix has a rank. The rank theorem ties rank to nullity. Rank again.'

  it('finds every occurrence, in order, numbered', () => {
    const { matches, total } = findMatches(text, queryPattern('rank') as RegExp)
    expect(total).toBe(4)
    expect(matches.map((m) => m.occurrence)).toEqual([0, 1, 2, 3])
    expect(matches[3]?.match).toBe('Rank')
  })

  it('shows enough either side to recognise the passage', () => {
    const [first] = findMatches(text, queryPattern('theorem') as RegExp).matches
    expect(first?.before).toContain('The rank')
    expect(first?.after).toContain('ties rank')
  })

  it('counts past the limit so the list can say how many more', () => {
    const { matches, total } = findMatches('x '.repeat(200), queryPattern('x x') as RegExp, 5)
    expect(matches).toHaveLength(5)
    expect(total).toBeGreaterThan(5)
  })
})
