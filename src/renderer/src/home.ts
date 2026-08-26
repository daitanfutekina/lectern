import { FORMAT_COLOUR, initials, shelfSubtitle, shelfEntry, type ShelfEntry } from '@shared/shelf'
import type { Book, LibraryIndex } from '@shared/library'

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

export function renderHome(
  container: HTMLElement,
  index: LibraryIndex,
  progressOf: (book: Book) => number | null,
  onOpen: OnOpen
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
  header.append(hint)
  container.append(header)

  if (index.books.length === 0) return

  const grid = document.createElement('div')
  grid.className = 'shelf'

  for (const book of index.books) {
    grid.append(card(shelfEntry(book, progressOf(book)), onOpen))
  }
  container.append(grid)
}

function card(entry: ShelfEntry, onOpen: OnOpen): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'shelf-card'
  button.dataset['book'] = entry.id
  button.title = entry.title

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

  button.append(art, title, meta)
  button.addEventListener('click', () => onOpen(entry.id))
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
