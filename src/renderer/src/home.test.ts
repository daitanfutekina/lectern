import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Book, LibraryIndex } from '@shared/library'
import { renderHome, type HomeOptions } from './home'

class FakeElement {
  readonly children: FakeElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly style = { setProperty: vi.fn() }
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, EventListenerOrEventListenerObject[]>()
  className = ''
  textContent = ''
  type = ''
  title = ''
  accept = ''
  hidden = false
  multiple = false
  files: File[] | null = null
  clickCount = 0

  constructor(readonly tagName: string) {}

  readonly classList = {
    add: (...names: string[]): void => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean))
      for (const name of names) classes.add(name)
      this.className = [...classes].join(' ')
    }
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  click(): void {
    this.clickCount += 1
    this.dispatch('click')
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener({} as Event)
      else listener.handleEvent({} as Event)
    }
  }
}

function findByClass(root: FakeElement, name: string): FakeElement | null {
  if (root.className.split(/\s+/).includes(name)) return root
  for (const child of root.children) {
    const found = findByClass(child, name)
    if (found) return found
  }
  return null
}

function findByTag(root: FakeElement, tagName: string): FakeElement | null {
  if (root.tagName === tagName) return root
  for (const child of root.children) {
    const found = findByTag(child, tagName)
    if (found) return found
  }
  return null
}

const book: Book = {
  id: 'one',
  title: 'One Book',
  format: 'pdf',
  path: 'C:\\Books\\one.pdf',
  chapters: [],
  parts: [],
  macros: {}
}

const index = (books: readonly Book[]): LibraryIndex => ({
  root: 'C:\\Library',
  scannedAt: 1,
  books
})

function options(
  onAdd: (files: readonly File[]) => void = vi.fn(),
  hasNeuralVoice = true
): HomeOptions {
  return {
    sort: 'title',
    facts: () => ({ addedAt: 0, readAt: 0 }),
    onSort: vi.fn(),
    onAdd,
    removable: () => false,
    onRemove: vi.fn(),
    hasNeuralVoice,
    voiceDownload: {
      start: vi.fn(),
      cancel: vi.fn(),
      installed: vi.fn()
    }
  }
}

function render(
  books: readonly Book[],
  onAdd?: (files: readonly File[]) => void,
  onOpen: (bookId: string) => void = vi.fn(),
  hasNeuralVoice = true
): FakeElement {
  vi.stubGlobal('document', {
    createElement: (tagName: string) => new FakeElement(tagName)
  })
  const container = new FakeElement('main')
  renderHome(
    container as unknown as HTMLElement,
    index(books),
    () => null,
    onOpen,
    options(onAdd, hasNeuralVoice)
  )
  return container
}

afterEach(() => vi.unstubAllGlobals())

describe('empty library', () => {
  it('renders the add-document screen and opens its file picker for zero books', () => {
    const onAdd = vi.fn()
    const container = render([], onAdd)
    const empty = findByClass(container, 'empty-library')
    const button = findByClass(container, 'empty-library-add')
    const picker = findByTag(container, 'input')

    expect(empty).not.toBeNull()
    expect(button?.textContent).toBe('Add PDF or EPUB')
    expect(picker?.accept).toContain('.pdf')
    expect(picker?.accept).toContain('.epub')

    button?.click()
    expect(picker?.clickCount).toBe(1)

    const chosen = {} as File
    if (picker) picker.files = [chosen]
    picker?.dispatch('change')
    expect(onAdd).toHaveBeenCalledWith([chosen])
  })

  it('renders the shelf instead of the empty screen for one book', () => {
    const container = render([book])

    expect(findByClass(container, 'empty-library')).toBeNull()
    expect(findByClass(container, 'shelf')).not.toBeNull()
  })

  it('offers the neural voice download on an empty shelf only when none is installed', () => {
    const withoutVoice = render([], undefined, vi.fn(), false)
    const withVoice = render([], undefined, vi.fn(), true)

    expect(findByClass(withoutVoice, 'voice-download-start')?.textContent).toBe(
      'Download free neural voice'
    )
    expect(findByClass(withVoice, 'voice-download-start')).toBeNull()
  })

  it('marks a moved file and makes its card the locate action', () => {
    const onOpen = vi.fn()
    const moved = { ...book, unavailable: 'file-moved' as const }
    const container = render([moved], undefined, onOpen)
    const card = findByClass(container, 'is-unavailable')

    expect(findByClass(container, 'shelf-meta')?.textContent).toBe('File moved · Click to locate')
    card?.click()
    expect(onOpen).toHaveBeenCalledWith('one')
  })
})
