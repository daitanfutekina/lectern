import './styles.css'
import { renderMarkdown } from '@shared/markdown'
import { splitFrontMatter } from '@shared/manifest'
import { plainMath, readingMinutes } from '@shared/outline'
import { EMPTY_INDEX, findBook, nextChapter, previousChapter } from '@shared/library'
import { groupChapters, isSubChapter } from '@shared/parts'
import {
  EMPTY_BOOK,
  EMPTY_PROGRESS,
  START,
  fractionAt,
  fractionRead,
  isFinished,
  sidebarProgressKey,
  type Bookmark,
  type LibraryProgress,
  type ReadingPosition
} from '@shared/progress'
import type { Book, Chapter, LibraryIndex } from '@shared/library'
import { typeset, configureMacros } from './mathjax'
import { currentPosition, restorePosition, trackPosition } from './position'
import {
  collectMath,
  extract,
  injectInlineSpeech,
  positionAtPoint,
  withMathSpeech,
  type Utterance
} from './blocks'
import { Reader, onVoicesChanged, voices } from './speech'
import { voiceFolder, voices as neuralVoices } from './neural-voice'
import { renderSettings } from './settings-view'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import { BOOK_VOICE, clampShape, type VoiceShape } from '@shared/voice'
import { cancelScan, pagesToHtml, scanRange, type ScanProgress } from './scan-queue'
import { hasCover, renderHome, setCover } from './home'
import { type ShelfSort } from '@shared/shelf'
import { pageText, pdfCover, renderBook, type PdfView } from './pdf-view'
import { clearResult, locate, showResult } from './find-view'
import { PER_CHAPTER, findMatches, htmlPlain, markdownPlain, queryPattern, type Match } from '@shared/find'
import { renderEpub } from './epub-view'
import { chapterFragment } from './chapter-assets'
import type { VoiceDownloadActions } from './voice-download-view'
import { resolveHref, splitHref } from '@shared/epub'
import type { PrepareProgress } from '@shared/speech-cache'
import { FLAG_LABELS, excerpt, type Flag, type FlagKind } from '@shared/flags'
import { mathUtterance } from '@shared/math-gate'
import {
  pdfChapterAtPage,
  pdfPageCount,
  pdfPageRange,
  pdfPageTarget
} from '@shared/pdf-navigation'

/**
 * The reading surface. SPEC section 10: no Node access, no filesystem, no
 * knowledge of where books live -- it asks for a chapter by name and renders
 * what comes back.
 */

let index: LibraryIndex = EMPTY_INDEX
let progress: LibraryProgress = EMPTY_PROGRESS
let current: { bookId: string; file: string } | null = null

/**
 * Guards the window between asking for a chapter and its position being
 * restored. Scroll events in that gap would record the top of the new chapter
 * over the position we are in the middle of returning to.
 */
let restoring = false

/**
 * The open EPUB's document body, which lives inside the frame and so cannot be
 * found with a selector on this document.
 */
let epubBody: HTMLElement | null = null

/** Flags in the library, and the paragraph currently being flagged. */
let flags: readonly Flag[] = []
let flagging: HTMLElement | null = null

/** Everything the reader can change, loaded once at startup. */
let settings: Settings = DEFAULT_SETTINGS
let neuralVoiceInstalled = false
let refreshNeuralVoices: () => Promise<void> = async () => {
  neuralVoiceInstalled = (await neuralVoices()).length > 0
}

/**
 * How the shelf is ordered, remembered between sessions.
 *
 * Settings is the only store. It was also kept in localStorage, and
 * `applySettings` overwrote that copy with `settings.sort` at every launch --
 * which nothing wrote -- so the choice never survived a restart.
 */
let shelfSort: ShelfSort = DEFAULT_SETTINGS.sort

/** Whether the open chapter's section list is expanded. Remembered like the sort. */
let sectionsOpen: boolean = DEFAULT_SETTINGS.sections

/**
 * How many sections to list before saying how many are left.
 *
 * Most chapters have seven to eleven. Godot's largest has 67, and past a point
 * the list stops being something you scan and becomes something you scroll past
 * to reach the next chapter. Same cap, and the same reason, as the index export.
 */
const SECTION_LIMIT = 40

/** When each added document joined the library, for "recently added". */
const addedTimes = new Map<string, number>()

/**
 * Zoom multiplier for the PDF view, on top of fitting the page to the pane.
 * 1 means "as wide as the window allows".
 */
let pdfZoom = 1

/** The open PDF, its book, and the text layers drawn so far. */
let pdfView: PdfView | null = null
let pdfBookId: string | null = null
const pdfPages = new Map<number, HTMLElement>()

/** One reader for the whole session; chapters are loaded into it. */
const reader = new Reader()
let positionTracker: ReturnType<typeof trackPosition> | null = null

const el = <T extends HTMLElement>(id: string): T | null => document.querySelector<T>(`#${id}`)

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

const bookProgress = (bookId: string) => progress.books[bookId] ?? EMPTY_BOOK

function chapterBody(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.chapter-body')
}

/**
 * The element whose children are the blocks a reading position anchors to.
 *
 * Not the same thing as `chapterBody`, which is one of our own chapters and
 * nothing else. Every format has blocks worth anchoring to -- a PDF's blocks
 * are its pages, an EPUB's are the publisher's paragraphs -- and keying
 * position tracking to `.chapter-body` alone meant a PDF or an EPUB recorded no
 * position at all: the tracker looked for an element those views never create,
 * found nothing, and returned before measuring anything.
 */
function positionBody(): HTMLElement | null {
  return (
    chapterBody() ??
    document.querySelector<HTMLElement>('.pdf-pages') ??
    epubBody
  )
}

function applyRecorded(
  bookId: string,
  file: string,
  updated: NonNullable<ReturnType<typeof window.lectern.progress.recordNow>>,
  refreshSidebar: boolean
): void {
  const stored = bookProgress(bookId)
  progress = {
    ...progress,
    lastBook: bookId,
    books: {
      ...progress.books,
      [bookId]: {
        ...stored,
        lastChapter: file,
        chapters: { ...stored.chapters, [file]: updated }
      }
    }
  }
  if (refreshSidebar && sidebarFingerprint() !== renderedSidebarFingerprint) renderSidebar()
}

/** Hand a coalesced position to the main process and fold the answer back in. */
function record(position: ReadingPosition, blocks: number): void {
  if (!current || restoring) return
  refreshPdfLocation()
  const { bookId, file } = current

  void window.lectern.progress.record(bookId, file, position, blocks).then((updated) => {
    if (updated) applyRecorded(bookId, file, updated, true)
  })
}

function recordNow(position: ReadingPosition, blocks: number): void {
  if (!current || restoring) return
  refreshPdfLocation()
  const { bookId, file } = current
  const updated = window.lectern.progress.recordNow(bookId, file, position, blocks)
  if (updated) applyRecorded(bookId, file, updated, false)
}

/**
 * Record where the reader is right now, rather than waiting for a scroll.
 *
 * Position tracking is driven by the scroll event, which is the right trigger
 * while reading and the wrong one at the moment of leaving: stopping on a page
 * and then closing the window or going back to the shelf produces no scroll at
 * all, so the last thing recorded would be wherever the reader last moved
 * through rather than where they stopped.
 */
function recordHere(): void {
  positionTracker?.flush()
}

/** Keep the PDF page field and the page-derived sidebar state in step with the scroller. */
function refreshPdfLocation(): void {
  if (!pdfView || !pdfBookId) return

  const input = el<HTMLInputElement>('pdf-page')
  if (input && document.activeElement !== input) input.value = String(pdfView.currentPage())

  if (sidebarFingerprint() !== renderedSidebarFingerprint) renderSidebar()
}

/* ── Sidebar ─────────────────────────────────────────────────────────── */

/**
 * Parts the reader has folded away from where they would sit by default.
 *
 * The default is that the part holding the open chapter is expanded and the
 * rest are not, which is what makes grouping worth having: 109 chapters
 * collapse to fourteen rows and the one you are inside stays open. Only the
 * departures from that need remembering, so a reader who never touches a
 * chevron always gets the useful arrangement, including after moving to a
 * chapter in a different part.
 *
 * Session-scoped on purpose. Persisting it would mean a schema for something
 * the default already gets right at every launch.
 */
const partsFolded = new Set<string>()
let renderedSidebarFingerprint = ''

const partIsOpen = (title: string, holdsCurrent: boolean): boolean =>
  partsFolded.has(title) ? !holdsCurrent : holdsCurrent

/** The chapter under the reader, which can differ from the one used to open a whole-book PDF. */
function sidebarChapter(book: Book): Chapter | null {
  const opened = book.chapters.find(
    (chapter) => current?.bookId === book.id && current.file === chapter.file
  ) ?? null
  if (book.format !== 'pdf' || !pdfView || pdfBookId !== book.id) return opened
  return pdfChapterAtPage(book.chapters, pdfView.currentPage()) ?? opened
}

function togglePart(title: string): void {
  if (partsFolded.has(title)) partsFolded.delete(title)
  else partsFolded.add(title)
}

