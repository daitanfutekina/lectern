import { describe, expect, it } from 'vitest'
import { parseManifest } from './manifest'

const BOOK = `
title: "A Book"
author: "A. Reader"
index: "idx.md"
chapters:
  - a_ch1_one.md
  - a_ch2_two.md
  - a_ch3_three.md
`

describe('parseManifest parts', () => {
  it('keeps searchable book metadata', () => {
    const manifest = parseManifest(BOOK)
    expect(manifest.title).toBe('A Book')
    expect(manifest.author).toBe('A. Reader')
  })

  it('is empty for a book that declares none, which is most of them', () => {
    const m = parseManifest(BOOK)
    expect(m.chapters).toHaveLength(3)
    expect(m.parts).toEqual([])
  })

  it('groups the chapters it names', () => {
    const m = parseManifest(`${BOOK}
parts:
  - title: "Part I"
    chapters:
      - a_ch1_one.md
      - a_ch2_two.md
  - title: "Part II"
    chapters:
      - a_ch3_three.md
`)
    expect(m.parts.map((p) => p.title)).toEqual(['Part I', 'Part II'])
    expect(m.parts[0]?.chapters).toEqual(['a_ch1_one.md', 'a_ch2_two.md'])
  })

  /*
    The reading order stays in `chapters:`. A part naming a file that is not
    there must not smuggle it in, and a part that names nothing real must not
    survive as an empty heading -- both would make the manifest a second,
    disagreeing source of what the book contains.
  */
  it('ignores a chapter a part names but the book does not list', () => {
    const m = parseManifest(`${BOOK}
parts:
  - title: "Part I"
    chapters:
      - a_ch1_one.md
      - a_ch9_missing.md
`)
    expect(m.parts[0]?.chapters).toEqual(['a_ch1_one.md'])
  })

  it('drops a part with no title, and one whose chapters all fail to resolve', () => {
    const m = parseManifest(`${BOOK}
parts:
  - chapters:
      - a_ch1_one.md
  - title: "Ghosts"
    chapters:
      - a_ch9_missing.md
  - title: "Real"
    chapters:
      - a_ch2_two.md
`)
    expect(m.parts.map((p) => p.title)).toEqual(['Real'])
  })

  it('degrades rather than throwing on parts of the wrong shape', () => {
    expect(parseManifest(`${BOOK}\nparts: "Part I"\n`).parts).toEqual([])
    expect(parseManifest(`${BOOK}\nparts:\n  - 12\n`).parts).toEqual([])
    expect(parseManifest(`${BOOK}\nparts:\n  - title: "P"\n    chapters: 7\n`).parts).toEqual([])
  })
})
