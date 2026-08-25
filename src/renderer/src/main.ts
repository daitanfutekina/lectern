import './styles.css'
import { renderMarkdown } from '@shared/markdown'
import { splitFrontMatter } from '@shared/manifest'
import { readingMinutes } from '@shared/outline'
import { EMPTY_INDEX, findBook, nextChapter, previousChapter } from '@shared/library'
import type { Book, Chapter, LibraryIndex } from '@shared/library'
import { typeset, configureMacros } from './mathjax'

/**
 * The reading surface. SPEC section 10: no Node access, no filesystem, no
 * knowledge of where books live -- it asks for a chapter by name and renders
 * what comes back.
 */

let index: LibraryIndex = EMPTY_INDEX
let current: { bookId: string; file: string } | null = null

const el = <T extends HTMLElement>(id: string): T | null => document.querySelector<T>(`#${id}`)

/** Build DOM, never assign markup from a string. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function renderSidebar(): void {
  const books = el<HTMLElement>('books')
  const meta = el<HTMLElement>('library-meta')
  if (!books) return

  books.replaceChildren()

  if (index.books.length === 0) {
    const empty = element('p', 'book-title', 'No books found')
    books.append(empty)
    const hint = element('p', 'chapter-link')
    hint.style.color = 'var(--text-faint)'
    hint.textContent = `Put a book folder in ${index.root || 'the library root'}\\books`
    books.append(hint)
  }

  for (const book of index.books) {
    books.append(element('div', 'book-title', book.title))
    for (const chapter of book.chapters) {
      const button = element('button', 'chapter-link')
      button.type = 'button'
      button.append(document.createTextNode(chapter.title))

      const detail = element(
        'span',
        'meta',
        `${chapter.words.toLocaleString()} words · ${readingMinutes(chapter.words)} min`
      )
      button.append(detail)

      const isCurrent = current?.bookId === book.id && current.file === chapter.file
      button.setAttribute('aria-current', String(isCurrent))
      button.addEventListener('click', () => void open(book.id, chapter.file))
      books.append(button)
    }
  }

  if (meta) {
    const chapters = index.books.reduce((total, book) => total + book.chapters.length, 0)
    meta.textContent = index.books.length
      ? `${index.books.length} book${index.books.length === 1 ? '' : 's'} · ${chapters} chapters`
      : index.root
  }
}

function renderNav(book: Book | null, chapter: Chapter | null): void {
  const nav = el<HTMLElement>('chapter-nav')
  if (!nav) return
  nav.replaceChildren()
  if (!book || !chapter) return

  const previous = previousChapter(book, chapter.file)
  const next = nextChapter(book, chapter.file)

  const back = element('button', undefined, previous ? `← ${previous.title}` : '← Start of book')
  back.type = 'button'
  back.disabled = previous === null
  if (previous) back.addEventListener('click', () => void open(book.id, previous.file))

  const forward = element('button', undefined, next ? `${next.title} →` : 'End of book →')
  forward.type = 'button'
  forward.disabled = next === null
  if (next) forward.addEventListener('click', () => void open(book.id, next.file))

  nav.append(back, forward)
}

async function open(bookId: string, file: string): Promise<void> {
  const content = el<HTMLElement>('content')
  if (!content) return

  const book = findBook(index, bookId)
  const chapter = book?.chapters.find((c) => c.file === file) ?? null
  if (!book || !chapter) return

  current = { bookId, file }
  renderSidebar()
  renderNav(book, chapter)

  const source = await window.lectern.library.chapter(bookId, file)
  if (source === null) {
    content.replaceChildren(element('p', 'placeholder', 'That chapter could not be read.'))
    return
  }

  const { matter, body } = splitFrontMatter(source)

  // Macros are book-scoped and must be registered before typesetting, or every
  // \Nul and \Col in the chapter renders as an error. FINDINGS: they were
  // defined per-chapter and inconsistently in the source books.
  configureMacros(book.macros)

  const article = element('article')
  if (matter.crumb) article.append(element('p', 'crumb', matter.crumb))
  article.append(element('h1', undefined, matter.title ?? chapter.title))

  const rendered = element('div', 'chapter-body')
  // The only place markup is assigned from a string. The source is the user's
  // own library on their own disk, and the pipeline that produced it is ours.
  rendered.innerHTML = renderMarkdown(body)
  article.append(rendered)

  content.replaceChildren(article)
  content.scrollTop = 0

  await typeset(rendered)
}

async function load(rescan = false): Promise<void> {
  index = rescan ? await window.lectern.library.rescan() : await window.lectern.library.get()
  renderSidebar()
}

async function start(): Promise<void> {
  el<HTMLButtonElement>('rescan')?.addEventListener('click', () => void load(true))

  // Arrow keys move between chapters, but never while the reader is typing into
  // something or has focused a control that uses them itself.
  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    if (!current) return
    const book = findBook(index, current.bookId)
    if (!book) return

    if (event.key === 'ArrowRight' && event.altKey) {
      const next = nextChapter(book, current.file)
      if (next) void open(book.id, next.file)
    }
    if (event.key === 'ArrowLeft' && event.altKey) {
      const previous = previousChapter(book, current.file)
      if (previous) void open(book.id, previous.file)
    }
  })

  await load()

  // Open the first chapter of the first book, so a fresh launch shows a book
  // rather than an instruction to click something.
  const first = index.books[0]
  const chapter = first?.chapters[0]
  if (first && chapter) void open(first.id, chapter.file)
}

void start()