function renderSidebar(): void {
  const books = el<HTMLElement>('books')
  const meta = el<HTMLElement>('library-meta')
  if (!books) return

  /*
    This runs on every scroll-driven position report, and replacing the list
    resets where it is scrolled to. On a seven-chapter book the list fits and
    there is nothing to lose; the Godot book lists 117 and the sidebar jumped
    back to the top on every scroll of the chapter, which reads as the sidebar
    scrolling by itself.
  */
  const scrolled = books.scrollTop

  books.replaceChildren()

  if (!current) {
    const hint = element('p', 'sidebar-hint')
    hint.textContent =
      index.books.length === 0
        ? `Put a book folder in the books folder of ${index.root || 'the library root'}`
        : 'Choose a book from the shelf.'
    books.append(hint)
  }

  /*
    Only the open book's chapters.

    Listing every chapter of every book made the sidebar a second, worse copy of
    the library -- and the shelf is the library now. What belongs beside an open
    book is where the reader is in *it*.
  */
  const shown = current ? index.books.filter((book) => book.id === current?.bookId) : []

  for (const book of shown) {
    books.append(element('div', 'book-title', book.title))
    const stored = bookProgress(book.id)
    const activeChapter = sidebarChapter(book)

    for (const group of groupChapters(book)) {
      if (group.title) {
        const holdsCurrent = group.chapters.some(
          (chapter) => activeChapter?.file === chapter.file
        )
        const open = partIsOpen(group.title, holdsCurrent)

        const toggle = element('button', 'part-toggle')
        toggle.type = 'button'
        toggle.setAttribute('aria-expanded', String(open))
        toggle.append(element('span', 'section-chevron', open ? '▼' : '▶'))
        toggle.append(element('span', 'part-name', group.title))
        toggle.append(element('span', 'part-count', String(group.chapters.length)))
        toggle.addEventListener('click', () => {
          togglePart(group.title as string)
          renderSidebar()
        })
        books.append(toggle)

        if (!open) continue
      }

    for (const chapter of group.chapters) {
      const chapterProgress = stored.chapters[chapter.file] ?? null
      const button = element('button', isSubChapter(book, chapter) ? 'chapter-link sub' : 'chapter-link')
      button.type = 'button'

      const row = element('span', 'chapter-row')
      row.append(element('span', 'chapter-name', chapter.title))
      if (isFinished(chapterProgress)) row.append(element('span', 'chapter-done', '✓'))
      button.append(row)

      button.append(
        element(
          'span',
          'meta',
          `${chapter.words.toLocaleString()} words · ${readingMinutes(chapter.words)} min`
        )
      )

      // A bar rather than a percentage: the useful question is "roughly where am
      // I", and a number invites precision the measurement does not have.
      //
      // Where the reader *is*, not how far they once got. Coverage only grows,
      // so one skim to the bottom left this bar full for good and it stopped
      // saying anything. The `✓` above still answers "have I been through this".
      const fraction = fractionAt(chapterProgress)
      // Drawn whenever the chapter has been opened, including at nought. Gating
      // on the fraction made "opened, sitting at the top" indistinguishable from
      // "never opened" -- which coverage could never be, since it only grows.
      if (chapterProgress) {
        const track = element('span', 'progress-track')
        const fill = element('span', 'progress-fill')
        fill.style.width = `${Math.round(fraction * 100)}%`
        track.append(fill)
        button.append(track)
      }

      const isCurrent = activeChapter?.file === chapter.file
      button.setAttribute('aria-current', String(isCurrent))
      // Addressable, so a verification run can open a specific chapter rather
      // than counting positions in a list that changes as books are added.
      button.dataset['book'] = book.id
      button.dataset['chapter'] = chapter.file
      button.addEventListener('click', () => void open(book.id, chapter.file))
      books.append(button)

      // Only the open chapter's, for the same reason the sidebar lists only the
      // open book's chapters: every chapter's sections at once is a table of
      // contents, and that is a different screen.
      if (isCurrent) appendSections(books, book, chapter)
    }
    }
  }

  // After the list is rebuilt, so there is something to scroll back to.
  books.scrollTop = scrolled

  if (meta) {
    const chapters = index.books.reduce((total, book) => total + book.chapters.length, 0)
    meta.textContent = index.books.length
      ? `${index.books.length} book${index.books.length === 1 ? '' : 's'} · ${chapters} chapters`
      : index.root
  }

  renderBookmarks()
  renderedSidebarFingerprint = sidebarFingerprint()
}

/**
 * The open chapter's sections, listed under it and collapsible.
 *
 * Read from the rendered body rather than from the library index. The sidebar
 * only ever lists the chapter that is on screen, so the DOM is there to be read
 * and it is exact. Going through the index would mean assuming the Nth `##` in
 * the source is the Nth `<h2>` on the page -- true today, and the kind of
 * assumption whose failure is a silent jump to the wrong heading rather than an
 * error.
 *
 * Reading `.chapter-body` also scopes this to our own books without a format
 * check: an EPUB renders inside its own frame and a PDF has no chapter body, so
 * both simply produce no list.
 */
/**
 * A heading's text, with any equation in it reduced to readable characters.
 *
 * A typeset equation is no use to `textContent` twice over: MathJax draws the
 * glyphs as SVG paths, which hold no text at all, and adds an
 * `mjx-assistive-mml` copy for screen readers, which holds too much. Reading the
 * heading raw returned "1.4 Matrix Equation Ax=bbold A bold x equals bold b";
 * deleting the assistive copy returned "1.4 Matrix Equation", silently dropping
 * the equation, which would leave a heading made only of mathematics blank.
 *
 * So neither rendering is read. The source LaTeX is still on the element, put
 * there by `renderMarkdown`, and stripping its formatting commands leaves the
 * characters a person would say: `\mathbf{A}\mathbf{x} = \mathbf{b}` -> `Ax = b`.
 */
function headingLabel(heading: HTMLElement): string {
  const copy = heading.cloneNode(true) as HTMLElement

  for (const math of copy.querySelectorAll<HTMLElement>('[data-latex]')) {
    math.replaceWith(document.createTextNode(plainMath(math.dataset['latex'] ?? '')))
  }
  // Any equation MathJax typeset in place, with no `data-latex` to fall back on.
  for (const assistive of copy.querySelectorAll('mjx-assistive-mml')) assistive.remove()

  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Which section the reader is inside: the last heading to have reached the top
 * of the viewport, or -1 while still above the first one.
 *
 * Measured the same way block offsets are, subtracting the container's own
 * position so the answer is in scroll coordinates rather than screen ones.
 *
 * "Reached the top" is a band rather than a line. A heading carries a wide top
 * margin, so scrolling one to the top of the screen leaves its text some tens
 * of pixels down -- with an exact test, clicking 1.9 in this list scrolled to
 * 1.9 and then highlighted 1.8, because 1.9's heading had not technically
 * crossed. A fifth of the viewport is forgiving enough for that and still tight
 * enough that a heading only counts once it is genuinely at the top of what you
 * are reading.
 */
function sectionAt(headings: readonly HTMLElement[]): number {
  const container = el<HTMLElement>('content')
  if (!container) return -1

  const base = container.getBoundingClientRect().top - container.scrollTop
  const threshold = container.scrollTop + container.clientHeight * 0.2

  let at = -1
  for (let index = 0; index < headings.length; index += 1) {
    const top = (headings[index]?.getBoundingClientRect().top ?? 0) - base
    if (top <= threshold) at = index
    else break
  }
  return at
}

/**
 * The headings that are this chapter's sections.
 *
 * The shallowest level that occurs more than once, rather than `h2` always. A
 * publisher who titles a chapter `<h2>5</h2>` numbers its sections `<h3>`, so
 * reading h2 alone offered one "section" per chapter, named after the chapter
 * number. Our own books are unaffected: their sections are h2 and there are
 * many of them, so the first level tried is still the one used.
 */
function sectionHeadings(body: HTMLElement): HTMLElement[] {
  const h2 = [...body.querySelectorAll<HTMLElement>('h2')]
  if (h2.length > 1) return h2

  const h3 = [...body.querySelectorAll<HTMLElement>('h3')]
  if (h3.length > 1) return h3

  return h2
}

/** One row of the section list: what it says, and how to get there. */
interface SectionEntry {
  readonly label: string
  readonly go: () => void
}

/**
 * The open chapter's sections, and which of them the reader is in.
 *
 * Two sources, because the formats disagree about where sections can be found.
 * Our books and EPUBs render real headings, so the list is read out of the page
 * and each row scrolls to its element. A PDF renders canvas pages with no
 * headings in them at all -- which is why its sections were recorded in the
 * index for months and never once appeared -- so its rows come from the
 * outline, and "which section am I in" is a page comparison.
 */
function sectionEntries(
  book: Book,
  chapter: Chapter
): { items: SectionEntry[]; here: number } | null {
  if (book.format === 'pdf') {
    const sections = chapter.pageSections ?? []
    if (sections.length === 0 || !pdfView || pdfBookId !== book.id) return null

    const view = pdfView
    const page = view.currentPage()
    let here = -1
    for (const [at, section] of sections.entries()) {
      if (section.page <= page) here = at
      else break
    }
    return {
      items: sections.map((section) => ({
        label: section.title,
        go: () => view.goToPage(section.page)
      })),
      here
    }
  }

  /*
    An EPUB renders into a frame and never creates `.chapter-body`, so keying
    this to that class alone meant a downloaded book showed no section list at
    all -- not a short one, none.
  */
  const body = chapterBody() ?? epubBody
  if (!body) return null

  const found = sectionHeadings(body)
  if (found.length === 0) return null

  return {
    // The element itself, not an index or an id: it is already in hand, it
    // cannot go stale while this list is on screen, and the chapter's headings
    // carry no ids to look up.
    items: found.map((heading) => ({
      label: headingLabel(heading),
      go: () => heading.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })),
    here: sectionAt(found)
  }
}

/** Values a scroll can visibly change in the existing sidebar. */
function sidebarFingerprint(): string {
  if (!current) return 'home'

  const book = findBook(index, current.bookId)
  const chapter = book ? sidebarChapter(book) : null
  const stored = chapter ? (bookProgress(current.bookId).chapters[chapter.file] ?? null) : null
  const section =
    sectionsOpen && book && chapter ? (sectionEntries(book, chapter)?.here ?? -1) : -1

  return [current.bookId, chapter?.file ?? current.file, sidebarProgressKey(stored, section)].join(
    '\u0000'
  )
}

function appendSections(into: HTMLElement, book: Book, chapter: Chapter): void {
  const entries = sectionEntries(book, chapter)
  if (!entries) return
  const { items: found, here } = entries

  const toggle = element('button', 'section-toggle')
  toggle.type = 'button'
  toggle.setAttribute('aria-expanded', String(sectionsOpen))
  // The solid triangles, not the small ones: `▾` and `▸` fall back to a glyph
  // barely distinguishable from a full stop at this size.
  toggle.append(element('span', 'section-chevron', sectionsOpen ? '▼' : '▶'))
  toggle.append(
    element('span', undefined, `${found.length} section${found.length === 1 ? '' : 's'}`)
  )
  toggle.addEventListener('click', () => {
    sectionsOpen = !sectionsOpen
    // Not through `changeSettings`: that re-applies the voice and restarts
    // speech preparation, and folding a list away needs neither.
    void window.lectern.settings.set({ sections: sectionsOpen }).then((updated) => {
      settings = updated
    })
    renderSidebar()
  })
  into.append(toggle)

  if (!sectionsOpen) return

  const list = element('div', 'section-list')
  for (const [at, entry] of found.slice(0, SECTION_LIMIT).entries()) {
    const link = element('button', 'section-link', entry.label)
    link.type = 'button'
    link.setAttribute('aria-current', String(at === here))
    link.addEventListener('click', entry.go)
    list.append(link)
  }
  if (found.length > SECTION_LIMIT) {
    list.append(element('span', 'section-more', `…${found.length - SECTION_LIMIT} more`))
  }
  into.append(list)
}

function renderBookmarks(): void {
  const panel = el<HTMLElement>('bookmarks')
  if (!panel) return
  panel.replaceChildren()
  if (!current) return

  const book = findBook(index, current.bookId)
  const marks = bookProgress(current.bookId).bookmarks
  if (!book || marks.length === 0) return

  panel.append(element('div', 'book-title', 'Bookmarks'))

  for (const mark of marks) {
    const row = element('div', 'bookmark')

    const jump = element('button', 'bookmark-jump')
    jump.type = 'button'
    jump.append(element('span', 'bookmark-label', mark.label))
    const chapter = book.chapters.find((c) => c.file === mark.chapter)
    jump.append(element('span', 'meta', chapter?.title ?? mark.chapter))
    jump.addEventListener('click', () => void open(book.id, mark.chapter, mark.position))

    const remove = element('button', 'bookmark-remove', '×')
    remove.type = 'button'
    remove.title = 'Remove bookmark'
    remove.addEventListener('click', () => void dropBookmark(book.id, mark.id))

    row.append(jump, remove)
    panel.append(row)
  }
}

/* ── Chapter navigation ──────────────────────────────────────────────── */

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

  const mark = element('button', 'nav-bookmark', '☆ Bookmark')
  mark.type = 'button'
  mark.title = 'Bookmark this spot'
  mark.addEventListener('click', () => void addBookmarkHere())

  let pageControl: HTMLFormElement | null = null
  if (book.format === 'pdf') {
    const pages = pdfPageCount(book.chapters)
    const range = pdfPageRange(chapter.file)
    const shownPage =
      pdfView && pdfBookId === book.id ? pdfView.currentPage() : (range?.from ?? 1)

    pageControl = element('form', 'pdf-page-control')
    pageControl.setAttribute('aria-label', 'Go to PDF page')

    const label = element('label', undefined, 'Page')
    label.htmlFor = 'pdf-page'

    const input = element('input')
    input.id = 'pdf-page'
    input.type = 'number'
    input.min = '1'
    input.max = String(pages)
    input.step = '1'
    input.value = String(shownPage)
    input.setAttribute('aria-label', `Page, ${pages} pages total`)

    const total = element('span', undefined, `of ${pages}`)
    const go = element('button', undefined, 'Go')
    go.type = 'submit'

    pageControl.append(label, input, total, go)
    pageControl.addEventListener('submit', (event) => {
      event.preventDefault()
      const page = pdfPageTarget(input.value, pages)
      if (page === null) {
        input.value = String(pdfView?.currentPage() ?? shownPage)
        return
      }
      input.value = String(page)
      pdfView?.goToPage(page)
    })
  }

  const forward = element('button', undefined, next ? `${next.title} →` : 'End of book →')
  forward.type = 'button'
  forward.disabled = next === null
  if (next) forward.addEventListener('click', () => void open(book.id, next.file))

  nav.append(back, mark)
  if (pageControl) nav.append(pageControl)
  nav.append(forward)
}

