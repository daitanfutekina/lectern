# Lectern

A reading application for a personal library of textbooks, PDFs and EPUBs, built
around reading aloud.

Everything is free and offline. No paid service, no account, no network.

## Roadmap

- [x] **M1** — Library root, scan, index, Markdown renderer
- [ ] **M2** — Reading UI, progress, bookmarks, resume
- [ ] **M3** — Speakable blocks, text-to-speech on Markdown and HTML
- [ ] **M4** — Mathematics speech and the complexity gate
- [ ] **M5** — Digital PDF and EPUB adapters
- [ ] **M6** — OCR pipeline and background queue
- [ ] **M7** — Flagged passages and index export

Each milestone has an explicit *done when* in [docs/SPEC.md](docs/SPEC.md)
section 11.

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
