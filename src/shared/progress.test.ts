import { describe, expect, it } from 'vitest'
import {
  EMPTY_PROGRESS,
  START,
  advance,
  bookmarkId,
  fractionAt,
  fractionRead,
  isFinished,
  parseProgress,
  positionAt,
  sidebarProgressKey,
  scrollTopFor
} from './progress'

/** Block offsets for a chapter: five blocks, 100px apart. */
const TOPS = [0, 100, 200, 300, 400]

describe('positionAt', () => {
  it('anchors to the block containing the scroll position', () => {
    expect(positionAt(TOPS, 0)).toEqual({ block: 0, within: 0 })
    expect(positionAt(TOPS, 200)).toEqual({ block: 2, within: 0 })
    expect(positionAt(TOPS, 250)).toEqual({ block: 2, within: 0.5 })
  })

  it('anchors mid-block to that block, not the next one', () => {
    expect(positionAt(TOPS, 199).block).toBe(1)
  })

  it('reports no fraction for the last block, which has no known end', () => {
    expect(positionAt(TOPS, 450)).toEqual({ block: 4, within: 0 })
  })

  it('handles an empty chapter', () => {
    expect(positionAt([], 500)).toEqual(START)
  })
})

describe('scrollTopFor', () => {
  it('round-trips a position', () => {
    for (const scrollTop of [0, 100, 250, 399]) {
      expect(scrollTopFor(TOPS, positionAt(TOPS, scrollTop))).toBe(scrollTop)
    }
  })

  it('survives the layout changing between sessions', () => {
    // The whole reason a position is not a pixel offset: reopening at a
    // different window width must land in the same paragraph, not the same
    // number of pixels down.
    const position = positionAt(TOPS, 250)
    const wider = [0, 60, 120, 180, 240]
    expect(scrollTopFor(wider, position)).toBe(150)
  })

  it('clamps a block index past the end rather than failing', () => {
    // The chapter was edited and got shorter since the position was stored.
    expect(scrollTopFor(TOPS, { block: 99, within: 0.5 })).toBe(400)
  })

  it('returns the top for an empty chapter', () => {
    expect(scrollTopFor([], { block: 3, within: 0.5 })).toBe(0)
  })
})

describe('advance', () => {
  it('records the position', () => {
    const progress = advance(null, { block: 2, within: 0.5 }, 5, 1000)
    expect(progress.position).toEqual({ block: 2, within: 0.5 })
    expect(progress.blocks).toBe(5)
    expect(progress.updatedAt).toBe(1000)
  })

  it('never lets furthest go backwards when you scroll up to re-read', () => {
    const read = advance(null, { block: 4, within: 0 }, 5, 1000)
    const backUp = advance(read, { block: 1, within: 0 }, 5, 2000)
    expect(backUp.position.block).toBe(1)
    expect(backUp.furthest).toBe(4)
  })
})

describe('fractionRead', () => {
  it('is zero with no progress', () => {
    expect(fractionRead(null)).toBe(0)
  })

  it('counts the furthest block reached, inclusive', () => {
    expect(fractionRead(advance(null, { block: 0, within: 0 }, 4, 0))).toBe(0.25)
    expect(fractionRead(advance(null, { block: 3, within: 0 }, 4, 0))).toBe(1)
  })
})

describe('fractionAt', () => {
  it('is zero with no progress', () => {
    expect(fractionAt(null)).toBe(0)
  })

  it('reports where the reader is, not how far they got', () => {
    expect(fractionAt(advance(null, { block: 0, within: 0 }, 5, 0))).toBe(0)
    expect(fractionAt(advance(null, { block: 2, within: 0 }, 5, 0))).toBe(0.5)
    expect(fractionAt(advance(null, { block: 4, within: 0 }, 5, 0))).toBe(1)
  })

  /*
    The whole point of this existing. Skim to the end and scroll back and
    coverage stays full, which is right for the shelf and wrong beside the open
    chapter -- a bar that cannot come down is not telling you where you are.
  */
  it('comes back down after scrolling back, where fractionRead does not', () => {
    const skimmed = advance(null, { block: 4, within: 0 }, 5, 0)
    const backNearTop = advance(skimmed, { block: 1, within: 0 }, 5, 1)

    expect(fractionRead(backNearTop)).toBe(1)
    expect(fractionAt(backNearTop)).toBe(0.25)
  })

  it('counts part-way into a block', () => {
    expect(fractionAt(advance(null, { block: 1, within: 0.5 }, 5, 0))).toBe(0.375)
  })

  it('is complete for a chapter that is a single block', () => {
    expect(fractionAt(advance(null, { block: 0, within: 0 }, 1, 0))).toBe(1)
  })
})