/* ── Bookmarks ───────────────────────────────────────────────────────── */

async function addBookmarkHere(): Promise<void> {
  const container = el<HTMLElement>('content')
  const body = chapterBody()
  if (!current || !container || !body) return

  const book = findBook(index, current.bookId)
  const chapter = book?.chapters.find((c) => c.file === current?.file)
  const position = currentPosition(container, body)

  // The label is the nearest heading above the reader rather than a prompt.
  // A dialog for every bookmark is friction on the one action that has to be
  // cheap enough to use without thinking.
  const label = headingAbove(body, position) ?? chapter?.title ?? 'Bookmark'

  const updated = await window.lectern.bookmarks.add(current.bookId, current.file, position, label)
  if (updated) applyBookmarks(current.bookId, updated)
}

async function dropBookmark(bookId: string, id: string): Promise<void> {
  const updated = await window.lectern.bookmarks.remove(bookId, id)
  if (updated) applyBookmarks(bookId, updated)
}

function applyBookmarks(bookId: string, bookmarks: readonly Bookmark[]): void {
  progress = {
    ...progress,
    books: { ...progress.books, [bookId]: { ...bookProgress(bookId), bookmarks } }
  }
  renderBookmarks()
}

/** The most recent heading at or above a position, for naming a bookmark. */
function headingAbove(body: HTMLElement, position: ReadingPosition): string | null {
  const children = Array.from(body.children)
  for (let index = Math.min(position.block, children.length - 1); index >= 0; index -= 1) {
    const node = children[index]
    if (node instanceof HTMLElement && /^H[1-4]$/.test(node.tagName)) {
      return node.textContent?.trim() || null
    }
  }
  return null
}

/* ── Reading ─────────────────────────────────────────────────────────── */

async function open(bookId: string, file: string, at?: ReadingPosition): Promise<void> {
  // Flush before `current` changes, while the old chapter's geometry and id
  // still agree. The synchronous bridge makes an immediate quit safe too.
  recordHere()
  // Two chapters recognising at once would fight over one CPU and both crawl.
  cancelScan()
  if (pdfBookId !== bookId) {
    pdfView?.destroy()
    pdfView = null
    pdfBookId = null
    pdfPages.clear()
  }
  const container = el<HTMLElement>('content')
  if (!container) return

  const book = findBook(index, bookId)
  const chapter = book?.chapters.find((c) => c.file === file) ?? null
  if (!book || !chapter) return

  restoring = true
  // Results listed for one book mean nothing in another.
  if (findBookId !== null && findBookId !== bookId) {
    closeFind()
    resetFind()
    findBookId = null
  }
  // The previous chapter's frame is about to be replaced, and a stale body
  // would have position tracking measuring a document that is no longer shown.
  epubBody = null
  document.body.classList.remove('is-home')
  current = { bookId, file }
  renderSidebar()
  renderNav(book, chapter)

  const source = await window.lectern.library.chapter(bookId, file)
  if (source === null) {
    container.replaceChildren(element('p', 'placeholder', 'That chapter could not be read.'))
    restoring = false
    return
  }

  // A PDF is shown as a PDF and an EPUB keeps its own typography. Only our own
  // books go through the Markdown pipeline and wear the application's design.
  if (book.format === 'pdf') {
    await openPdfChapter(container, book, chapter, at)
    restoring = false
    return
  }
  if (book.format === 'epub') {
    await openEpubChapter(container, book, chapter, source, at)
    restoring = false
    return
  }

  const isMarkdown = book.format === 'markdown'
  const { matter, body } = isMarkdown
    ? splitFrontMatter(source)
    : { matter: { title: null, crumb: null }, body: source }

  // Macros are book-scoped and must be registered before typesetting, or every
  // \Nul and \Col in the chapter renders as an error.
  configureMacros(book.macros)

  const article = element('article')
  if (matter.crumb) article.append(element('p', 'crumb', matter.crumb))
  article.append(element('h1', undefined, matter.title ?? chapter.title))

  const rendered = element('div', 'chapter-body')
  // The only place markup is assigned from a string. The source is the user's
  // own library on their own disk, and the pipeline that produced it is ours.
  rendered.append(chapterFragment(isMarkdown ? renderMarkdown(body) : body, book.id, file))
  article.append(rendered)

  container.replaceChildren(article)
  container.scrollTop = 0

  // Typeset before restoring: equations change block heights substantially, and
  // restoring against pre-typeset geometry lands in the wrong place.
  await typeset(rendered)

  // Again, now the body exists and its equations are typeset. The first call ran
  // before the chapter was fetched, so it had no headings to list, and running
  // before typesetting would read `\(\mathbf{A}\mathbf{x}\)` out of a heading
  // rather than the equation.
  renderSidebar()

  const stored = bookProgress(bookId).chapters[file]
  const target = at ?? stored?.position ?? START
  restorePosition(container, rendered, target)

  // Speech is loaded from the rendered chapter, and starts where the reader is
  // rather than at the top -- opening a chapter mid-way and pressing play
  // should continue, not restart the chapter.
  const utterances = extract(rendered)
  const blockAt = Math.min(target.block, rendered.children.length - 1)
  const nearest = rendered.children[Math.max(0, blockAt)]
  reader.load(utterances, nearest instanceof HTMLElement ? reader.indexNear(nearest) : 0)
  startPreparing()

  // Equations are converted after the queue exists and after the chapter is on
  // screen. It is a slow batch, and making the reader wait for it would trade
  // a feature they may not use for a delay they certainly notice.
  // Both, and both matter: the panel lists this book's flags, and the marks
  // show which paragraphs on screen carry one.
  renderFlags()
  markFlagged()
  void fillMathSpeech(book, utterances, rendered)

  // A scan has no text yet. Recognition runs in the background and rebuilds the
  // chapter as pages land, so reading is never waiting on it (invariant 7).
  const marker = rendered.querySelector<HTMLElement>('[data-scan]')
  if (marker) startScan(bookId, marker, rendered)

  void window.lectern.progress.open(bookId, file)
  restoring = false
}

/**
 * Generate speech for the chapter's equations and reload the queue with them.
 *
 * The whole chapter goes over in one call. Hundreds of equations at one round
 * trip each would be hundreds of round trips, and the conversion caches on the
 * other side so a chapter revisited costs nothing.
 */
async function fillMathSpeech(
  book: Book,
  utterances: Utterance[],
  body: HTMLElement
): Promise<void> {
  const equations = collectMath(body)
  if (equations.length === 0) return

  await window.lectern.math.configure(book.macros)
  const spoken = await window.lectern.math.speak(
    equations.map((item) => ({ latex: item.latex, display: item.display }))
  )

  // The chapter may have been closed while the batch was in flight.
  if (!document.contains(body)) return

  // Inline equations go into the paragraph as hidden text so the prose walk
  // reads them in place; display equations stay as utterances of their own.
  const displaySpeech = new Map<HTMLElement, string | null>()
  const tally = { spoken: 0, deferred: 0, silent: 0 }

  equations.forEach((item, at) => {
    const raw = spoken[at] ?? null
    const said = mathUtterance(item.latex, raw, item.display)
    if (said === null) tally.silent += 1
    else if (said === raw) tally.spoken += 1
    else tally.deferred += 1

    if (item.display) displaySpeech.set(item.element, said)
    else injectInlineSpeech(item.element, said)
  })

  console.info(
    `math: ${equations.length} equations, ${tally.spoken} spoken, ` +
      `${tally.deferred} deferred to the screen, ${tally.silent} silent`
  )

  // Re-extracted rather than patched: the paragraphs now contain text they did
  // not before, so their sentences, offsets and word-follow map all change.
  const resumeAt = reader.state.index
  const wasPlaying = reader.state.playing
  const rebuilt = withMathSpeech(extract(body), displaySpeech)
  reader.load(rebuilt, Math.min(resumeAt, Math.max(0, rebuilt.length - 1)))
  if (wasPlaying) reader.play()
  // The equations are words now, so what has to be prepared has changed.
  startPreparing()
}

