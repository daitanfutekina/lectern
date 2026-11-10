import {
  FORMAT_COLOUR,
  SHELF_SEARCH_MIN_BOOKS,
  SORT_LABELS,
  SORT_ORDER,
  filterShelf,
  initials,
  shelfEntry,
  shelfSubtitle,
  sortShelf,
  type ShelfEntry,
  type ShelfSort,
  type SortFacts
} from '@shared/shelf'
import type { Book, LibraryIndex } from '@shared/library'
import { voiceDownloadControl, type VoiceDownloadActions } from './voice-download-view'

/**
 * The shelf. SPEC section 3.
 *
 * A grid of covers, because a book is recognised by its cover long before its
 * title is read, and because the question a home page answers is "which of
 * these" rather than "what is in this one".
 *
 * Covers are found where they exist and drawn where they do not: an EPUB
 * declares one, a PDF has a first page, and a Markdown textbook has neither --
 * so it gets a generated card that is still distinguishable at a glance,
 * because a wall of identical placeholders is no better than a list.
 */

type OnOpen = (bookId: string) => void

const covers = new Map<string, string>()

export interface HomeOptions {
  readonly sort: ShelfSort
  readonly facts: (id: string) => SortFacts
  readonly onSort: (sort: ShelfSort) => void
  readonly onAdd: (files: readonly File[]) => void
  /** Whether a book can be taken off the shelf -- an added document, and nothing of ours. */
  readonly removable: (id: string) => boolean
  readonly onRemove: (id: string) => void
  readonly hasNeuralVoice: boolean
  readonly voiceDownload: VoiceDownloadActions
}

export function renderHome(
  container: HTMLElement,
  index: LibraryIndex,
  progressOf: (book: Book) => number | null,
  onOpen: OnOpen,
  options: HomeOptions
): void {
  container.replaceChildren()

  const header = document.createElement('header')
  header.className = 'shelf-header'
  const heading = document.createElement('h2')
  heading.textContent = 'Library'
  header.append(heading)

  const hint = document.createElement('p')
  hint.className = 'shelf-hint'
  hint.textContent =
    index.books.length === 0
      ? `Drop a PDF or EPUB here, or put a book folder in ${index.root}\\books`
      : 'Drop a PDF or EPUB anywhere on this window to add it.'
  // Said only when there is something it applies to, so the hint never offers
  // an action the shelf in front of the reader cannot perform.
  if (index.books.some((book) => options.removable(book.id))) {
    hint.textContent += ' Right-click one you added to remove it.'
  }
  header.append(hint)

  const entries = sortShelf(
    index.books.map((book) => shelfEntry(book, progressOf(book))),
    options.sort,
    options.facts
  )

  let search: HTMLInputElement | null = null
  if (index.books.length >= SHELF_SEARCH_MIN_BOOKS) {
    search = document.createElement('input')
    search.type = 'search'
    search.className = 'shelf-search'
    search.placeholder = 'Search title or author'
    search.autocomplete = 'off'
    search.spellcheck = false
    search.setAttribute('aria-label', 'Search books by title or author')
    header.append(search)
  }

  if (index.books.length > 1) {
    const sort = document.createElement('select')
    sort.className = 'shelf-sort'
    sort.title = 'Order the shelf'
    for (const option of SORT_ORDER) {
      const item = document.createElement('option')
      item.value = option
      item.textContent = SORT_LABELS[option]
      sort.append(item)
    }
    sort.value = options.sort
    sort.addEventListener('change', () => options.onSort(sort.value as ShelfSort))
    header.append(sort)
  }

  container.append(header)
  if (index.books.length === 0) {
    container.append(emptyLibrary(options.onAdd, options))
    return
  }

  const grid = document.createElement('div')
  grid.className = 'shelf'

  const paint = (query: string): void => {
    grid.replaceChildren()
    const shown = filterShelf(entries, query)
    for (const entry of shown) grid.append(card(entry, onOpen, options))
    if (shown.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'shelf-no-results'
      empty.textContent = 'No books match that search.'
      grid.append(empty)
    }
  }
  search?.addEventListener('input', () => paint(search?.value ?? ''))
  paint('')
  container.append(grid)
}

