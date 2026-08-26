import './styles.css'
import { renderMarkdown } from '@shared/markdown'
import { splitFrontMatter } from '@shared/manifest'
import { readingMinutes } from '@shared/outline'
import { EMPTY_INDEX, findBook, nextChapter, previousChapter } from '@shared/library'
import {
  EMPTY_BOOK,
  EMPTY_PROGRESS,
  START,
  fractionRead,
  isFinished,
  type Bookmark,
  type LibraryProgress,
  type ReadingPosition
} from '@shared/progress'
import type { Book, Chapter, LibraryIndex } from '@shared/library'
import { typeset, configureMacros } from './mathjax'
import { blockCount, currentPosition, restorePosition, trackPosition } from './position'
import { collectMath, extract, injectInlineSpeech, withMathSpeech, type Utterance } from './blocks'
import { Reader, onVoicesChanged, voices } from './speech'
import { cancelScan, pagesToHtml, scanRange, type ScanProgress } from './scan-queue'
import { FLAG_LABELS, excerpt, type Flag, type FlagKind } from '@shared/flags'
import { mathUtterance } from '@shared/math-gate'

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

/** Flags in the library, and the paragraph currently being flagged. */
let flags: readonly Flag[] = []
let flagging: HTMLElement | null = null

/** One reader for the whole session; chapters are loaded into it. */
const reader = new Reader()

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

/* ── Sidebar ─────────────────────────────────────────────────────────── */