/**
 * A PDF chapter: the real pages, with a text layer over them.
 *
 * Speech comes from the text the adapter extracted, and the pages come from
 * pdf.js. Display and reading are separate concerns here in a way they are not
 * for our own books, where the two are the same document.
 */
async function openPdfChapter(
  container: HTMLElement,
  book: Book,
  chapter: Chapter,
  at?: ReadingPosition
): Promise<void> {
  const range = /^p(\d+)-(\d+)$/.exec(chapter.file)
  const target = range ? Number(range[1]) : 1

  // The whole document is one scroller, so opening a second "chapter" of a PDF
  // already open is a jump rather than a reload -- which is the difference
  // between a book and a stack of separate files.
  if (pdfView && pdfBookId === book.id && container.querySelector('.pdf-pages')) {
    pdfView.goToPage(target)
    return
  }

  pdfView?.destroy()
  pdfView = null
  pdfPages.clear()

  const pages = element('div', 'pdf-pages')
  container.replaceChildren(pages)
  container.scrollTop = 0

  pdfBookId = book.id
  pdfView = await renderBook(pages, container, book.id, pdfZoom, (page, textLayer) => {
    // Speech grows with the document. A virtualised viewer has drawn only a
    // handful of pages at any moment, so a queue built once would stop at
    // whichever page happened to be on screen when it was built.
    pdfPages.set(page, textLayer)
    rebuildPdfQueue()
  })

  if (!pdfView) return

  /*
    Where the reader was, in preference to where the chapter starts.

    Every page has a correctly-sized placeholder by now, so the page wrappers
    are already in their final positions and anchoring works before a single
    page has been drawn -- scrolling to the stored position is what then tells
    the virtualiser which pages to draw.
  */
  const stored = at ?? bookProgress(book.id).chapters[chapter.file]?.position
  if (stored && (stored.block > 0 || stored.within > 0)) {
    restorePosition(container, pages, stored)
  } else if (target > 1) {
    pdfView.goToPage(target)
  }

  // The sidebar was drawn before the view existed, and a PDF's section list
  // needs the view to know which page is showing. Without this it appeared
  // only after the reader first scrolled, and never for a chapter opened at
  // its first page and read without moving.
  refreshPdfLocation()
  renderSidebar()
}

/**
 * Rebuild the speech queue from the pages currently drawn, in page order.
 *
 * Debounced: pages arrive in bursts as the reader scrolls, and rebuilding for
 * each one would reset the reader's position several times a second.
 */
let pdfQueueTimer: ReturnType<typeof setTimeout> | null = null

function rebuildPdfQueue(): void {
  if (pdfQueueTimer) clearTimeout(pdfQueueTimer)
  pdfQueueTimer = setTimeout(() => {
    pdfQueueTimer = null
    const ordered = [...pdfPages.entries()].sort((a, b) => a[0] - b[0])
    // The page wrapper, not the text layer: `extract` walks an element's
    // children, so handing it the layer itself skipped the very check that
    // recognises a layer and produced nothing at all.
    const utterances = ordered.flatMap(([, layer]) => extract(layer.parentElement ?? layer))
    const at = Math.min(reader.state.index, Math.max(0, utterances.length - 1))
    reader.load(utterances, at)
    startPreparing()
  }, 300)
}

/** An EPUB chapter, rendered in its own frame with its own styling. */
async function openEpubChapter(
  container: HTMLElement,
  book: Book,
  chapter: Chapter,
  html: string,
  at?: ReadingPosition
): Promise<void> {
  const host = element('div', 'epub-host')
  container.replaceChildren(host)
  container.scrollTop = 0

  const rendered = await renderEpub(
    host,
    html,
    settings.theme,
    (href) => followEpubLink(book, chapter, href),
    (block) => {
      reader.jumpTo(reader.indexNear(block))
      reader.play()
    }
  )
  if (!rendered) {
    console.warn('epub: frame did not render')
    return
  }

  epubBody = rendered.body

  /*
    A link's destination outranks the stored position.

    Following a cross-reference and landing where you last stopped reading is
    the one thing a link must not do.
  */
  const jump = epubFragment
  epubFragment = null

  const stored = at ?? bookProgress(book.id).chapters[chapter.file]?.position ?? START
  if (jump) scrollToFragment(jump)
  else restorePosition(container, rendered.body, stored)

  /*
    And again once the book has finished arriving.

    The frame is sized to its content at parse time, but images and web fonts
    land afterwards and move every paragraph below them, so the first restore
    anchors against geometry that is about to change underneath it.

    The guard is the scroll offset rather than a scroll listener. Setting
    `scrollTop` fires a scroll event of its own, which a listener attached here
    cannot tell apart from the reader's -- so the first version of this cancelled
    itself every time and left the position visibly short. Content settling moves
    the paragraphs but not the viewport, so an offset that has not changed means
    the reader has not moved.
  */
  const placed = container.scrollTop
  setTimeout(() => {
    if (Math.abs(container.scrollTop - placed) > 2) return
    // A link jump is settled by the same content landing, so re-running it is
    // the right correction there too.
    if (jump) scrollToFragment(jump)
    else restorePosition(container, rendered.body, stored)
  }, 1400)

  // The frame is same-origin, so the speech walk reaches straight into it and
  // every downstream feature works unchanged.
  const utterances = extract(rendered.body)
  const blockAt = Math.min(stored.block, rendered.body.children.length - 1)
  // Node type, not `instanceof`: the frame is its own realm (see `blockTops`).
  const nearest = rendered.body.children[Math.max(0, blockAt)]
  reader.load(utterances, nearest ? reader.indexNear(nearest as HTMLElement) : 0)
  startPreparing()
  renderFlags()
}

/**
 * A link clicked inside an EPUB.
 *
 * Three kinds, and the book does not distinguish them: a jump within this
 * document, a jump to another document in the same book, and a link out to the
 * web. The first two are the book's own contents page and its cross-references,
 * which are the whole reason a reader opens a table of contents at all.
 */
function followEpubLink(book: Book, chapter: Chapter, href: string): void {
  if (/^(https?|mailto):/i.test(href)) {
    // Denied by the window-open handler in main, which opens it in the real
    // browser instead. Nothing navigates the reader away from the book.
    window.open(href, '_blank')
    return
  }

  const { path, fragment } = splitHref(href)

  // A bare `#id` names a place in the document already open.
  if (!path) {
    if (fragment) scrollToFragment(fragment)
    return
  }

  // Hrefs inside a book are relative to the document holding them.
  const target = resolveHref(chapter.file, path)
  const found = book.chapters.find((entry) => entry.file === target)
  if (!found) return

  if (found.file === chapter.file) {
    if (fragment) scrollToFragment(fragment)
    return
  }

  epubFragment = fragment
  void open(book.id, found.file)
}

/**
 * Where to land after the next EPUB chapter renders.
 *
 * A link carries its fragment across a chapter change, but the document it
 * names does not exist until the frame has parsed it, so the target is held
 * here rather than resolved at click time.
 */
let epubFragment: string | null = null