function emptyLibrary(onAdd: (files: readonly File[]) => void, options: HomeOptions): HTMLElement {
  const empty = document.createElement('section')
  empty.className = 'empty-library'

  const mark = document.createElement('div')
  mark.className = 'empty-library-mark'
  mark.setAttribute('aria-hidden', 'true')
  mark.textContent = 'Aa'

  const heading = document.createElement('h3')
  heading.textContent = 'Your library is ready'

  const message = document.createElement('p')
  message.textContent = 'Add a PDF or EPUB to start reading. Lectern keeps the file where it is.'

  const picker = document.createElement('input')
  picker.type = 'file'
  picker.accept = '.pdf,.epub,application/pdf,application/epub+zip'
  picker.multiple = true
  picker.hidden = true
  picker.addEventListener('change', () => onAdd(Array.from(picker.files ?? [])))

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'empty-library-add'
  button.textContent = 'Add PDF or EPUB'
  button.addEventListener('click', () => picker.click())

  empty.append(mark, heading, message, picker, button)
  if (!options.hasNeuralVoice) {
    const voiceMessage = document.createElement('p')
    voiceMessage.className = 'empty-library-voice-note'
    voiceMessage.textContent =
      'System voices work immediately. For more natural speech, install the free offline Lessac voice.'
    empty.append(voiceMessage, voiceDownloadControl(options.voiceDownload))
  }
  return empty
}

function card(entry: ShelfEntry, onOpen: OnOpen, options: HomeOptions): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'shelf-card'
  button.dataset['book'] = entry.id
  button.title =
    entry.unavailable === 'file-moved'
      ? `${entry.title} — file moved; click to locate it`
      : entry.title
  if (entry.unavailable) button.classList.add('is-unavailable')

  const art = document.createElement('div')
  art.className = 'shelf-art'

  const cached = covers.get(entry.id)
  if (cached) {
    const image = document.createElement('img')
    image.src = cached
    image.alt = ''
    art.append(image)
  } else {
    // Generated: initials over the format's colour. Told apart at a glance,
    // which is the only job a placeholder cover has.
    art.classList.add('is-generated')
    art.style.setProperty('--cover', FORMAT_COLOUR[entry.format])
    const mark = document.createElement('span')
    mark.className = 'shelf-initials'
    mark.textContent = initials(entry.title)
    art.append(mark)
  }

  // A corner ribbon rather than a line of text: it says what the file is
  // without competing with the title for the reader's attention.
  const ribbon = document.createElement('span')
  ribbon.className = `shelf-ribbon ribbon-${entry.format}`
  ribbon.textContent = entry.badge
  art.append(ribbon)

  if (entry.progress !== null && entry.progress > 0) {
    const track = document.createElement('span')
    track.className = 'shelf-progress'
    const fill = document.createElement('span')
    fill.style.width = `${Math.round(Math.min(1, entry.progress) * 100)}%`
    track.append(fill)
    art.append(track)
  }

  const title = document.createElement('span')
  title.className = 'shelf-title'
  title.textContent = entry.title

  const meta = document.createElement('span')
  meta.className = 'shelf-meta'
  meta.textContent = shelfSubtitle(entry)

  button.append(art, title)
  if (entry.author) {
    const author = document.createElement('span')
    author.className = 'shelf-author'
    author.textContent = entry.author
    button.append(author)
  }
  button.append(meta)
  button.addEventListener('click', () => onOpen(entry.id))

  /*
    Right-click to remove, and never a visible button on the card.

    A card is one large target that means "open this". A remove control inside
    it is a small target sitting where a click to open lands, which is exactly
    the accident this has to prevent -- and on a touchpad a stray tap is far
    easier to produce than a two-finger one. The main process then asks before
    anything changes, with Cancel as the default.
  */
  if (options.removable(entry.id)) {
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      options.onRemove(entry.id)
    })
  }
  return button
}

/**
 * Cache a cover and repaint the one card that changed.
 *
 * Covers arrive one at a time and out of order -- an EPUB's is a zip lookup, a
 * PDF's is a page render -- so redrawing the whole shelf for each would make it
 * flicker for as long as the slowest one took.
 */
export function setCover(bookId: string, dataUrl: string): void {
  covers.set(bookId, dataUrl)

  const art = document.querySelector<HTMLElement>(`.shelf-card[data-book="${CSS.escape(bookId)}"] .shelf-art`)
  if (!art) return

  const existing = art.querySelector('img')
  if (existing) {
    existing.src = dataUrl
    return
  }

  art.classList.remove('is-generated')
  art.querySelector('.shelf-initials')?.remove()
  const image = document.createElement('img')
  image.src = dataUrl
  image.alt = ''
  art.prepend(image)
}

export function hasCover(bookId: string): boolean {
  return covers.has(bookId)
}
