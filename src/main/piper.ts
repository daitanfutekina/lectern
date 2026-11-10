import { createRequire } from 'node:module'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
import { CONTENT_MODEL, PITCH_MODEL } from '@shared/rvc'

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
 * That was the open question for packaging, and the answer is that a Node has
 * to travel with the application: see `nodeBinary` below.
 */

let root = ''

export function configurePiper(libraryRoot: string): void {
  root = libraryRoot
  void shutdownPiper()
}

/**
 * Which binary runs the synthesis worker.
 *
 * Not Electron's. `ELECTRON_RUN_AS_NODE` gets as far as loading the models and
 * reporting ready, and then every utterance comes back "External buffers are
 * not allowed": V8's sandbox is compiled into Electron and rejects the memory
 * sherpa-onnx and the ONNX runtime hand back, which is the reason this is a
 * separate process in the first place. Measured against the packaged build,
 * same worker and same voice -- node.exe returns PCM, Electron-as-node returns
 * that error.
 *
 * So a Node is shipped beside the application (build-tools/stage-node.mjs) and
 * used when it is there. In development it is not, and the one on PATH runs
 * instead -- which is also the fallback if the packaged copy ever goes missing,
 * because a machine with Node is better served than one told nothing.
 */
function nodeBinary(): string {
  const bundled = join(process.resourcesPath, process.platform === 'win32' ? 'node.exe' : 'node')
  return existsSync(bundled) ? bundled : 'node'
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
 * Character folders that actually hold a model.
 *
 * Read here rather than in the worker, even though the worker is what loads
 * them: importing the worker to ask a question about a directory would pull the
 * ONNX runtime into Electron, which is the one thing the worker exists to keep
 * out of it.
 */
export async function listCharacters(): Promise<string[]> {
  let entries: string[] = []
  try {
    entries = await readdir(characterDir())
  } catch {
    return []
  }

  const found: string[] = []
  for (const name of entries) {
    try {
      const path = join(characterDir(), name)
      if (!(await stat(path)).isDirectory()) continue
      if ((await readdir(path)).some((file) => file.toLowerCase().endsWith('.onnx'))) {
        found.push(name)
      }
    } catch {
      // Not a character as far as the picker is concerned.
    }
  }
  return found
}

/**
 * Whether the two shared models every character runs through are present.
 *
 * A separate question from whether any characters are installed: they are 700
 * MB and downloaded separately, so a reader can easily have one without the
 * other. Offering a voice that would silently do nothing is worse than saying
 * what is missing.
 */
export async function charactersReady(): Promise<boolean> {
  try {
    const files = await readdir(characterDir())
    return files.includes(CONTENT_MODEL) && files.includes(PITCH_MODEL)
  } catch {
    return false
  }
}

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

      /*
        A Kokoro folder carries its speakers in `voices.bin`, which is what
        tells the two engines apart -- a Piper folder has one speaker and no
        such file. One Kokoro model holds dozens, so it becomes dozens of
        entries in the picker rather than one.
      */
      if (files.includes('voices.bin')) {
        for (const speaker of await kokoroSpeakers(path)) {
          found.push({
            id: `${name}#${speaker.id}`,
            name: prettyKokoro(speaker.name),
            path,
            sampleRate: 24000,
            speakers: 1,
            engine: 'kokoro',
            speaker: speaker.id,
            lexicon: lexiconFor(speaker.name)
          })
        }
        continue
      }

      found.push({
        id: name,
        name: prettyName(name),
        path,
        sampleRate: 22050,
        speakers: 1,
        engine: 'piper',
        speaker: 0
      })
    } catch {
      // Unreadable folder; not a voice as far as the picker is concerned.
    }
  }
  return found
}

/**
 * The speakers inside a Kokoro model, named where the model says what they are.
 *
 * Kokoro ships a `voices.bin` of speaker embeddings and, in the sherpa builds,
 * a `voices.txt` listing their names in the same order. Without the names the
 * picker would offer "Speaker 27", which tells a reader nothing about whether
 * they want to listen to it.
 */
async function kokoroSpeakers(path: string): Promise<{ id: number; name: string }[]> {
  try {
    const listing = await readFile(join(path, 'voices.txt'), 'utf8')
    const names = listing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (names.length > 0) return names.map((name, id) => ({ id, name }))
  } catch {
    // No listing; fall through to numbering them.
  }

  // The model still works without names, so it is offered anyway.
  return [{ id: 0, name: 'Kokoro' }]
}

/**
 * Which English lexicon a Kokoro voice should be read with.
 *
 * Kokoro's own name says: `a` is American and `b` is British. The accent lives
 * in the speaker embedding, but the *pronunciation* comes from the lexicon, and
 * pairing a British speaker with an American dictionary gets the vowels wrong
 * in exactly the words a reader would notice.
 */
export function lexiconFor(voiceName: string): 'us' | 'gb' {
  return voiceName.startsWith('b') ? 'gb' : 'us'
}

/**
 * `af_heart` reads better as `Heart (American, female)`.
 *
 * Kokoro's names encode the accent and the speaker's voice type in the two
 * letters before the underscore, which is exactly the information a reader
 * choosing a narrator wants and would otherwise have to look up.
 */
function prettyKokoro(name: string): string {
  const match = /^([abefhijpz])([fm])_(.+)$/.exec(name)
  if (!match) return name

  const [, region = '', sex = '', rest = ''] = match
  const accents: Record<string, string> = {
    a: 'American',
    b: 'British',
    e: 'Spanish',
    f: 'French',
    h: 'Hindi',
    i: 'Italian',
    j: 'Japanese',
    p: 'Portuguese',
    z: 'Chinese'
  }
  const label = `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`
  return `${label} (${accents[region] ?? region}, ${sex === 'f' ? 'female' : 'male'})`
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

/*
  A worker is reused only while nothing it baked in has changed.

  The engine and the model folder decide which model is loaded; the shape is
  baked in at load time for Piper. The speaker is *not* here on purpose: Kokoro
  picks it per sentence, so switching narrator inside one model costs nothing.
*/
const shapeKey = (voice: PiperVoice, shape: VoiceShape): string =>
  `${voice.engine}|${voice.path}|${voice.lexicon ?? ''}|` +
  `${shape.lengthScale}|${shape.noiseScale}|${shape.noiseW}`

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
      nodeBinary(),
      [
        script,
        voice.path,
        String(shape.lengthScale),
        String(shape.noiseScale),
        String(shape.noiseW),
        characterDir(),
        voice.engine,
        voice.lexicon ?? ''
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
  readonly indexRate: number
  readonly protect: number
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
        speaker: voice.speaker,
        character: character?.name,
        semitones: character?.semitones ?? 0,
        indexRate: character?.indexRate ?? 0.75,
        protect: character?.protect ?? 0.33
      }
      active.process.stdin.write(`${JSON.stringify(request)}\n`)
    } catch {
      active.pending.delete(id)
      resolve(null)
    }
    /*
      A worker that dies mid-sentence must not leave the reader waiting.

      Conversion gets far longer, because the first sentence in a character
      voice pays for loading three quarters of a gigabyte of models before it
      synthesises anything. Cutting that off at thirty seconds would make the
      feature look broken exactly once per session, which is the worst possible
      time for it to.
    */
    setTimeout(
      () => {
        if (active.pending.delete(id)) resolve(null)
      },
      character ? 300_000 : 30_000
    )
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
