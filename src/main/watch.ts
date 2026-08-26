import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

/**
 * Watching the library for edits. SPEC section 8.
 *
 * The loop this closes: a passage is flagged while reading, edited in Claude
 * Code, and the reader sees the new version without leaving the application.
 * Without it the last step is "quit, rebuild, reopen, find your place again",
 * which is enough friction to stop the loop being used.
 *
 * Only `books/` is watched. PDFs and EPUBs are not edited in place, and
 * watching a folder of 90 MB scans would cost something for nothing.
 */

type OnChange = (file: string) => void

let watcher: FSWatcher | null = null
let timer: NodeJS.Timeout | null = null

/**
 * Editors write a file in several operations, so one save can arrive as three
 * events. Debouncing turns that back into one reload -- and a reload mid-write
 * would render a half-written chapter.
 */
const SETTLE_MS = 250

export function watchLibrary(root: string, onChange: OnChange): void {
  stopWatching()

  try {
    watcher = watch(join(root, 'books'), { recursive: true }, (_event, filename) => {
      if (!filename) return
      const name = filename.toString()
      if (!name.endsWith('.md') && !name.endsWith('.html') && !name.endsWith('.yml')) return

      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        onChange(name.replace(/\\/g, '/'))
      }, SETTLE_MS)
    })
  } catch {
    // Live reload is a convenience. A platform or filesystem that will not
    // support a recursive watch costs the convenience and nothing else.
    watcher = null
  }
}

export function stopWatching(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  watcher?.close()
  watcher = null
}