function scrollToFragment(fragment: string): void {
  const found = epubBody?.ownerDocument.getElementById(fragment)
  found?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

/* ── Find in this book ──────────────────────────────────────────────── */

/*
  Each chapter's searchable text, kept for the session.

  The second search of a book is instant, which matters most for a PDF: its
  first search reads every page. Kept in memory rather than on disk because a
  Markdown book is re-read in milliseconds and a PDF's text is already cached by
  the document itself; persisting would buy a faster first search after a
  restart at the price of a cache that has to be invalidated when a book is
  edited, and these books are edited.
*/
const chapterTexts = new Map<string, Map<string, string>>()
const pageTexts = new Map<string, Map<number, string>>()

/** Bumped by every search and by closing the bar, so one overtaken by the next stops. */
let findRun = 0

/*
  A jump in progress, which the search makes way for.

  A PDF's search and its drawing share one pdf.js worker, and a first search is
  hundreds of text extractions long. Clicking a result while that runs put the
  page the reader asked for behind all of them: it drew seconds late, and the
  jump gave up waiting for its text before it arrived. The search now pauses
  while a jump is landing, and carries on after.
*/
let jumpToken = 0
let jumpPending = false
let findTimer: ReturnType<typeof setTimeout> | null = null
let findBookId: string | null = null

interface FindHit {
  readonly chapter: Chapter
  readonly match: Match
  /** The page a PDF result is on. Null for every other format. */
  readonly page: number | null
}

function openFind(): void {
  const bar = el<HTMLElement>('find-bar')
  const input = el<HTMLInputElement>('find-input')
  if (!bar || !input || !current) return

  if (findBookId !== current.bookId) resetFind()
  findBookId = current.bookId
  bar.hidden = false

  // A selection is almost always the thing the reader meant to look for.
  const selected = window.getSelection()?.toString().trim() ?? ''
  if (selected && selected.length <= 80 && !selected.includes('\n')) input.value = selected

  input.focus()
  input.select()
  if (input.value.trim()) scheduleFind(0)
}

function closeFind(): void {
  findRun += 1
  // A jump still waiting for its page is abandoned with the bar.
  jumpToken += 1
  jumpPending = false
  if (findTimer) clearTimeout(findTimer)
  findTimer = null
  const bar = el<HTMLElement>('find-bar')
  if (bar) bar.hidden = true
  clearResult()
}

/** Forget the last search's results, which belonged to whichever book was open. */
function resetFind(): void {
  findRun += 1
  el<HTMLElement>('find-results')?.replaceChildren()
  const status = el<HTMLElement>('find-status')
  if (status) status.textContent = ''
  clearResult()
}

function scheduleFind(delay = 350): void {
  if (findTimer) clearTimeout(findTimer)
  findTimer = setTimeout(() => {
    findTimer = null
    void runFind()
  }, delay)
}

async function chapterSearchText(book: Book, chapter: Chapter): Promise<string> {
  let cache = chapterTexts.get(book.id)
  if (!cache) {
    cache = new Map()
    chapterTexts.set(book.id, cache)
  }
  const cached = cache.get(chapter.file)
  if (cached !== undefined) return cached

  const source = await window.lectern.library.chapter(book.id, chapter.file)
  const text =
    source === null ? '' : book.format === 'markdown' ? markdownPlain(source) : htmlPlain(source)
  cache.set(chapter.file, text)
  return text
}

async function pageSearchText(book: Book, page: number): Promise<string> {
  let cache = pageTexts.get(book.id)
  if (!cache) {
    cache = new Map()
    pageTexts.set(book.id, cache)
  }
  const cached = cache.get(page)
  if (cached !== undefined) return cached
  const text = await pageText(book.id, page)
  cache.set(page, text)
  return text
}

async function runFind(): Promise<void> {
  const input = el<HTMLInputElement>('find-input')
  const status = el<HTMLElement>('find-status')
  const results = el<HTMLElement>('find-results')
  const book = current ? findBook(index, current.bookId) : null
  if (!input || !status || !results || !book) return

  const run = ++findRun
  results.replaceChildren()
  clearResult()

  const pattern = queryPattern(input.value)
  if (!pattern) {
    status.textContent = input.value.trim() ? 'Type at least two characters.' : ''
    return
  }
  // Invariant 5. A scan's text exists only as recognition output, which feeds
  // speech and nothing else -- said plainly, so an empty result is not read as
  // the book not containing the word.
  if (book.format === 'pdf' && book.scanned) {
    status.textContent = 'This book is a scan, so there is no text to search.'
    return
  }

  let found = 0
  let chaptersWithHits = 0
  const totalPages = book.chapters.reduce((sum, chapter) => {
    const range = /^p(\d+)-(\d+)$/.exec(chapter.file)
    return range ? Math.max(sum, Number(range[2])) : sum
  }, 0)

  for (const [at, chapter] of book.chapters.entries()) {
    if (run !== findRun) return
    const hits: FindHit[] = []
    let total = 0

    if (book.format === 'pdf') {
      const range = /^p(\d+)-(\d+)$/.exec(chapter.file)
      if (!range) continue
      for (let page = Number(range[1]); page <= Number(range[2]); page += 1) {
        while (jumpPending && run === findRun) await new Promise((resolve) => setTimeout(resolve, 50))
        if (run !== findRun) return
        // Every tenth page: often enough to show it moving, rarely enough that
        // repainting the status is not what the search spends its time on.
        if (page % 10 === 1) {
          status.textContent = `Searching page ${page} of ${totalPages}${found ? ` · ${found} found` : ''}`
        }
        const text = await pageSearchText(book, page)
        const { matches, total: onPage } = findMatches(text, pattern, PER_CHAPTER - hits.length)
        for (const match of matches) hits.push({ chapter, match, page })
        total += onPage
      }
    } else {
      status.textContent = `Searching chapter ${at + 1} of ${book.chapters.length}${found ? ` · ${found} found` : ''}`
      const { matches, total: inChapter } = findMatches(await chapterSearchText(book, chapter), pattern)
      for (const match of matches) hits.push({ chapter, match, page: null })
      total = inChapter
    }

    if (run !== findRun) return
    if (total === 0) continue
    found += total
    chaptersWithHits += 1
    appendFindGroup(results, book, hits, total - hits.length, pattern)
  }

  status.textContent =
    found === 0
      ? 'Not found in this book.'
      : `${found} match${found === 1 ? '' : 'es'} in ${chaptersWithHits} chapter${chaptersWithHits === 1 ? '' : 's'}`
}

function appendFindGroup(
  into: HTMLElement,
  book: Book,
  hits: readonly FindHit[],
  more: number,
  pattern: RegExp
): void {
  const first = hits[0]
  if (!first) return
  into.append(element('div', 'find-chapter', first.chapter.title))

  for (const hit of hits) {
    const row = element('button', 'find-result')
    row.type = 'button'
    // Built from text nodes, never markup: a snippet is book text, and a
    // chapter containing `<img onerror>` in its prose is still just prose here.
    row.append(document.createTextNode(hit.match.before))
    row.append(element('mark', undefined, hit.match.match))
    row.append(document.createTextNode(hit.match.after))
    if (hit.page !== null) row.append(element('span', 'find-page', `p. ${hit.page}`))
    row.addEventListener('click', () => void goToFind(book, hit, pattern))
    into.append(row)
  }
  if (more > 0) into.append(element('span', 'find-more', `…and ${more} more in this chapter`))
}

async function goToFind(book: Book, hit: FindHit, pattern: RegExp): Promise<void> {
  if (!current || current.bookId !== book.id) return

  if (book.format === 'pdf' && hit.page !== null) {
    const token = ++jumpToken
    jumpPending = true
    try {
      if (current.file !== hit.chapter.file) await open(book.id, hit.chapter.file)
      pdfView?.goToPage(hit.page, true)
      void pdfView?.drawPage(hit.page)
      /*
        A page gets its text layer only once it is drawn, which happens as it
        scrolls into view -- and a page drawn earlier may since have been
        released by the virtualiser, leaving a layer in the map that is no longer
        on screen. So this waits for a layer that is actually attached, for as
        long as this is still the jump the reader wants.
      */
      for (let tries = 0; tries < 150 && token === jumpToken; tries += 1) {
        const layer = pdfPages.get(hit.page)
        if (layer?.isConnected) {
          const range = locate(layer, pattern, hit.match.occurrence)
          if (range) showResult(range)
          foldFindResults()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } finally {
      if (token === jumpToken) jumpPending = false
    }
    return
  }

  if (current.file !== hit.chapter.file) await open(book.id, hit.chapter.file)
  const body = chapterBody() ?? epubBody
  if (!body) return
  const range = locate(body, pattern, hit.match.occurrence)
  if (range) showResult(range)
  foldFindResults()
}

/**
 * Fold the list away after a jump, leaving the search box.
 *
 * The bar sits over the right of the page, and the passage just jumped to was
 * landing underneath it -- the word found, hidden by the list that found it.
 * Clicking back into the box brings the list back.
 */
function foldFindResults(): void {
  el<HTMLElement>('find-bar')?.classList.add('is-folded')
}

function setUpFind(): void {
  const input = el<HTMLInputElement>('find-input')
  const unfold = (): void => el<HTMLElement>('find-bar')?.classList.remove('is-folded')
  input?.addEventListener('focus', unfold)
  input?.addEventListener('click', unfold)
  input?.addEventListener('input', () => {
    unfold()
    scheduleFind()
  })
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      scheduleFind(0)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeFind()
    }
  })
  el<HTMLButtonElement>('find-close')?.addEventListener('click', closeFind)
}

/* ── Flagging a passage ──────────────────────────────────────────────── */

/**
 * The nearest heading above a paragraph.
 *
 * Context for a passage whose text alone is ambiguous -- and in a textbook,
 * "This follows from the previous result" appears on many pages.
 */
function headingFor(element: HTMLElement): string | null {
  let node: Element | null = element
  while (node) {
    if (/^H[1-6]$/.test(node.tagName) || node.classList.contains('box-label')) {
      return node.textContent?.trim() ?? null
    }
    node = node.previousElementSibling ?? node.parentElement
    if (node?.classList.contains('chapter-body')) break
  }
  return null
}

function openFlagBar(paragraph: HTMLElement): void {
  flagging?.classList.remove('is-flagging')
  flagging = paragraph
  paragraph.classList.add('is-flagging')

  el<HTMLElement>('flag-bar')?.classList.add('is-open')
  const target = el<HTMLElement>('flag-target')
  if (target) target.textContent = excerpt(paragraph.textContent ?? '', 90)
  const note = el<HTMLInputElement>('flag-note')
  if (note) note.value = ''
}

function closeFlagBar(): void {
  flagging?.classList.remove('is-flagging')
  flagging = null
  el<HTMLElement>('flag-bar')?.classList.remove('is-open')
}

async function recordFlag(kind: FlagKind): Promise<void> {
  const paragraph = flagging
  if (!paragraph || !current) return

  const body = chapterBody()
  const blocks = body ? Array.from(body.children) : []

  const store = await window.lectern.flags.add({
    book: current.bookId,
    chapter: current.file,
    kind,
    // The passage itself, because a block index breaks the moment the chapter
    // is edited -- and the edit is what the flag was asking for.
    text: paragraph.textContent ?? '',
    heading: headingFor(paragraph),
    block: Math.max(0, blocks.indexOf(paragraph.closest('.chapter-body > *') ?? paragraph)),
    note: el<HTMLInputElement>('flag-note')?.value ?? ''
  })

  flags = store.flags
  paragraph.classList.add('is-flagged')
  closeFlagBar()
  renderFlags()
}

function renderFlags(): void {
  const panel = el<HTMLElement>('flags')
  if (!panel) return
  panel.replaceChildren()

  const mine = flags.filter((flag) => flag.book === current?.bookId)
  if (mine.length === 0) return

  panel.append(element('div', 'book-title', `Flagged (${mine.length})`))

  for (const flag of [...mine].sort((a, b) => b.createdAt - a.createdAt)) {
    const row = element('div', 'flag')

    const jump = element('button', 'flag-jump')
    jump.type = 'button'
    jump.append(element('span', `flag-kind kind-${flag.kind}`, FLAG_LABELS[flag.kind]))
    jump.append(element('span', 'flag-text', excerpt(flag.text, 70)))
    jump.addEventListener('click', () => void open(flag.book, flag.chapter))

    const remove = element('button', 'flag-remove', '×')
    remove.type = 'button'
    remove.title = 'Remove flag'
    remove.addEventListener('click', () => {
      void window.lectern.flags.remove(flag.id).then((store) => {
        flags = store.flags
        renderFlags()
        markFlagged()
      })
    })

    row.append(jump, remove)
    panel.append(row)
  }
}

/** Mark paragraphs that already carry a flag, so a reread shows what was said. */
function markFlagged(): void {
  const body = chapterBody()
  if (!body || !current) return

  const texts = new Set(
    flags
      .filter((flag) => flag.book === current?.bookId && flag.chapter === current?.file)
      .map((flag) => flag.text.replace(/\s+/g, ' ').trim())
  )

  for (const paragraph of Array.from(body.querySelectorAll<HTMLElement>('p, li'))) {
    const text = (paragraph.textContent ?? '').replace(/\s+/g, ' ').trim()
    paragraph.classList.toggle('is-flagged', texts.has(text))
  }
}

