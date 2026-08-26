import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isCacheable, speechKey, type SpeechRequest } from '@shared/speech-cache'

/**
 * Converted speech on disk. SPEC section 5.
 *
 * A sentence in a character voice takes about as long to produce as it does to
 * say, so it is produced once and kept. The store is what makes a prepared
 * chapter play instantly and, more importantly, what makes preparing it worth
 * doing at all -- without this, leaving a chapter and coming back would repeat
 * every second of the work.
 *
 * Files rather than a database, for the same reason as everywhere else here: a
 * few thousand small files in a folder is entirely adequate, they can be
 * deleted with an ordinary file manager, and there is no native module.
 *
 *   <library>/.library/speech/<first two hex digits>/<full hash>.pcm
 *
 * The two-character fan-out exists because a directory with fifty thousand
 * entries is slow to open on Windows, and a long book is a few thousand
 * sentences.
 */

const STORE_DIR = join('.library', 'speech')

let root = ''

export function configureSpeechStore(libraryRoot: string): void {
  root = libraryRoot
}

/**
 * The file a request's audio lives in.
 *
 * SHA-1 rather than a longer digest: this is a lookup key, not a signature, and
 * nothing here defends against someone deliberately colliding two sentences.
 */
function pathFor(request: SpeechRequest): { dir: string; file: string } {
  const hash = createHash('sha1').update(speechKey(request), 'utf8').digest('hex')
  const dir = join(root, STORE_DIR, hash.slice(0, 2))
  return { dir, file: join(dir, `${hash}.pcm`) }
}

export interface StoredSpeech {
  readonly pcm: Int16Array
  readonly sampleRate: number
}

/**
 * The stored audio for a request, or null.
 *
 * The sample rate is written into the first four bytes rather than kept in a
 * sidecar file: it is a property of the model that produced the audio, models
 * differ (32 kHz here, 40 and 48 elsewhere), and a rate that goes missing plays
 * the sentence at the wrong speed rather than failing.
 */
export async function readSpeech(request: SpeechRequest): Promise<StoredSpeech | null> {
  if (!isCacheable(request)) return null

  try {
    const { file } = pathFor(request)
    const bytes = await readFile(file)
    if (bytes.length < 4) return null

    const sampleRate = bytes.readUInt32LE(0)
    const samples = (bytes.length - 4) / 2
    const pcm = new Int16Array(samples)
    for (let at = 0; at < samples; at += 1) pcm[at] = bytes.readInt16LE(4 + at * 2)

    return { pcm, sampleRate }
  } catch {
    // Not stored, or unreadable. Either way it will be synthesised.
    return null
  }
}

/** Store a request's audio, replacing any earlier version atomically. */
export async function writeSpeech(request: SpeechRequest, speech: StoredSpeech): Promise<void> {
  if (!isCacheable(request) || speech.pcm.length === 0) return

  try {
    const { dir, file } = pathFor(request)
    await mkdir(dir, { recursive: true })

    const bytes = Buffer.alloc(4 + speech.pcm.length * 2)
    bytes.writeUInt32LE(speech.sampleRate, 0)
    for (let at = 0; at < speech.pcm.length; at += 1) {
      bytes.writeInt16LE(speech.pcm[at] ?? 0, 4 + at * 2)
    }

    // Through a temporary and renamed over, so a crash mid-write cannot leave a
    // truncated file that reads back as a sentence cut in half.
    const temporary = `${file}.tmp`
    await writeFile(temporary, bytes)
    await rename(temporary, file)
  } catch {
    // A failed write costs the time to synthesise it again, and nothing else.
  }
}

/** Whether a request's audio is already stored, without reading it. */
export async function hasSpeech(request: SpeechRequest): Promise<boolean> {
  if (!isCacheable(request)) return false
  try {
    return (await stat(pathFor(request).file)).size > 4
  } catch {
    return false
  }
}

export interface StoreSize {
  readonly files: number
  readonly bytes: number
}

/** How much disk the store is using, for the settings page to report. */
export async function speechStoreSize(): Promise<StoreSize> {
  let files = 0
  let bytes = 0

  try {
    const base = join(root, STORE_DIR)
    for (const bucket of await readdir(base)) {
      try {
        for (const name of await readdir(join(base, bucket))) {
          const info = await stat(join(base, bucket, name))
          if (!info.isFile()) continue
          files += 1
          bytes += info.size
        }
      } catch {
        // A bucket that vanished between listing and reading.
      }
    }
  } catch {
    return { files: 0, bytes: 0 }
  }

  return { files, bytes }
}

/** Delete everything stored. Offered because the store has no size limit. */
export async function clearSpeechStore(): Promise<void> {
  try {
    const base = join(root, STORE_DIR)
    for (const bucket of await readdir(base)) {
      try {
        for (const name of await readdir(join(base, bucket))) {
          await unlink(join(base, bucket, name))
        }
      } catch {
        // Already gone.
      }
    }
  } catch {
    // Nothing stored.
  }
}
