/**
 * Speech synthesis, in a plain Node process.
 *
 * This exists because of one hard constraint: Electron builds V8 with its
 * sandbox enabled, and a sandboxed V8 refuses the external `ArrayBuffer` that
 * sherpa-onnx returns from `generate`. Loading a model inside Electron works
 * fine; asking it for audio throws "External buffers are not allowed", and it
 * throws the same way under `ELECTRON_RUN_AS_NODE`, because that is still the
 * Electron binary and still the same V8.
 *
 * So synthesis happens here, in a real Node process, and the audio is handed
 * back over stdout.
 *
 * The character-voice conversion lives here too rather than in a second
 * process. It is a post-process on audio this worker has just produced, and
 * putting it behind another pipe would mean sending every sentence out and
 * straight back in for no gain.
 *
 * Protocol, newline-delimited JSON in both directions:
 *   in   { id, text, speed, character?, semitones? }
 *   out  { id, ok: true, sampleRate, pcm }   pcm is base64 16-bit LE
 *        { id, ok: false, error }
 *        { ready: true, sampleRate }         once, at startup
 */

import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { convert, loadCharacter, type Character } from './rvc-runtime'

const argv = process.argv.slice(2)
const voiceDir = argv[0]
const lengthScale = Number(argv[1]) || 1
const noiseScale = Number(argv[2]) || 0.667
const noiseW = Number(argv[3]) || 0.8
/** Where the conversion models live; absent means character voices are off. */
const rvcDir = argv[4] ?? ''
/** Which synthesiser this folder holds. Piper unless told otherwise. */
const engine = argv[5] === 'kokoro' ? 'kokoro' : 'piper'
/** Which English dictionary to read with; empty means whatever the model ships. */
const lexiconLang = argv[6] === 'gb' ? 'gb' : argv[6] === 'us' ? 'us' : ''

function fail(message: string): never {
  process.stdout.write(`${JSON.stringify({ ready: false, error: message })}\n`)
  process.exit(1)
}

if (!voiceDir) fail('no voice directory given')

interface Tts {
  readonly sampleRate: number
  readonly numSpeakers: number
  generate(options: { text: string; sid: number; speed: number }): {
    samples: Float32Array
    sampleRate: number
  }
}

let tts: Tts
try {
  const files = readdirSync(voiceDir)
  const model = files.find((file) => file.endsWith('.onnx'))
  if (!model) fail(`no .onnx model in ${voiceDir}`)

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sherpa = require('sherpa-onnx-node')

  /*
    Two engines, one interface.

    Kokoro takes only a length scale: it has no noise controls at all, which is
    part of why it is steadier than Piper. Piper samples both its duration
    predictor and its flow, so the same sentence comes out at a different length
    every time -- measured at a 258 ms spread over five takes -- and a stumble
    over a long word is that sampling landing badly rather than anything about
    the word.

    The lexicons matter more than they look. Kokoro falls back to espeak for
    anything it does not recognise, and espeak is where the mispronunciations
    live, so the English lexicon is loaded when the model ships one.
  */
  const config =
    engine === 'kokoro'
      ? {
          kokoro: {
            model: join(voiceDir, model),
            voices: join(voiceDir, 'voices.bin'),
            tokens: join(voiceDir, 'tokens.txt'),
            dataDir: join(voiceDir, 'espeak-ng-data'),
            dictDir: files.includes('dict') ? join(voiceDir, 'dict') : '',
            lexicon: files
              .filter((file) =>
                lexiconLang
                  ? file === `lexicon-${lexiconLang}-en.txt`
                  : /^lexicon-us-en\.txt$/.test(file)
              )
              .map((file) => join(voiceDir, file))
              .join(','),
            lengthScale
          }
        }
      : {
          vits: {
            model: join(voiceDir, model),
            tokens: join(voiceDir, 'tokens.txt'),
            dataDir: join(voiceDir, 'espeak-ng-data'),
            lengthScale,
            noiseScale,
            noiseScaleW: noiseW
          }
        }

  tts = new sherpa.OfflineTts({
    model: { ...config, numThreads: 2, debug: false, provider: 'cpu' },
    maxNumSentences: 1
  }) as Tts
} catch (error) {
  fail(String(error).slice(0, 300))
}

process.stdout.write(
  `${JSON.stringify({ ready: true, sampleRate: tts.sampleRate, speakers: tts.numSpeakers })}\n`
)

/*
  Conversion models are loaded on first use, not at startup.

  They are three quarters of a gigabyte between them. A reader who never picks
  a character voice should never pay for that, and one who does pays once --
  the loaded session is kept for the life of the worker.
*/
const characters = new Map<string, Promise<Character | null>>()

function character(name: string): Promise<Character | null> {
  const cached = characters.get(name)
  if (cached) return cached

  // The promise is cached, not the result: two sentences arriving while the
  // models are still loading must wait on the one load, not start a second.
  const loading = (rvcDir ? loadCharacter(rvcDir, name) : Promise.resolve(null)).catch(
    (error: unknown) => {
      process.stderr.write(`character voice ${name} unavailable: ${String(error).slice(0, 200)}\n`)
      return null
    }
  )
  characters.set(name, loading)
  return loading
}

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffered += chunk

  let newline = buffered.indexOf('\n')
  while (newline >= 0) {
    const line = buffered.slice(0, newline)
    buffered = buffered.slice(newline + 1)
    if (line.trim()) void handle(line)
    newline = buffered.indexOf('\n')
  }
})

interface Request {
  id?: number
  text?: string
  speed?: number
  /** Which speaker inside the model. Kokoro carries many; Piper has one. */
  speaker?: number
  character?: string
  semitones?: number
}

async function handle(line: string): Promise<void> {
  let request: Request
  try {
    request = JSON.parse(line) as Request
  } catch {
    return
  }

  try {
    const spoken = tts.generate({
      text: String(request.text ?? ''),
      sid: Number(request.speaker) || 0,
      speed: Number(request.speed) || 1
    })

    let samples = spoken.samples
    let sampleRate = spoken.sampleRate

    if (request.character) {
      const voice = await character(request.character)
      if (voice) {
        const converted = await convert(voice, samples, sampleRate, request.semitones ?? 0)
        samples = converted.samples
        sampleRate = converted.sampleRate
      }
    }

    // 16-bit LE, which is what an AudioContext wants and half the bytes of
    // Float32 across the pipe.
    const pcm = Buffer.alloc(samples.length * 2)
    for (let at = 0; at < samples.length; at += 1) {
      const sample = Math.max(-1, Math.min(1, samples[at] ?? 0))
      pcm.writeInt16LE(Math.round(sample * 32767), at * 2)
    }

    process.stdout.write(
      `${JSON.stringify({ id: request.id, ok: true, sampleRate, pcm: pcm.toString('base64') })}\n`
    )
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, ok: false, error: String(error).slice(0, 200) })}\n`
    )
  }
}