function setUpFlagging(): void {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-flag]'))) {
    button.addEventListener('click', () => void recordFlag(button.dataset['flag'] as FlagKind))
  }
  el<HTMLButtonElement>('flag-cancel')?.addEventListener('click', closeFlagBar)

  // Right-click a paragraph to flag it. The passage is flagged where it is
  // read: asking the reader to remember it, find a form and describe it is
  // enough friction that the signal never gets recorded at all.
  el<HTMLElement>('content')?.addEventListener('contextmenu', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const paragraph = target.closest<HTMLElement>('.chapter-body p, .chapter-body li')
    if (!paragraph) return
    // Furniture is not content. A page marker is excluded from speech for the
    // same reason it is excluded here: there is nothing in it to be confused by.
    if (paragraph.dataset['speak'] === 'no' || paragraph.classList.contains('notice')) return
    event.preventDefault()
    openFlagBar(paragraph)
  })
}

/* ── Preparing a character voice ─────────────────────────────────────── */

/**
 * Start preparing the open chapter, if a character voice is chosen.
 *
 * The sentence list comes from the reader's own queue rather than from the
 * document: the queue is what will actually be spoken, equations included, and
 * preparing anything else would prepare sentences that are never played and
 * miss the ones that are.
 */
function startPreparing(): void {
  const bar = el<HTMLElement>('prepare-progress')

  if (!settings.character || !settings.neural || !settings.voiceId || !current) {
    void window.lectern.voice.cancelPrepare()
    if (bar) bar.hidden = true
    return
  }

  const sentences = reader.texts()
  if (sentences.length === 0) return

  void window.lectern.voice.prepare(
    current.bookId,
    current.file,
    sentences,
    settings.voiceId,
    settings.shape,
    settings.rate,
    settings.character,
    settings.characterPitch,
    settings.characterIndex,
    settings.characterProtect
  )
}

function renderPrepareProgress(progress: PrepareProgress): void {
  const bar = el<HTMLElement>('prepare-progress')
  if (!bar) return

  // Only for the chapter on screen. A job that was cancelled mid-sentence can
  // still deliver one last report for the chapter the reader has just left.
  if (!current || progress.bookId !== current.bookId || progress.file !== current.file) return

  bar.hidden = !progress.running && progress.done >= progress.total
  const failed = progress.failed > 0 ? `, ${progress.failed} unreadable` : ''
  bar.textContent = progress.running
    ? `Preparing the voice: ${progress.done} of ${progress.total} sentences${failed}`
    : `Voice ready: ${progress.total} sentences${failed}`

  // The finished message is worth a moment and then it is clutter.
  if (!progress.running) setTimeout(() => (bar.hidden = true), 4000)
}

/* ── Scanned pages ───────────────────────────────────────────────────── */

function renderScanProgress(progress: ScanProgress): void {
  const bar = el<HTMLElement>('scan-progress')
  if (!bar) return

  if (!progress.running && progress.done === 0) {
    bar.textContent = 'This scan could not be read.'
    bar.hidden = false
    return
  }

  bar.hidden = !progress.running && progress.done >= progress.total
  const failed = progress.failed > 0 ? `, ${progress.failed} unreadable` : ''
  bar.textContent = progress.running
    ? `Reading the scan: ${progress.done} of ${progress.total} pages${failed}`
    : `Scan read: ${progress.done} of ${progress.total} pages${failed}`
}

function startScan(bookId: string, marker: HTMLElement, body: HTMLElement): void {
  const [from, to] = (marker.dataset['scan'] ?? '').split('-').map(Number)
  if (!Number.isInteger(from) || !Number.isInteger(to)) return

  void scanRange(
    bookId,
    from as number,
    to as number,
    (pages) => {
      if (!document.contains(body)) return
      const html = pagesToHtml(pages)
      if (!html) return

      // Rebuilt from scratch each time rather than appended to: furniture
      // removal counts what repeats across the whole range, so one more page
      // can change what is furniture on the pages before it.
      body.innerHTML = html
      const utterances = extract(body)
      const at = Math.min(reader.state.index, Math.max(0, utterances.length - 1))
      reader.load(utterances, at)
    },
    renderScanProgress
  )
}

/* ── Player ──────────────────────────────────────────────────────────── */

async function continueIntoNextChapter(): Promise<void> {
  const from = current
  if (!from) return

  const book = findBook(index, from.bookId)
  // A PDF is already one continuous whole-book scroller. Its queue contains
  // only the virtualized pages currently drawn, not one chapter to advance.
  if (!book || book.format === 'pdf') return

  const next = nextChapter(book, from.file)
  if (!next) return

  await open(book.id, next.file, START)
  const state = reader.state
  if (
    current?.bookId === book.id &&
    current.file === next.file &&
    state.total > 0 &&
    !state.finished
  ) {
    reader.play()
  }
}

function renderPlayerState(): void {
  const state = reader.state
  const play = el<HTMLButtonElement>('play')
  if (play) {
    play.textContent = state.playing ? '❚❚ Pause' : '▶ Read aloud'
    play.setAttribute('aria-pressed', String(state.playing))
    play.disabled = state.total === 0
  }

  const position = el<HTMLElement>('speech-position')
  if (position) {
    const minutes = Math.ceil(state.remainingSeconds / 60)
    position.textContent = state.total ? `${minutes} min left` : ''
  }

  const rateValue = el<HTMLElement>('rate-value')
  if (rateValue) rateValue.textContent = `${state.rate.toFixed(1)}×`

  for (const id of ['prev-block', 'next-block', 'prev-section', 'next-section']) {
    const button = el<HTMLButtonElement>(id)
    if (button) button.disabled = state.total === 0
  }
}

async function setUpPlayer(): Promise<void> {
  el<HTMLButtonElement>('play')?.addEventListener('click', () => reader.toggle())
  el<HTMLButtonElement>('prev-block')?.addEventListener('click', () => reader.skip(-1))
  el<HTMLButtonElement>('next-block')?.addEventListener('click', () => reader.skip(1))
  el<HTMLButtonElement>('prev-section')?.addEventListener('click', () => reader.skipSection(-1))
  el<HTMLButtonElement>('next-section')?.addEventListener('click', () => reader.skipSection(1))

  const rate = el<HTMLInputElement>('rate')
  rate?.addEventListener('input', () => reader.setRate(Number(rate.value)))

  reader.onChange(renderPlayerState)
  reader.onEnd(() => void continueIntoNextChapter())
  renderPlayerState()

  const select = el<HTMLSelectElement>('voice')
  if (!select) return

  /*
    Neural voices first, then the system ones.

    A reader who has installed a Piper voice did so because the system voices
    were not good enough, so putting those at the top of the list would be
    showing them the thing they were trying to get away from.
  */
  let neural = await neuralVoices()
  neuralVoiceInstalled = neural.length > 0

  // Shape controls only matter for a neural voice; the system ones expose
  // nothing but a rate.
  const shapeRow = el<HTMLElement>('shape-row')
  if (shapeRow) shapeRow.hidden = neural.length === 0

  const applyShape = (): void => {
    const expressive = Number(el<HTMLInputElement>('expressive')?.value ?? '0.6')
    const shape: VoiceShape = clampShape({
      ...BOOK_VOICE,
      noiseScale: expressive,
      // Timing variation tracks expressiveness: a flat voice with loose timing
      // sounds broken rather than calm.
      noiseW: 0.4 + expressive * 0.5
    })
    reader.setShape(shape)
  }
  el<HTMLInputElement>('expressive')?.addEventListener('input', applyShape)

  const fill = (available: SpeechSynthesisVoice[]): void => {
    if (available.length === 0) return
    // English voices first: the library is in English, and a list led by voices
    // that cannot pronounce it is a list nobody scrolls past.
    const sorted = [...available].sort((a, b) => {
      const aEnglish = a.lang.startsWith('en') ? 0 : 1
      const bEnglish = b.lang.startsWith('en') ? 0 : 1
      return aEnglish - bEnglish || a.name.localeCompare(b.name)
    })

    const chosen = reader.state.voice
    select.replaceChildren()

    /*
      Neural voices first, then the system ones.

      Added inside this function rather than before it: filling the system
      voices calls `replaceChildren`, so a group appended earlier is wiped the
      moment the voice list arrives -- which is exactly what happened, and left
      the picker showing only the voices the reader was trying to get away from.
    */
    // Grouped by engine, best first: a flat list gives a reader no way to tell
    // that half the voices are a generation better than the other half.
    for (const engine of ['kokoro', 'piper']) {
      const voices = neural.filter((voice) => voice.engine === engine)
      if (voices.length === 0) continue
      const group = document.createElement('optgroup')
      group.label = engine === 'kokoro' ? 'Kokoro' : 'Piper'
      for (const voice of voices) {
        const option = document.createElement('option')
        option.value = `piper:${voice.id}`
        option.textContent = voice.name
        group.append(option)
      }
      select.append(group)
    }

    /*
      Characters belong in the voice list.

      They were originally kept out of it, on the grounds that a character is a
      conversion applied to a neural voice rather than a voice of its own. That
      is true of the code and irrelevant to the reader, who wants to choose who
      reads to them from the place voices are chosen. The distinction survives
      where it is useful -- the pitch and the prepared-speech controls are still
      in their own section -- and nowhere else.
    */
    if (neural.length > 0 && characters.ready && characters.names.length > 0) {
      const group = document.createElement('optgroup')
      group.label = 'Character'
      for (const name of characters.names) {
        const option = document.createElement('option')
        option.value = `character:${name}`
        option.textContent = prettyCharacter(name)
        group.append(option)
      }
      select.append(group)
    }

    for (const voice of sorted) {
      const option = document.createElement('option')
      option.value = voice.name
      option.textContent = `${voice.name} (${voice.lang})`
      select.append(option)
    }

    /*
      Whatever the reader actually chose.

      This used to reset to the first neural voice on every refill, so choosing
      a different one -- or a character -- was undone the moment the system
      voice list arrived a moment later.
    */
    select.value = selectedVoiceValue(neural)
    if (select.value) return

    const preferred = sorted.find((voice) => voice.name === chosen) ?? sorted[0]
    if (preferred) {
      select.value = preferred.name
      if (preferred.name !== chosen) reader.setVoice(preferred.name)
    }
  }

  select.addEventListener('change', () => {
    const value = select.value

    if (value.startsWith('character:')) {
      // A character needs a neural voice under it, so one is chosen here if the
      // reader has not picked one themselves.
      const base = settings.voiceId && settings.neural ? settings.voiceId : neural[0]?.id
      if (!base) return
      changeSettings({ neural: true, voiceId: base, character: value.slice('character:'.length) })
      return
    }

    if (value.startsWith('piper:')) {
      changeSettings({ neural: true, voiceId: value.slice('piper:'.length), character: null })
    } else {
      changeSettings({ neural: false, voiceId: value, character: null })
    }
  })

  if (neural.length > 0) {
    const stored = selectedVoiceValue(neural)
    if (stored) select.value = stored
    else {
      // A reader who installed one wants it used.
      const first = neural[0]
      if (first) {
        select.value = `piper:${first.id}`
        changeSettings({ neural: true, voiceId: first.id })
      }
    }
  } else {
    const folder = await voiceFolder()
    const hint = el<HTMLElement>('voice-hint')
    if (hint && folder) {
      hint.textContent = `For a better voice, put a Piper model in ${folder}`
      hint.hidden = false
    }
  }

  // Filled now if the voices are ready, and again if they arrive later. On
  // Windows they took several seconds, and a picker that gave up would stay
  // empty for the whole session.
  fill(await voices())
  onVoicesChanged(() => fill(speechSynthesis.getVoices()))

  refreshNeuralVoices = async () => {
    neural = await neuralVoices()
    neuralVoiceInstalled = neural.length > 0
    if (shapeRow) shapeRow.hidden = neural.length === 0

    const first = neural[0]
    if (first && (!settings.neural || !neural.some((voice) => voice.id === settings.voiceId))) {
      settings = await window.lectern.settings.set({
        neural: true,
        voiceId: first.id,
        character: null
      })
      applySettings()
    }
    fill(await voices())
  }
}

