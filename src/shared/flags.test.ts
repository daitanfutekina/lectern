import { describe, expect, it } from 'vitest'
import { EMPTY_FLAGS, excerpt, flagsToMarkdown, parseFlags, sortFlags, type Flag } from './flags'

const flag = (over: Partial<Flag> = {}): Flag => ({
  id: 'a1',
  book: 'linear-algebra',
  chapter: 'linalg_ch5_eigenvalues.md',
  kind: 'confusing',
  text: 'The characteristic polynomial is a determinant.',
  heading: 'Eigenvalues',
  block: 12,
  note: '',
  createdAt: 1000,
  ...over
})

describe('parseFlags', () => {
  it('reads a well-formed store', () => {
    const store = parseFlags(JSON.stringify({ flags: [flag()] }))
    expect(store.flags).toHaveLength(1)
    expect(store.flags[0]?.text).toBe('The characteristic polynomial is a determinant.')
  })

  it('survives a corrupt file rather than losing the library', () => {
    expect(parseFlags('not json')).toEqual(EMPTY_FLAGS)
    expect(parseFlags('{}')).toEqual(EMPTY_FLAGS)
    expect(parseFlags('{"flags":"nope"}')).toEqual(EMPTY_FLAGS)
  })

  it('drops a flag with no text', () => {
    // Text is the only durable way to find the passage again, so a flag
    // without it cannot do the one thing flags exist for.
    const store = parseFlags(JSON.stringify({ flags: [{ ...flag(), text: '   ' }] }))
    expect(store.flags).toHaveLength(0)
  })

  it('falls back to a known kind rather than trusting the file', () => {
    const store = parseFlags(JSON.stringify({ flags: [{ ...flag(), kind: 'nonsense' }] }))
    expect(store.flags[0]?.kind).toBe('confusing')
  })

  it('tolerates missing optional fields', () => {
    const store = parseFlags(JSON.stringify({ flags: [{ text: 'Just text' }] }))
    expect(store.flags[0]?.text).toBe('Just text')
    expect(store.flags[0]?.heading).toBeNull()
    expect(store.flags[0]?.block).toBe(0)
  })
})

describe('sortFlags', () => {
  it('puts the newest first', () => {
    const sorted = sortFlags([flag({ id: 'old', createdAt: 1 }), flag({ id: 'new', createdAt: 9 })])
    expect(sorted.map((f) => f.id)).toEqual(['new', 'old'])
  })
})

describe('excerpt', () => {
  it('collapses whitespace', () => {
    expect(excerpt('a   b\n\nc')).toBe('a b c')
  })

  it('truncates with an ellipsis', () => {
    expect(excerpt('abcdefghij', 5)).toBe('abcd…')
  })

  it('leaves a short passage whole', () => {
    expect(excerpt('short', 100)).toBe('short')
  })
})

describe('flagsToMarkdown', () => {
  const titleOf = (_book: string, chapter: string): string => `Chapter (${chapter})`

  it('says so plainly when there is nothing', () => {
    expect(flagsToMarkdown([], titleOf)).toContain('Nothing flagged yet')
  })

  it('quotes the passage so it can be found by searching the source', () => {
    // The one lookup that still works after the chapter has been rewritten.
    const out = flagsToMarkdown([flag()], titleOf)
    expect(out).toContain('> The characteristic polynomial is a determinant.')
  })

  it('records the source file, since that is what gets edited', () => {
    const out = flagsToMarkdown([flag()], titleOf)
    expect(out).toContain('linalg_ch5_eigenvalues.md')
    expect(out).toContain('linear-algebra')
  })

  it('groups by chapter, because fixes happen one chapter at a time', () => {
    const out = flagsToMarkdown(
      [flag({ chapter: 'a.md', text: 'First' }), flag({ chapter: 'b.md', text: 'Second' })],
      titleOf
    )
    expect(out.indexOf('a.md')).toBeLessThan(out.indexOf('b.md'))
    expect((out.match(/^## /gm) ?? [])).toHaveLength(2)
  })

  it('includes the note, which is the most valuable field when present', () => {
    const out = flagsToMarkdown([flag({ note: 'I could not follow the jump here.' })], titleOf)
    expect(out).toContain('I could not follow the jump here.')
  })

  it('labels the kind', () => {
    expect(flagsToMarkdown([flag({ kind: 'thin' })], titleOf)).toContain('Too thin')
    expect(flagsToMarkdown([flag({ kind: 'good' })], titleOf)).toContain('Worked well')
  })
})
