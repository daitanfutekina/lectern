interface ClosestElement {
  getAttribute(name: string): string | null
}

interface ClosestTarget {
  closest(selector: string): ClosestElement | null
}

function hasClosest(target: unknown): target is ClosestTarget {
  return (
    typeof target === 'object' &&
    target !== null &&
    'closest' in target &&
    typeof target.closest === 'function'
  )
}

/** The EPUB block selected by click-to-read, independent of its DOM realm. */
export function epubReadBlock(target: unknown): ClosestElement | null {
  if (!hasClosest(target)) return null
  if (target.closest('button, a, summary, input, select')) return null

  const block = target.closest('p, h1, h2, h3, h4, h5, h6, li, figcaption')
  return block?.getAttribute('data-speak') === 'no' ? null : block
}