/* ── Home ────────────────────────────────────────────────────────────── */

function showHome(): void {
  const container = el<HTMLElement>('content')
  if (!container) return

  // Before anything is torn down. The tracker only fires on scroll, so a reader
  // who stops on a page and goes straight to the shelf would otherwise leave
  // the position recorded at wherever they last happened to move.
  recordHere()

  cancelScan()
  pdfView?.destroy()
  pdfView = null
  pdfBookId = null
  pdfPages.clear()
  epubBody = null
  reader.stop()
  current = null
  // Find is for the book being read, and there is none on the shelf.
  closeFind()

  document.body.classList.add('is-home')
  renderHome(
    container,
    index,
    progressOf,
    (bookId) => {
      const book = findBook(index, bookId)
      if (book?.unavailable === 'file-moved') {
        void locateBook(book.id)
        return
      }
      const stored = bookProgress(bookId)
      // Opening a book means continuing it, not restarting it.
      const last = stored.lastChapter
      const chapter = book?.chapters.find((c) => c.file === last) ?? book?.chapters[0]
      if (book && chapter) void open(book.id, chapter.file)
    },
    {
      sort: shelfSort,
      facts: (id) => {
        const stored = bookProgress(id)
        const chapters = Object.values(stored.chapters)
        return {
          // Books in `books/` have always been there, so they sort as oldest
          // rather than jostling with whatever was dropped in most recently.
          addedAt: addedTimes.get(id) ?? 0,
          readAt: chapters.reduce((latest, entry) => Math.max(latest, entry?.updatedAt ?? 0), 0)
        }
      },
      onSort: (sort) => {
        shelfSort = sort
        // Not through `changeSettings`: that re-applies the voice and restarts
        // speech preparation, and reordering the shelf needs neither.
        void window.lectern.settings.set({ sort }).then((updated) => {
          settings = updated
        })
        showHome()
      },
      // Only an added document has an added time, which makes the map that
      // already drives "recently added" the exact list of removable books.
      onAdd: (files) => void addFiles(files),
      removable: (id) => addedTimes.has(id),
      onRemove: (id) => void removeBook(id),
      hasNeuralVoice: neuralVoiceInstalled,
      voiceDownload: voiceDownloadActions(showHome)
    }
  )

  renderSidebar()
  renderNav(null, null)
  void loadCovers()
}

/** How far through a book the reader is, across all its chapters. */
function progressOf(book: Book): number | null {
  const stored = bookProgress(book.id)
  const entries = book.chapters
    .map((chapter) => stored.chapters[chapter.file])
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  if (entries.length === 0) return null

  const total = entries.reduce((sum, entry) => sum + fractionRead(entry), 0)
  return total / book.chapters.length
}

/**
 * Fetch covers in the background.
 *
 * One at a time rather than all at once: rendering the first page of a
 * 90 MB PDF is not free, and ten of them in parallel would make the shelf
 * unresponsive for as long as it took.
 */
async function loadCovers(): Promise<void> {
  for (const book of index.books) {
    if (book.unavailable || hasCover(book.id)) continue

    /*
      An image beside the book first, whatever the format.

      A PDF has a first page and an EPUB carries its own cover, but our own
      books are folders of Markdown with nothing to extract -- and a `cover.png`
      dropped in the folder should win for any of them, because a reader who put
      one there meant it.
    */
    const beside = await window.lectern.library.cover(book.id)
    if (beside) {
      setCover(book.id, beside)
      continue
    }

    if (book.format === 'pdf') {
      const cover = await pdfCover(book.id)
      if (cover) setCover(book.id, cover)
    }
  }
}

/* ── Adding documents ────────────────────────────────────────────────── */

/**
 * Drop a PDF or EPUB anywhere on the window to add it.
 *
 * Nothing outside `books/` is found automatically, so this is the main way a
 * downloaded book gets into the library. The file stays where it is; only a
 * reference is stored.
 */
function setUpDropTarget(): void {
  const overlay = el<HTMLElement>('drop-overlay')
  let depth = 0

  const show = (on: boolean): void => {
    overlay?.classList.toggle('is-visible', on)
  }

  // Counted rather than toggled: dragging over a child fires `dragleave` on the
  // parent, so a plain toggle flickers the overlay off mid-drag.
  document.addEventListener('dragenter', (event) => {
    event.preventDefault()
    depth += 1
    show(true)
  })

  document.addEventListener('dragover', (event) => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  })

  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) show(false)
  })

  document.addEventListener('drop', (event) => {
    event.preventDefault()
    depth = 0
    show(false)

    const files = Array.from(event.dataTransfer?.files ?? [])
    if (files.length === 0) return
    void addFiles(files)
  })
}

/** Add files chosen from the empty shelf or dropped anywhere on the window. */
async function addFiles(files: readonly File[]): Promise<void> {
  const paths = files.map((file) => window.lectern.library.pathForFile(file)).filter(Boolean)
  if (paths.length === 0) return

  const result = await window.lectern.library.add(paths)
  if (result.added > 0) {
    await load(true)
    showHome()
  }
  if (result.rejected.length > 0) {
    // Said plainly rather than ignored: a file that vanishes while being
    // chosen looks like the application is broken.
    announce(`${result.rejected.length} file(s) skipped — only PDF and EPUB can be added.`)
  } else if (result.added === 0) {
    announce('Already in the library.')
  }
}

/** Ask for a moved file's new path, then repaint it under the same progress id. */
async function locateBook(bookId: string): Promise<void> {
  const book = findBook(index, bookId)
  const result = await window.lectern.library.locate(bookId)
  if (result.located) {
    await load(true)
    showHome()
    announce(`Found ${book?.title ?? 'the book'}. Your reading progress is unchanged.`)
    return
  }
  if (result.reason === 'wrong-format') announce('Choose the same kind of file as the missing book.')
  if (result.reason === 'already-added') announce('That file is already on the shelf.')
  if (result.reason === 'unreadable') announce('That file could not be opened.')
}

/** Take an added document off the shelf. The main process asks first. */
async function removeBook(bookId: string): Promise<void> {
  const book = findBook(index, bookId)
  const result = await window.lectern.library.remove(bookId)

  if (result.removed) {
    chapterTexts.delete(bookId)
    pageTexts.delete(bookId)
    await load(true)
    showHome()
    announce(`Removed ${book?.title ?? 'the book'}. The file is still where it was.`)
    return
  }
  // Cancelling is an answer, not a failure, and needs no reply.
  if (result.reason === 'placed-by-hand') {
    announce('That one was put in the library folder by hand. Remove the file from there.')
  }
}

/** A brief message in the shelf header. */
function announce(message: string): void {
  const hint = document.querySelector<HTMLElement>('.shelf-hint')
  if (!hint) return
  const original = hint.textContent
  hint.textContent = message
  setTimeout(() => {
    hint.textContent = original
  }, 4000)
}

/* ── Settings ────────────────────────────────────────────────────────── */

async function showSettings(): Promise<void> {
  const container = el<HTMLElement>('content')
  if (!container) return

  recordHere()
  cancelScan()
  reader.stop()
  current = null
  closeFind()
  document.body.classList.add('is-home')

  renderSidebar()
  renderNav(null, null)

  renderSettings(container, {
    settings,
    libraryRoot: index.root,
    neuralVoices: await neuralVoices(),
    systemVoices: speechSynthesis.getVoices().map((voice) => ({
      name: voice.name,
      lang: voice.lang
    })),
    voicesFolder: await voiceFolder(),
    characters,
    store: await storeSize(),
    onClearStore: (done) => {
      void window.lectern.voice.clearStore().then(() => done())
    },
    onChange: (change) => {
      // Re-rendered so every readout reflects what was actually stored, which
      // is not always what was asked for -- the ranges are clamped.
      changeSettings(change, () => void showSettings())
    },
    onReveal: () => void window.lectern.settings.reveal(),
    onChangeLibrary: () => void window.lectern.settings.changeLibrary(),
    onInstallAuthoringKit: (done) => {
      void window.lectern.settings.installAuthoringKit().then((result) => done(result.copied))
    },
    onRescan: () => void load(true).then(showHome),
    onExportIndex: (done) => void window.lectern.flags.exportIndex().then(done),
    onPreview: (text) => {
      // Spoken through the real reader so the preview is the thing being
      // configured rather than an approximation of it.
      reader.load(
        [
          {
            text,
            element: container,
            source: text,
            map: [],
            offset: 0,
            kind: 'paragraph' as const
          }
        ],
        0
      )
      reader.play()
    },
    voiceDownload: voiceDownloadActions(() => void showSettings())
  })
}

function voiceDownloadActions(afterInstalled: () => void): VoiceDownloadActions {
  return {
    start: async (onProgress) => {
      const stop = window.lectern.voice.onDownloadProgress(onProgress)
      try {
        return await window.lectern.voice.download()
      } finally {
        stop()
      }
    },
    cancel: () => {
      void window.lectern.voice.cancelDownload()
    },
    installed: () => {
      void refreshNeuralVoices().then(afterInstalled)
    }
  }
}

