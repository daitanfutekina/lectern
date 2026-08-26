import { BrowserWindow } from 'electron'
import { speak as speakPiper } from './piper'
import { hasSpeech, writeSpeech } from './speech-store'
import type { PrepareProgress, SpeechRequest } from '@shared/speech-cache'

/**
 * Preparing a chapter in a character voice. SPEC section 5.
 *
 * Piper synthesises at about twenty times realtime, which is fast enough to
 * speak on demand and never be noticed. Conversion is roughly realtime, which
 * is not: pressing play would mean waiting several seconds for the first
 * sentence, and then again at every sentence after it.
 *
 * So a chapter is prepared rather than spoken. The queue walks its sentences in
 * reading order, synthesises each into the store, and reports how far it has
 * got. Reading order matters more than it looks: it means a reader who presses
 * play immediately is racing ahead of the queue at the same speed it is moving,
 * and in practice never catches it.
 *
 * One sentence at a time, deliberately. The runtime is already using half the
 * machine's cores for a single sentence, so a second in parallel would take
 * roughly twice as long and finish no sooner.
 */

interface Job {
  readonly bookId: string
  readonly file: string
  readonly sentences: readonly string[]
  readonly base: Omit<SpeechRequest, 'text'>
  cancelled: boolean
}

let job: Job | null = null

/** Stop whatever is being prepared. Called when the reader opens something else. */
export function cancelPrepare(): void {
  if (job) job.cancelled = true
  job = null
}

function report(progress: PrepareProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('voice:prepared', progress)
  }
}

/**
 * Prepare a chapter's sentences, replacing any job already running.
 *
 * Returns immediately; progress arrives on `voice:prepared`. There is never
 * more than one job, because two would contend for the same cores and both
 * would finish later than either alone.
 */
export function prepareChapter(
  bookId: string,
  file: string,
  sentences: readonly string[],
  base: Omit<SpeechRequest, 'text'>
): void {
  cancelPrepare()
  if (!base.character || sentences.length === 0) return

  const current: Job = { bookId, file, sentences, base, cancelled: false }
  job = current
  void run(current)
}

async function run(current: Job): Promise<void> {
  let done = 0
  let failed = 0
  const total = current.sentences.length

  report({ bookId: current.bookId, file: current.file, done, total, failed, running: true })

  for (const text of current.sentences) {
    if (current.cancelled) return

    const request: SpeechRequest = { ...current.base, text }

    /*
      Skip what is already stored.

      This is what makes reopening a chapter free, and it is also what makes
      the queue survive being cancelled: the next run picks up where the last
      one stopped rather than starting the chapter again.
    */
    if (!(await hasSpeech(request))) {
      try {
        const spoken = await speakPiper(
          request.voiceId,
          text,
          request.shape,
          request.speed,
          { name: request.character ?? '', semitones: request.semitones }
        )
        if (spoken) await writeSpeech(request, spoken)
        else failed += 1
      } catch {
        failed += 1
      }
    }

    if (current.cancelled) return
    done += 1

    // Every sentence, because each one is seconds of work and a bar that moves
    // once a minute reads as a hung application.
    report({ bookId: current.bookId, file: current.file, done, total, failed, running: true })
  }

  if (current.cancelled) return
  job = null
  report({ bookId: current.bookId, file: current.file, done, total, failed, running: false })
}