function renderSidebar(): void {
  const books = el<HTMLElement>('books')
  const meta = el<HTMLElement>('library-meta')
  if (!books) return

  books.replaceChildren()

  if (index.books.length === 0) {
    books.append(element('div', 'book-title', 'No books found'))
    const hint = element('p', 'sidebar-hint')
    hint.textContent = `Put a book folder in ${index.root || 'the library root'}\\books`
    books.append(hint)
  }

  for (const book of index.books) {
    books.append(element('div', 'book-title', book.title))
    const stored = bookProgress(book.id)

    for (const chapter of book.chapters) {
      const chapterProgress = stored.chapters[chapter.file] ?? null
      const button = element('button', 'chapter-link')
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
      const fraction = fractionRead(chapterProgress)
      if (fraction > 0) {
        const track = element('span', 'progress-track')
        const fill = element('span', 'progress-fill')
        fill.style.width = `${Math.round(fraction * 100)}%`
        track.append(fill)
        button.append(track)
      }

      const isCurrent = current?.bookId === book.id && current.file === chapter.file
      button.setAttribute('aria-current', String(isCurrent))
      // Addressable, so a verification run can open a specific chapter rather
      // than counting positions in a list that changes as books are added.
      button.dataset['book'] = book.id
      button.dataset['chapter'] = chapter.file
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

  renderBookmarks()
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

  const forward = element('button', undefined, next ? `${next.title} →` : 'End of book →')
  forward.type = 'button'
  forward.disabled = next === null
  if (next) forward.addEventListener('click', () => void open(book.id, next.file))

  nav.append(back, mark, forward)
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
  // Two chapters recognising at once would fight over one CPU and both crawl.
  cancelScan()
  const container = el<HTMLElement>('content')
  if (!container) return

  const book = findBook(index, bookId)
  const chapter = book?.chapters.find((c) => c.file === file) ?? null
  if (!book || !chapter) return

  restoring = true
  current = { bookId, file }
  renderSidebar()
  renderNav(book, chapter)

  const source = await window.lectern.library.chapter(bookId, file)
  if (source === null) {
    container.replaceChildren(element('p', 'placeholder', 'That chapter could not be read.'))
    restoring = false
    return
  }

  // Markdown books carry front matter and go through the pipeline. EPUB and
  // PDF chapters arrive as HTML already, prepared by their adapter in main.
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
  rendered.innerHTML = isMarkdown ? renderMarkdown(body) : body
  article.append(rendered)

  container.replaceChildren(article)
  container.scrollTop = 0

  // Typeset before restoring: equations change block heights substantially, and
  // restoring against pre-typeset geometry lands in the wrong place.
  await typeset(rendered)

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
  const rebuilt = withMathSpeech(extract(body), displaySpeech)
  reader.load(rebuilt, Math.min(resumeAt, Math.max(0, rebuilt.length - 1)))
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
    position.textContent = state.total ? `${state.index + 1} / ${state.total}` : ''
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
  renderPlayerState()

  const select = el<HTMLSelectElement>('voice')
  if (!select) return

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
    for (const voice of sorted) {
      const option = document.createElement('option')
      option.value = voice.name
      option.textContent = `${voice.name} (${voice.lang})`
      select.append(option)
    }

    const preferred = sorted.find((voice) => voice.name === chosen) ?? sorted[0]
    if (preferred) {
      select.value = preferred.name
      if (preferred.name !== chosen) reader.setVoice(preferred.name)
    }
  }

  select.addEventListener('change', () => reader.setVoice(select.value))

  // Filled now if the voices are ready, and again if they arrive later. On
  // Windows they took several seconds, and a picker that gave up would stay
  // empty for the whole session.
  fill(await voices())
  onVoicesChanged(() => fill(speechSynthesis.getVoices()))
}

/* ── Startup ─────────────────────────────────────────────────────────── */

async function load(rescan = false): Promise<void> {
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

  el<HTMLButtonElement>('rescan')?.addEventListener('click', () => void load(true))

  // Writes INDEX.md: every book, chapter and heading in one file, so "have I
  // covered eigenvalues" can be answered by reading one thing rather than
  // walking 220.
  el<HTMLButtonElement>('export-index')?.addEventListener('click', () => {
    const button = el<HTMLButtonElement>('export-index')
    void window.lectern.flags.exportIndex().then((path) => {
      if (!button) return
      button.textContent = path ? 'Written' : 'Failed'
      setTimeout(() => {
        button.textContent = 'Index'
      }, 2000)
    })
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
    if (event.ctrlKey && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      void addBookmarkHere()
    }

    // Space is the universal play/pause, but only when the reader is not on a
    // control that uses it -- a focused button would otherwise be pressed too.
    if (event.key === 'Escape') {
      closeFlagBar()
      return
    }

    if (event.key === ' ' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault()
      reader.toggle()
    }
  })

  // Clicking a paragraph starts reading from it, which is the fastest way to
  // say "read from here" and needs no extra control.
  el<HTMLElement>('content')?.addEventListener('dblclick', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const block = target.closest('p, h1, h2, h3, h4, li, summary')
    if (!(block instanceof HTMLElement)) return
    reader.jumpTo(reader.indexNear(block))
    reader.play()
  })

  if (container) {
    trackPosition(container, chapterBody, (position, blocks) => {
      if (!current || restoring) return
      void window.lectern.progress
        .record(current.bookId, current.file, position, blocks)
        .then((updated) => {
          if (!updated || !current) return
          const stored = bookProgress(current.bookId)
          progress = {
            ...progress,
            lastBook: current.bookId,
            books: {
              ...progress.books,
              [current.bookId]: {
                ...stored,
                lastChapter: current.file,
                chapters: { ...stored.chapters, [current.file]: updated }
              }
            }
          }
          renderSidebar()
        })
    })
  }

  ;[index, progress] = await Promise.all([
    window.lectern.library.get(),
    window.lectern.progress.get()
  ])
  renderSidebar()

  setUpFlagging()
  await setUpPlayer()

  flags = (await window.lectern.flags.get()).flags
  renderFlags()

  /*
    A source file changed on disk. Re-reading the open chapter is what closes
    the loop between flagging a passage here and fixing it in Claude Code: the
    alternative is quit, rebuild, reopen, find your place again, which is enough
    friction that the loop stops being used.
  */
  window.lectern.onLibraryChange(() => {
    if (!current) return
    const container = el<HTMLElement>('content')
    const at = container && chapterBody() ? currentPosition(container, chapterBody()!) : undefined
    void load().then(() => {
      if (current) void open(current.bookId, current.file, at)
    })
  })

  const target = resumeTarget()
  if (target) void open(target.bookId, target.file)
}

// A rejected promise inside a `void`ed call vanishes without trace, which cost
// an afternoon once. Anything unhandled is reported.
window.addEventListener('unhandledrejection', (event) => {
  console.error(`unhandled: ${String(event.reason)}`)
})

void start()
