import { createRequire } from 'node:module'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Neural speech, offline. SPEC section 5.
 *
 * The Windows system voices are the ones every screen reader has used for
 * fifteen years, and nobody wants to listen to a textbook read by them. Piper
 * is the free, local, neural alternative the spec named as the upgrade path and
 * then deferred.
 *
 * It runs through sherpa-onnx in the main process rather than through one of
 * the browser WASM builds, for one reason: every browser build fetches its
 * runtime and its voices from a CDN at load time, and SPEC invariant 2 does not
 * allow that. Here a voice is a folder of files on disk and nothing is ever
 * fetched.
 *
 * Voices live in `<library>/.library/voices/<name>/`, each holding the model,
 * its tokens, and the phoniser data:
 *
 *   voices/en_GB-alba-medium/
 *     model.onnx
 *     tokens.txt
 *     espeak-ng-data/
 */

import { BOOK_VOICE, type PiperVoice, type VoiceShape } from '@shared/voice'

const require = createRequire(import.meta.url)

export { BOOK_VOICE }

type TtsHandle = {
  sampleRate: number
  numSpeakers: number
  generate: (options: { text: string; sid: number; speed: number }) => {
    samples: Float32Array
    sampleRate: number
  }
}

let root = ''

export function configurePiper(libraryRoot: string): void {
  root = libraryRoot
  loaded.clear()
}

const voicesDir = (): string => join(root, '.library', 'voices')

/**
 * Voices present on disk.
 *
 * A folder is a voice when it holds a model and its tokens. Anything else is
 * ignored silently -- a half-downloaded voice should not appear in a picker.
 */
export async function listVoices(): Promise<PiperVoice[]> {
  let names: string[] = []
  try {
    names = await readdir(voicesDir())
  } catch {
    return []
  }

  const found: PiperVoice[] = []
  for (const name of names) {
    const path = join(voicesDir(), name)
    try {
      if (!(await stat(path)).isDirectory()) continue
      const files = await readdir(path)
      const model = files.find((file) => file.endsWith('.onnx'))
      const tokens = files.find((file) => file === 'tokens.txt')
      if (!model || !tokens) continue

      found.push({
        id: name,
        name: prettyName(name),
        path,
        sampleRate: 22050,
        speakers: 1
      })
    } catch {
      // Unreadable folder; not a voice as far as the picker is concerned.
    }
  }
  return found
}

/** `en_GB-alba-medium` reads better as `Alba (en GB, medium)`. */
function prettyName(id: string): string {
  const match = /^([a-z]{2})[_-]([A-Z]{2})-(.+?)-(.+)$/.exec(id)
  if (!match) return id
  const [, language, region, voice, quality] = match
  return `${(voice ?? '').replace(/_/g, ' ')} (${language} ${region}, ${quality})`
}

const loaded = new Map<string, TtsHandle>()

function open(voice: PiperVoice, shape: VoiceShape): TtsHandle | null {
  const key = `${voice.id}|${shape.lengthScale}|${shape.noiseScale}|${shape.noiseW}`
  const cached = loaded.get(key)
  if (cached) return cached

  try {
    const sherpa = require('sherpa-onnx-node') as {
      OfflineTts: new (config: unknown) => TtsHandle
    }

    const files = require('node:fs').readdirSync(voice.path) as string[]
    const model = files.find((file: string) => file.endsWith('.onnx'))
    if (!model) return null

    const handle = new sherpa.OfflineTts({
      model: {
        vits: {
          model: join(voice.path, model),
          tokens: join(voice.path, 'tokens.txt'),
          dataDir: join(voice.path, 'espeak-ng-data'),
          lengthScale: shape.lengthScale,
          noiseScale: shape.noiseScale,
          noiseScaleW: shape.noiseW
        },
        numThreads: 2,
        debug: false,
        provider: 'cpu'
      },
      maxNumSentences: 1
    })

    loaded.set(key, handle)
    return handle
  } catch (error) {
    process.stderr.write(`piper voice unavailable: ${String(error)}\n`)
    return null
  }
}

export interface Spoken {
  /** 16-bit PCM, which is what an AudioContext can be handed directly. */
  readonly pcm: Int16Array
  readonly sampleRate: number
}

/**
 * Synthesise one utterance.
 *
 * Returned as PCM rather than played here: the main process has no audio
 * output, and the renderer already owns playback, timing and the queue.
 */
export async function speak(
  voiceId: string,
  text: string,
  shape: VoiceShape,
  speed: number
): Promise<Spoken | null> {
  const voice = (await listVoices()).find((entry) => entry.id === voiceId)
  if (!voice) return null

  const handle = open(voice, shape)
  if (!handle) return null

  try {
    const result = handle.generate({ text, sid: 0, speed })
    // Float32 in, Int16 out: a Float32Array crosses IPC at twice the size for
    // no gain, and 16-bit is what the audio graph wants anyway.
    const pcm = new Int16Array(result.samples.length)
    for (let at = 0; at < result.samples.length; at += 1) {
      const sample = Math.max(-1, Math.min(1, result.samples[at] ?? 0))
      pcm[at] = Math.round(sample * 32767)
    }
    return { pcm, sampleRate: result.sampleRate }
  } catch (error) {
    process.stderr.write(`piper failed on "${text.slice(0, 40)}": ${String(error)}\n`)
    return null
  }
}
