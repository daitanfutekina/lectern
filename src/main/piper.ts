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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * Synthesis runs in a separate Node process.
 *
 * Electron builds V8 with its sandbox on, and a sandboxed V8 refuses the
 * external `ArrayBuffer` sherpa-onnx hands back from `generate` -- including
 * under `ELECTRON_RUN_AS_NODE`, which is still the same binary and the same V8.
 * Loading the model works; asking for audio throws "External buffers are not
 * allowed". A real Node process has no such restriction, and synthesis there
 * runs at about twenty times realtime.
 *
 * The cost is a dependency on `node` being on PATH, which is fine while running
 * from source and is the open question for packaging.
 */

let root = ''

export function configurePiper(libraryRoot: string): void {
  root = libraryRoot
  void shutdownPiper()
}

const voicesDir = (): string => join(root, '.library', 'voices')

/**
 * Where the voice-conversion models live.
 *
 * Kept apart from `voices` because they are a different kind of thing: a Piper
 * voice speaks, and these change who is speaking. They are also enormous, and a
 * reader who never asks for a character voice never needs them on disk at all.
 */
export const characterDir = (): string => join(root, '.library', 'rvc')

/**
 * Voices present on disk.
 *
 * A folder is a voice when it holds a model and its tokens. Anything else is
 * ignored silently -- a half-extracted voice should not appear in a picker.
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
      if (!files.some((file) => file.endsWith('.onnx'))) continue
      if (!files.includes('tokens.txt')) continue

      found.push({ id: name, name: prettyName(name), path, sampleRate: 22050, speakers: 1 })
    } catch {
      // Unreadable folder; not a voice as far as the picker is concerned.
    }
  }
  return found
}

/** `vits-piper-en_GB-alba-medium` reads better as `Alba (en GB, medium)`. */
function prettyName(id: string): string {
  const match = /^(?:vits-piper-)?([a-z]{2})[_-]([A-Z]{2})-(.+?)-(.+)$/.exec(id)
  if (!match) return id
  const [, language, region, voice, quality] = match
  const name = (voice ?? '').replace(/_/g, ' ')
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} (${language} ${region}, ${quality})`
}

interface Worker {
  readonly process: ChildProcessWithoutNullStreams
  readonly key: string
  readonly ready: Promise<boolean>
  readonly pending: Map<number, (value: Spoken | null) => void>
  sampleRate: number
}

let worker: Worker | null = null
let nextId = 1

const shapeKey = (voice: PiperVoice, shape: VoiceShape): string =>
  `${voice.id}|${shape.lengthScale}|${shape.noiseScale}|${shape.noiseW}`

/**
 * Start a worker for a voice and shape, replacing one running with different
 * settings. The shape is baked into the model at load time, so a change means a
 * restart -- cheap, at about a second.
 */
function ensureWorker(voice: PiperVoice, shape: VoiceShape): Worker | null {
  const key = shapeKey(voice, shape)
  if (worker && worker.key === key) return worker

  void shutdownPiper()

  try {
    // Built alongside the main process rather than kept as a hand-written
    // script, so it can share the signal processing in `@shared` instead of
    // carrying a second copy of it.
    const script = join(__dirname, 'voice-worker.js')
    const child = spawn(
      'node',
      [
        script,
        voice.path,
        String(shape.lengthScale),
        String(shape.noiseScale),
        String(shape.noiseW),
        characterDir()
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )

    const pending = new Map<number, (value: Spoken | null) => void>()
    let buffered = ''

    const ready = new Promise<boolean>((resolve) => {
      const onData = (chunk: Buffer): void => {
        buffered += chunk.toString('utf8')
        let newline = buffered.indexOf('\n')
        while (newline >= 0) {
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          if (line.trim()) {
            const message = parse(line)
            if (message && 'ready' in message) resolve(Boolean(message['ready']))
            else if (message) settle(pending, message)
          }
          newline = buffered.indexOf('\n')
        }
      }
      child.stdout.on('data', onData)
      child.once('error', () => resolve(false))
      child.once('exit', () => {
        resolve(false)
        for (const resolveOne of pending.values()) resolveOne(null)
        pending.clear()
        if (worker?.process === child) worker = null
      })
    })

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) process.stderr.write(`piper: ${text.slice(0, 200)}\n`)
    })

    worker = { process: child, key, ready, pending, sampleRate: 22050 }
    return worker
  } catch (error) {
    process.stderr.write(`piper unavailable: ${String(error)}\n`)
    return null
  }
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function settle(
  pending: Map<number, (value: Spoken | null) => void>,
  message: Record<string, unknown>
): void {
  const id = typeof message['id'] === 'number' ? message['id'] : -1
  const resolveOne = pending.get(id)
  if (!resolveOne) return
  pending.delete(id)

  if (message['ok'] !== true || typeof message['pcm'] !== 'string') {
    resolveOne(null)
    return
  }

  const bytes = Buffer.from(message['pcm'], 'base64')
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  resolveOne({
    pcm: Int16Array.from(pcm),
    sampleRate: typeof message['sampleRate'] === 'number' ? message['sampleRate'] : 22050
  })
}

/** A character voice to convert into, and how far to move the base voice first. */
export interface CharacterRequest {
  readonly name: string
  readonly semitones: number
}

export interface Spoken {
  /** 16-bit PCM, which is what an AudioContext can be handed directly. */
  readonly pcm: Int16Array
  readonly sampleRate: number
}

/** Synthesise one utterance, or null when no voice is available. */
export async function speak(
  voiceId: string,
  text: string,
  shape: VoiceShape,
  speed: number,
  character?: CharacterRequest
): Promise<Spoken | null> {
  const voice = (await listVoices()).find((entry) => entry.id === voiceId)
  if (!voice) return null

  const active = ensureWorker(voice, shape)
  if (!active) return null
  if (!(await active.ready)) return null

  const id = nextId
  nextId += 1

  return new Promise<Spoken | null>((resolve) => {
    active.pending.set(id, resolve)
    try {
      const request = {
        id,
        text,
        speed,
        character: character?.name,
        semitones: character?.semitones ?? 0
      }
      active.process.stdin.write(`${JSON.stringify(request)}\n`)
    } catch {
      active.pending.delete(id)
      resolve(null)
    }
    // A worker that dies mid-sentence must not leave the reader waiting.
    setTimeout(() => {
      if (active.pending.delete(id)) resolve(null)
    }, 30_000)
  })
}

export async function shutdownPiper(): Promise<void> {
  const active = worker
  worker = null
  if (!active) return
  for (const resolveOne of active.pending.values()) resolveOne(null)
  active.pending.clear()
  try {
    active.process.kill()
  } catch {
    // Already gone.
  }
}
