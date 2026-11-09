import { describe, expect, it } from 'vitest'
import { epubReadBlock } from './epub-click'

function element(speak = true): { getAttribute(name: string): string | null } {
  return {
    getAttribute: (name) => (name === 'data-speak' && !speak ? 'no' : null)
  }
}

function target(
  block: ReturnType<typeof element> | null,
  control: ReturnType<typeof element> | null = null
): object {
  return {
    closest: (selector: string) => (selector.startsWith('button') ? control : block)
  }
}

describe('epubReadBlock', () => {
  it('accepts a frame block by shape without relying on instanceof', () => {
    const paragraph = element()

    expect(epubReadBlock(target(paragraph))).toBe(paragraph)
  })

  it('ignores controls, silent blocks, and non-elements', () => {
    expect(epubReadBlock(target(element(), element()))).toBeNull()
    expect(epubReadBlock(target(element(false)))).toBeNull()
    expect(epubReadBlock({})).toBeNull()
  })
})
