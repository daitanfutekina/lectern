# Lectern

A reading application for a personal library of textbooks, PDFs and EPUBs, built
around reading aloud.

Everything is free and offline. No paid service, no account, no network.

## Roadmap

- [x] **M1** — Library root, scan, index, Markdown renderer
- [x] **M2** — Reading UI, progress, bookmarks, resume
- [x] **M3** — Speakable blocks, text-to-speech on Markdown and HTML
- [x] **M4** — Mathematics speech and the complexity gate
- [x] **M5** — Digital PDF and EPUB adapters
- [x] **M6** — OCR pipeline and background queue
- [x] **M7** — Flagged passages and index export
- [x] **M8** — PDFs shown as PDFs, EPUBs with the publisher's typography
- [x] **M9** — Neural voices, character voices, and a settings page

Each was done against the explicit *done when* in
[docs/SPEC.md](docs/SPEC.md) section 11.

## Reading aloud

Speech is the point of the application. The Windows system voices are the
fallback; the default is Piper, a free local neural voice, and on top of that a
character voice can convert the result into someone else.

Neither kind of voice is in this repository — they are hundreds of megabytes of
model weights. [docs/VOICES.md](docs/VOICES.md) says what to install and where.

## The shelf

The home view is a grid of covers with a corner ribbon per format. Only
`books/` is scanned; a PDF or EPUB joins the library by being dropped on the
window or placed in `pdfs/`/`epubs/` by hand, and it is referenced where it
lives rather than copied.

A PDF is shown as its rendered pages and an EPUB keeps its own typography. Only
the hand-written textbooks wear the application's design, which is what stops
*those* diverging.

## The handoff

Right-click a paragraph while reading to flag it. That writes `FLAGGED.md` at
the library root -- grouped by chapter, quoting each passage as it read at the
time, so it can be found by searching the source even after the chapter has
been edited. Editing a source file re-renders it in the reader within a second,
which is what makes the loop worth using.

The `Index` button writes `INDEX.md`: every book, chapter and heading in one
file, so what the library already covers can be read without opening any of it.

## Commands

```bash
npm run dev        # development, renderer hot reload
npm run build      # typecheck + build all three bundles to out/
npm run typecheck  # main/preload and renderer, separately
npm test           # unit tests for src/shared
npm run convert    # HTML textbook -> Markdown
```

Verifying a render needs the real application, so:

```bash
LECTERN_CAPTURE=shot.png npx electron out/main/index.js
```

runs the app, screenshots it, reports what is actually in the DOM, and exits.
`LECTERN_SCROLL`, `LECTERN_CLICK`, `LECTERN_WAIT` and `LECTERN_WIDTH` drive it
further, which is how resuming was verified across three window widths. A
capture run is hidden and muted, so it never takes the screen or reads aloud
over whoever is using the machine.

## The library

Books live at `C:\Library` by default:

```
C:\Library\
  books\        textbooks (Markdown; HTML during the transition)
  pdfs\
  epubs\
  .library\     index.json, progress.json, ocr-cache\
```

A book is a folder containing chapter files and one `book.yml` carrying the
title, chapter order, and the book's LaTeX macros.

Books contain no presentation. One stylesheet ships with the application, which
is what stops seven books drifting into seven designs.

## Converting a textbook

```bash
npm run convert -- "path/to/html/book" "C:/Library/books/the-book"
node scripts/verify-conversion.mjs "path/to/html/book" "C:/Library/books/the-book"
```

The converter does the bulk and reports what it could not handle; the verifier
compares the result against the source word by word and checks that directive
nesting closes. Linear Algebra converts at 0.00% word loss.

## Documentation

- [docs/SPEC.md](docs/SPEC.md) — the specification, and the reasoning behind it
- [docs/FINDINGS.md](docs/FINDINGS.md) — experiments and what they showed
- [CLAUDE.md](CLAUDE.md) — working notes for Claude Code