/** Push settings into the parts of the application that read them. */
/**
 * The collapse button's own state: which way it points, and what it says.
 *
 * Shared by the click and by the restore at startup, because a sidebar that
 * comes back hidden with a button still offering to hide it is worse than one
 * that forgot.
 */
function showCollapsed(hidden: boolean): void {
  const button = el<HTMLButtonElement>('collapse')
  if (!button) return
  button.textContent = hidden ? '›' : '‹'
  button.title = hidden ? 'Show the sidebar' : 'Hide the sidebar'
}

function applySettings(): void {
  const root = document.documentElement
  root.dataset.theme = settings.theme
  root.style.setProperty('--font-size-scale', String(settings.fontScale))
  root.style.setProperty('--measure', `${settings.measure}ch`)

  document.body.classList.toggle('is-collapsed', settings.collapsed)
  showCollapsed(settings.collapsed)

  reader.setRate(settings.rate)
  reader.setShape(settings.shape)
  reader.setPauseScale(settings.pauseScale)
  reader.setCharacter(
    settings.character,
    settings.characterPitch,
    settings.characterIndex,
    settings.characterProtect
  )
  // Every one of those changes what the stored audio would have to be, so the
  // job starts again rather than finishing a chapter nobody will hear.
  startPreparing()
  if (settings.neural && settings.voiceId) reader.setNeuralVoice(settings.voiceId)
  else if (!settings.neural && settings.voiceId) {
    reader.setNeuralVoice(null)
    reader.setVoice(settings.voiceId)
  }
  shelfSort = settings.sort
  sectionsOpen = settings.sections
}

/**
 * Character voices, or an empty list when the bridge is unavailable.
 *
 * Settings must render whatever happens here: a missing folder is the ordinary
 * case for a reader who has never wanted a character voice, and it is not a
 * reason to fail to draw the page.
 */
async function characterList(): Promise<{ names: string[]; ready: boolean; folder: string }> {
  try {
    return await window.lectern.voice.characters()
  } catch {
    return { names: [], ready: false, folder: '' }
  }
}

/**
 * The picker value the stored settings describe, or '' if nothing is stored.
 *
 * A character takes precedence over the base voice it runs on: it is the thing
 * the reader hears, so it is the thing the picker should say.
 */
function selectedVoiceValue(neural: readonly { id: string }[]): string {
  if (settings.character && characters.names.includes(settings.character)) {
    return `character:${settings.character}`
  }
  if (settings.neural && settings.voiceId) {
    return neural.some((voice) => voice.id === settings.voiceId)
      ? `piper:${settings.voiceId}`
      : ''
  }
  return settings.voiceId ?? ''
}

/** A folder name is a folder name; `kasane-teto` reads better as `Kasane Teto`. */
function prettyCharacter(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

/**
 * Characters installed, held so the player's picker can list them without
 * asking the main process every time it refills.
 */
let characters: { names: string[]; ready: boolean; folder: string } = {
  names: [],
  ready: false,
  folder: ''
}

/**
 * Apply and persist a settings change.
 *
 * Shared by the settings page and the player's voice picker. The player used to
 * talk only to the reader, which meant a voice chosen while reading was
 * forgotten on the next launch and disagreed with what settings showed.
 */
function changeSettings(change: Partial<Settings>, after?: () => void): void {
  void window.lectern.settings.set(change).then((updated) => {
    settings = updated
    applySettings()
    after?.()
  })
}

/** How much disk prepared speech is using, or nothing when unavailable. */
async function storeSize(): Promise<{ files: number; bytes: number }> {
  try {
    return await window.lectern.voice.storeSize()
  } catch {
    return { files: 0, bytes: 0 }
  }
}

/* ── Startup ─────────────────────────────────────────────────────────── */

async function load(rescan = false): Promise<void> {
  try {
    const times = await window.lectern.library.addedTimes()
    addedTimes.clear()
    for (const [id, at] of Object.entries(times)) addedTimes.set(id, at)
  } catch {
    // Without them "recently added" degrades to title order, which is fine.
  }
  index = rescan ? await window.lectern.library.rescan() : await window.lectern.library.get()
  renderSidebar()
}

/** Where the reader left off, or the first chapter of the first book. */
function resumeTarget(): { bookId: string; file: string } | null {
  const lastBook = progress.lastBook ? findBook(index, progress.lastBook) : null
  const lastFile = lastBook ? bookProgress(lastBook.id).lastChapter : null

  if (lastBook && lastFile && lastBook.chapters.some((c) => c.file === lastFile)) {
    return { bookId: lastBook.id, file: lastFile }
  }

  const first = index.books[0]
  const chapter = first?.chapters[0]
  return first && chapter ? { bookId: first.id, file: chapter.file } : null
}

async function start(): Promise<void> {
  const container = el<HTMLElement>('content')

  // Ctrl +/-/0 zoom the document being read, never the application.
  window.lectern.onZoomKey((direction) => {
    if (!pdfView) return
    const current = pdfView.zoom()
    const next = direction === 'reset' ? 1 : direction === 'in' ? current * 1.2 : current / 1.2
    void pdfView.setZoom(next)
  })

  el<HTMLButtonElement>('home')?.addEventListener('click', showHome)
  el<HTMLButtonElement>('settings')?.addEventListener('click', () => void showSettings())

  const collapse = el<HTMLButtonElement>('collapse')
  collapse?.addEventListener('click', () => {
    const hidden = document.body.classList.toggle('is-collapsed')
    showCollapsed(hidden)
    // Not through `changeSettings`: that re-applies the voice and restarts
    // speech preparation, and hiding a sidebar needs neither.
    void window.lectern.settings.set({ collapsed: hidden }).then((updated) => {
      settings = updated
    })
    // The PDF is fitted to the pane, so the pane changing width means the page
    // has to be laid out again.
    if (pdfView) void pdfView.setZoom(pdfView.zoom())
  })

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    if (!current) return
    const book = findBook(index, current.bookId)
    if (!book) return

    if (event.altKey && event.key === 'ArrowRight') {
      const next = nextChapter(book, current.file)
      if (next) void open(book.id, next.file)
    }
    if (event.altKey && event.key === 'ArrowLeft') {
      const previous = previousChapter(book, current.file)
      if (previous) void open(book.id, previous.file)
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      openFind()
      return
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      void addBookmarkHere()
    }

    // Space is the universal play/pause, but only when the reader is not on a
    // control that uses it -- a focused button would otherwise be pressed too.
    if (event.key === 'Escape') {
      closeFlagBar()
      closeFind()
      return
    }

    if (event.key === ' ' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault()
      reader.toggle()
    }
  })

  /*
    Double-click a paragraph to read from it.

    It was a double-click once, became a single click because nothing on screen
    suggested the gesture and nobody found it, and is a double-click again --
    this time on evidence rather than on reasoning. On a touchpad a single click
    is trivially easy to produce by accident, and the failure is loud: the room
    starts being read aloud at whatever paragraph the palm landed on. A gesture
    nobody discovers costs a feature; a gesture that fires by itself costs the
    reader's attention every time.

    `dblclick` also selects the word underneath, which is the browser's default
    and not wanted here -- so the selection is cleared. Dragging to select is
    untouched, which is how a reader selects text anyway.
  */
  el<HTMLElement>('content')?.addEventListener('dblclick', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    // Controls and links keep their own behaviour.
    if (target.closest('button, a, summary, input, select')) return

    /*
      The selection is cleared rather than consulted.

      Under a single click, text already selected meant "the reader is working
      with this passage, not asking for it" and the handler stood down. A
      double-click makes its own selection by definition, so the same guard
      would have refused every one of them.
    */
    window.getSelection()?.removeAllRanges()

    /*
      Where the reader actually pointed, not merely which block they hit.

      Matching the block alone starts a PDF page from its first sentence
      wherever on the page the click landed -- which on a full page is most of a
      screen away from the words under the cursor.
    */
    const position = positionAtPoint(event.clientX, event.clientY)
    if (position) {
      if (position.element.dataset['speak'] === 'no') return
      reader.jumpTo(reader.indexAt(position.element, position.offset))
      reader.play()
      return
    }

    const block = target.closest('p, h1, h2, h3, h4, h5, h6, li, figcaption, .pdf-text-layer')
    if (!(block instanceof HTMLElement)) return
    if (block.dataset['speak'] === 'no') return

    reader.jumpTo(reader.indexNear(block))
    reader.play()
  })

  if (container) {
    positionTracker = trackPosition(container, positionBody, record, recordNow)
  }

  // The last word before the window goes. The main process debounces writes and
  // flushes them on quit, so this only has to make sure the position it flushes
  // is the one the reader stopped at.
  window.addEventListener('beforeunload', recordHere)

  window.lectern.voice.onPrepared(renderPrepareProgress)

  ;[index, progress] = await Promise.all([
    window.lectern.library.get(),
    window.lectern.progress.get()
  ])
  renderSidebar()

  setUpFlagging()
  setUpFind()
  setUpDropTarget()

  /*
    Settings and characters before the player, not after.

    The player fills its voice picker from both, so loading them afterwards
    meant the picker was built against the defaults and never rebuilt: the
    stored voice looked forgotten, and characters did not appear at all.
  */
  settings = await window.lectern.settings.get()
  characters = await characterList()

  await setUpPlayer()
  applySettings()

  flags = (await window.lectern.flags.get()).flags
  renderFlags()

  /*
    A source file changed on disk. Re-reading the open chapter is what closes
    the loop between flagging a passage here and fixing it in Claude Code: the
    alternative is quit, rebuild, reopen, find your place again, which is enough
    friction that the loop stops being used.
  */
  window.lectern.onLibraryChange(() => {
    // An edited chapter has new text, and a search should find what it says now.
    chapterTexts.clear()
    if (!current) return
    const container = el<HTMLElement>('content')
    const at = container && chapterBody() ? currentPosition(container, chapterBody()!) : undefined
    void load().then(() => {
      if (current) void open(current.bookId, current.file, at)
    })
  })

  // The shelf, not the last chapter. Landing straight inside a book gives the
  // reader no way to see what else is there, and "continue" is one click away
  // on the card itself.
  showHome()
}

// A rejected promise inside a `void`ed call vanishes without trace, which cost
// an afternoon once. Anything unhandled is reported.
window.addEventListener('unhandledrejection', (event) => {
  console.error(`unhandled: ${String(event.reason)}`)
})

void start()
