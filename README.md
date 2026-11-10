# Lectern

Lectern is a Windows reading application for a personal library of Markdown
textbooks, PDFs, and EPUBs. Its focus is reading aloud: every format is adapted
to the same speech controls, while PDFs still look like PDFs and EPUBs keep the
publisher's typography.

Lectern is currently **Windows-only**. The build produces a Windows x64
installer. Installers will be published on the
[GitHub Releases page](https://github.com/daitanfutekina/lectern/releases).
They are not code-signed, so Windows may show an unrecognized-app warning.

## What it does

- Reads Markdown and HTML textbooks, digital PDFs, scanned PDFs through
  background OCR, and EPUBs.
- Uses Windows system voices immediately and can install a free Piper neural
  voice for higher-quality local speech.
- Remembers reading and speech position, bookmarks, window state, and settings.
- Searches within the open book, tracks progress on the shelf, and lets larger
  libraries filter by title or author.
- Starts reading from a block on double-click and continues automatically into
  the next chapter for Markdown, HTML, and EPUB books.
- Shows PDFs as continuous rendered pages, with page navigation, internal and
  web links, password prompts, and an optional night-reading inversion that is
  off by default.
- Preserves EPUB styling while applying the reader's relative text-size setting,
  and reports content DRM instead of opening unreadable content.
- Includes dark and light themes, visible keyboard focus, reduced-motion
  support, and a `?` overlay generated from the active keyboard shortcuts.
- Flags a passage to `FLAGGED.md` and exports the library structure to
  `INDEX.md`, so a coding agent can improve a textbook from what the reader
  actually encountered.

Speech does **not** continue across PDF chapters. The PDF remains a continuous
visual scroller, but automatic chapter-to-chapter playback is currently limited
to the other book formats.

## Install

Download the latest installer from the
[GitHub Releases page](https://github.com/daitanfutekina/lectern/releases), or
build it from source by installing Node.js and npm and running these commands
from the repository:

```powershell
npm.cmd ci
npm.cmd run package
```

The generated x64 installer is placed in `release/`. Run that `.exe` and follow
the installation prompts. The installer is unsigned, so Windows may show an
unrecognized-app warning. Lectern checks for updates in the background by
default, downloads them without blocking reading, and installs a ready update
when the app is next quit. Turn off **Update automatically** in Settings to
disable those checks.

## Create a library and add books

On first launch, choose a folder for the library. Lectern creates these folders
inside it:

```text
<library>/
  books/        Markdown or HTML textbooks
  pdfs/
  epubs/
  .library/     index, progress, settings, OCR, speech, and voice data
```

Use **Add PDF or EPUB** on an empty shelf, drop one or more files anywhere on
the window, or place files in the library's `pdfs/` or `epubs/` folder. Added
documents stay in their original location rather than being copied. Unsupported,
protected, corrupt, and unreadable files are reported by name when an add fails.

If an added file is moved, its shelf entry and progress remain. Open that entry
to locate the file again. Right-click an added PDF or EPUB to remove its library
entry; Lectern never deletes the source file.

A hand-written textbook belongs in `<library>/books/<book-name>/`. It needs a
`book.yml` manifest that names the book and lists its chapters in reading order.

## Voices

Windows system voices work without an additional download. For a more natural
local voice, use the button on the empty shelf or in Settings to install the
free Lessac Piper voice. The download starts only when that button is clicked,
shows progress, can be cancelled, verifies the downloaded files, and leaves no
partial voice installed after a failure. Once installed, speech synthesis is
local and works offline.

Other Piper or Kokoro voices and optional character-voice models can be
installed manually. They are not bundled because the model files are large.
See [VOICES.md](VOICES.md) for the supported folder layout and model
details.

## Write your own books with Claude

Every newly created library receives a self-contained textbook-writing skill in
both of these locations:

```text
<library>/.claude/skills/textbook/
<library>/.agents/skills/textbook/
```

For an existing library, choose **Add writing guide for Claude to this library**
in Settings. The installer copies only missing files, so it does not overwrite a
guide you have customized.

Open the library folder in Claude Code and ask it to create or improve a chapter.
The skill explains the `book.yml` manifest, Markdown front matter, supported
directives, mathematics, figures, hidden solutions, and writing for speech. It
also includes an original example chapter and a chapter lint script. New chapters
must be added to the manifest before they appear in Lectern.

Lectern watches textbook source files, so a saved edit re-renders in the reader
without a Markdown build step.

## Privacy and network behavior

Books, progress, settings, OCR results, prepared speech, and installed voices
stay on the computer. Lectern requires no account or paid service, and ordinary
reading uses local files and bundled libraries.

Network access is limited to three features:

- A chapter may contain a sandboxed remote embed. That embed may need the
  network, but the chapter text remains local and readable when it cannot load.
- The free Piper voice is downloaded only after the reader explicitly clicks
  the install button. Speech is local after installation.
- Packaged builds check GitHub Releases for updates in the background when
  **Update automatically** is on. A failed check is silent, reading remains
  available offline, and the setting can be turned off in Settings.

Web links in books and PDFs open in the system browser only when clicked.

## Documentation

- [VOICES.md](VOICES.md) — neural and character voice setup
- [resources/authoring/textbook/SKILL.md](resources/authoring/textbook/SKILL.md) — the bundled writing guide

## License

Lectern is available under the [MIT License](LICENSE). Licenses and notices for
production dependencies and vendored assets are collected in
[THIRD_PARTY_NOTICES.txt](resources/THIRD_PARTY_NOTICES.txt).