describe('isFinished', () => {
  it('is true once the last block has been reached', () => {
    expect(isFinished(advance(null, { block: 3, within: 0 }, 4, 0))).toBe(true)
    expect(isFinished(advance(null, { block: 2, within: 0 }, 4, 0))).toBe(false)
    expect(isFinished(null)).toBe(false)
  })
})

describe('sidebarProgressKey', () => {
  it('stays stable while no displayed value changes', () => {
    const before = advance(null, { block: 20, within: 0.1 }, 101, 0)
    const after = advance(before, { block: 20, within: 0.4 }, 101, 1)
    expect(sidebarProgressKey(after, 2)).toBe(sidebarProgressKey(before, 2))
  })

  it('changes with rounded progress, completion, or the active section', () => {
    const before = advance(null, { block: 20, within: 0.4 }, 101, 0)
    const nextPercent = advance(before, { block: 20, within: 0.6 }, 101, 1)
    const finished = advance(nextPercent, { block: 100, within: 0 }, 101, 2)

    expect(sidebarProgressKey(nextPercent, 2)).not.toBe(sidebarProgressKey(before, 2))
    expect(sidebarProgressKey(finished, 2)).not.toBe(sidebarProgressKey(nextPercent, 2))
    expect(sidebarProgressKey(before, 3)).not.toBe(sidebarProgressKey(before, 2))
  })
})

describe('bookmarkId', () => {
  it('differs for two bookmarks made in the same millisecond', () => {
    expect(bookmarkId(1000, 0.1)).not.toBe(bookmarkId(1000, 0.9))
  })
})

describe('parseProgress', () => {
  it('survives malformed JSON rather than refusing to open the library', () => {
    expect(parseProgress('{ not json')).toEqual(EMPTY_PROGRESS)
    expect(parseProgress('')).toEqual(EMPTY_PROGRESS)
    expect(parseProgress('[]')).toEqual(EMPTY_PROGRESS)
  })

  it('round-trips a real shape', () => {
    const stored = {
      lastBook: 'linear-algebra',
      books: {
        'linear-algebra': {
          lastChapter: 'ch2.md',
          chapters: { 'ch2.md': { position: { block: 3, within: 0.25 }, furthest: 7, blocks: 20, updatedAt: 5 } },
          bookmarks: [
            { id: 'a', chapter: 'ch2.md', position: { block: 1, within: 0 }, label: 'Eigen', createdAt: 9 }
          ]
        }
      }
    }
    const parsed = parseProgress(JSON.stringify(stored))
    expect(parsed.lastBook).toBe('linear-algebra')
    expect(parsed.books['linear-algebra']?.chapters['ch2.md']?.furthest).toBe(7)
    expect(parsed.books['linear-algebra']?.bookmarks[0]?.label).toBe('Eigen')
  })

  it('clamps nonsense rather than trusting the file', () => {
    const parsed = parseProgress(
      JSON.stringify({
        books: { b: { chapters: { c: { position: { block: -5, within: 42 }, furthest: -1, blocks: 3 } } } }
      })
    )
    const chapter = parsed.books['b']?.chapters['c']
    expect(chapter?.position).toEqual({ block: 0, within: 1 })
    expect(chapter?.furthest).toBe(0)
  })

  it('drops a bookmark missing its identity instead of keeping a broken one', () => {
    const parsed = parseProgress(
      JSON.stringify({ books: { b: { bookmarks: [{ label: 'no id or chapter' }] } } })
    )
    expect(parsed.books['b']?.bookmarks).toEqual([])
  })
})
