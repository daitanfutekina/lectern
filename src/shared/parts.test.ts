import { describe, expect, it } from 'vitest'
import { groupChapters, isSubChapter } from './parts'
import type { Book, Chapter } from './library'

const chapter = (file: string): Chapter => ({
  file,
  title: file,
  crumb: null,
  headings: [],
  words: 100
})

const book = (files: string[], parts: { title: string; chapters: string[] }[] = []): Book => ({
  id: 'godot',
  title: 'A Book',
  format: 'markdown',
  path: 'C:/Library/books/godot',
  chapters: files.map(chapter),
  parts,
  macros: {}
})

describe('groupChapters', () => {
  it('gives one untitled group when no parts are declared', () => {
    const groups = groupChapters(book(['g_ch1_a.md', 'g_ch2_b.md']))
    expect(groups).toHaveLength(1)
    expect(groups[0]?.title).toBeNull()
    expect(groups[0]?.chapters.map((c) => c.file)).toEqual(['g_ch1_a.md', 'g_ch2_b.md'])
  })

  it('groups in the order the parts declare', () => {
    const groups = groupChapters(
      book(['g_ch1_a.md', 'g_ch2_b.md', 'g_ch3_c.md'], [
        { title: 'Part I', chapters: ['g_ch1_a.md', 'g_ch2_b.md'] },
        { title: 'Part II', chapters: ['g_ch3_c.md'] }
      ])
    )
    expect(groups.map((g) => g.title)).toEqual(['Part I', 'Part II'])
    expect(groups[0]?.chapters).toHaveLength(2)
  })

  /*
    The failure this guards is silent and total: a chapter that no part
    mentions must still be reachable. A typo in one part title is a small
    mistake; a chapter disappearing out of the sidebar because of it is not.
  */
  it('appends what no part mentions rather than dropping it', () => {
    const groups = groupChapters(
      book(['g_ch1_a.md', 'g_ch2_b.md'], [{ title: 'Part I', chapters: ['g_ch1_a.md'] }])
    )
    expect(groups.map((g) => g.title)).toEqual(['Part I', null])
    expect(groups[1]?.chapters.map((c) => c.file)).toEqual(['g_ch2_b.md'])

    const everyChapter = groups.flatMap((g) => g.chapters.map((c) => c.file))
    expect(everyChapter).toEqual(['g_ch1_a.md', 'g_ch2_b.md'])
  })

  it('never lists a chapter twice, even if two parts claim it', () => {
    const groups = groupChapters(
      book(['g_ch1_a.md'], [
        { title: 'Part I', chapters: ['g_ch1_a.md'] },
        { title: 'Part II', chapters: ['g_ch1_a.md'] }
      ])
    )
    expect(groups.flatMap((g) => g.chapters)).toHaveLength(1)
    expect(groups.map((g) => g.title)).toEqual(['Part I'])
  })

  it('drops a part left with nothing after filtering', () => {
    const groups = groupChapters(
      book(['g_ch1_a.md'], [
        { title: 'Ghost', chapters: ['g_ch99_typo.md'] },
        { title: 'Real', chapters: ['g_ch1_a.md'] }
      ])
    )
    expect(groups.map((g) => g.title)).toEqual(['Real'])
  })
})

describe('isSubChapter', () => {
  const walkthrough = book(['g_ch70_design.md', 'g_ch70a_setup.md', 'g_ch71b_player.md'])

  it('is true for a lettered chapter whose parent is present', () => {
    expect(isSubChapter(walkthrough, chapter('g_ch70a_setup.md'))).toBe(true)
  })

  it('is false for the parent itself', () => {
    expect(isSubChapter(walkthrough, chapter('g_ch70_design.md'))).toBe(false)
  })

  /* A lone `ch71b` with no `ch71` is a chapter in its own right, not a child. */
  it('is false when the parent is absent', () => {
    expect(isSubChapter(walkthrough, chapter('g_ch71b_player.md'))).toBe(false)
  })

  it('handles the part-prefixed series', () => {
    const b = book(['g_p2ch8_typing.md', 'g_p2ch8a_more.md'])
    expect(isSubChapter(b, chapter('g_p2ch8a_more.md'))).toBe(true)
  })
})
