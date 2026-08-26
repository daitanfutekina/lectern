import { readdirSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'
import { melFilterbank, resample, stftMagnitude } from '@shared/dsp'
import {
  CONTENT_MODEL,
  FRAME_RATE,
  PITCH_MODEL,
  RMVPE_MEL,
  coarsePitch,
  commonLength,
  decodePitch,
  logMel,
  padFrames,
  transpose,
  upsampleFeatures
} from '@shared/rvc'

/**
 * Character voices, by voice conversion. SPEC section 5.
 *
 * Piper decides *what is said* and how it is paced; this decides *who says it*.
 * The two are separable because a converter works on speech rather than on
 * text: it hears a sentence, strips out everything that identifies the speaker,
 * and re-synthesises the remainder in another voice.
 *
 * That separation is the whole reason this approach was chosen. Almost every
 * available Kasane Teto model is Japanese, and an English textbook read by a
 * Japanese synthesiser is unusable. Converting Piper's English keeps the
 * pronunciation of a voice trained on English and the timbre of one that was
 * not.
 *
 * Three networks, in order:
 *
 *   ContentVec  speech -> what was said, stripped of who said it (768 numbers
 *               per 20 ms, and famously not enough to identify a speaker from)
 *   RMVPE       speech -> the pitch it was said at, robustly enough to survive
 *               a synthesiser's flat delivery
 *   the voice   both of those -> the same words, in the trained voice
 *
 * Everything between them -- resampling, the spectrogram RMVPE reads, the bins
 * the pitch is quantised into, the frame alignment -- is in `@shared/rvc` and
 * `@shared/dsp`, tested without a model present. This file only moves tensors.
 */

/** ContentVec and RMVPE are shared by every character; only the last model differs. */
export interface Character {
  readonly content: ort.InferenceSession
  readonly pitch: ort.InferenceSession
  readonly voice: ort.InferenceSession
}

export interface Converted {
  readonly samples: Float32Array
  readonly sampleRate: number
}

/*
  The mel filterbank is built once.

  It depends on nothing but constants, and rebuilding a 128 x 513 matrix for
  every sentence would be the most expensive arithmetic in a module whose real
  work is done by three neural networks.
*/
const FILTERS = melFilterbank(
  RMVPE_MEL.sampleRate,
  RMVPE_MEL.fftSize,
  RMVPE_MEL.mels,
  RMVPE_MEL.fMin,
  RMVPE_MEL.fMax
)

/** RMVPE downsamples by 32 internally and rejects a length that does not divide. */
const RMVPE_BLOCK = 32

/** Below this confidence a frame is silence or a consonant, and has no pitch. */
const VOICED_THRESHOLD = 0.03

/**
 * Half the logical cores, capped.
 *
 * The vocoder is three quarters of the work and it threads well, but only up to
 * a point: measured on a 32-thread machine it ran a six-second sentence in 6.0s
 * on the runtime's default, 2.9s at sixteen threads, and 9.0s at thirty-two --
 * past the physical core count the threads spend their time contending rather
 * than working. Half the logical count lands on the physical count on every
 * machine that reports hyperthreading, and it leaves the other half for the
 * reader, who is reading while this runs.
 */
const THREADS = Math.max(1, Math.min(16, Math.floor(cpus().length / 2)))

const OPTIONS: ort.InferenceSession.SessionOptions = {
  intraOpNumThreads: THREADS,
  executionMode: 'sequential'
}

/**
 * Load the three models for one character.
 *
 * `dir` is the conversion folder; `name` is a subfolder of it holding that
 * character's converted model. The two shared models sit at the top level
 * because they are the same for every voice and are 700 MB between them.
 */
export async function loadCharacter(dir: string, name: string): Promise<Character> {
  const folder = join(dir, name)
  const model = readdirSync(folder).find((file) => file.toLowerCase().endsWith('.onnx'))
  if (!model) throw new Error(`no .onnx model in ${folder}`)

  const [content, pitch, voice] = await Promise.all([
    ort.InferenceSession.create(join(dir, CONTENT_MODEL), OPTIONS),
    ort.InferenceSession.create(join(dir, PITCH_MODEL), OPTIONS),
    ort.InferenceSession.create(join(folder, model), OPTIONS)
  ])

  return { content, pitch, voice }
}

/* -- The chain ------------------------------------------------------------ */

/** What was said, at 50 frames a second, with the speaker stripped out. */
async function contentOf(
  session: ort.InferenceSession,
  audio: Float32Array
): Promise<{ features: Float32Array; frames: number; dim: number }> {
  const input = new ort.Tensor('float32', audio, [1, 1, audio.length])
  const output = await session.run({ source: input })
  const embed = output[session.outputNames[0] ?? 'embed']
  if (!embed) throw new Error('content encoder produced nothing')

  const dims = embed.dims as number[]
  return {
    features: embed.data as Float32Array,
    frames: dims[1] ?? 0,
    dim: dims[2] ?? 768
  }
}

/** The pitch it was said at, at 100 frames a second, zero where unvoiced. */
async function pitchOf(
  session: ort.InferenceSession,
  audio: Float32Array
): Promise<Float32Array> {
  const { magnitude, bins, frames } = stftMagnitude(audio, RMVPE_MEL.fftSize, RMVPE_MEL.hop)
  const mel = logMel(magnitude, bins, frames, FILTERS, RMVPE_MEL.mels, RMVPE_MEL.clamp)
  const padded = padFrames(mel, RMVPE_MEL.mels, frames, RMVPE_BLOCK)

  const input = new ort.Tensor('float32', padded.mel, [1, RMVPE_MEL.mels, padded.frames])
  const output = await session.run({ input })
  const salience = output[session.outputNames[0] ?? 'output']
  if (!salience) throw new Error('pitch tracker produced nothing')

  // The padding was only there to satisfy the network's stride; the frames it
  // produced for it describe silence that is not in the audio.
  return decodePitch(salience.data as Float32Array, frames, VOICED_THRESHOLD)
}

/**
 * Speak `samples` in a character's voice.
 *
 * `semitones` shifts the pitch before conversion. It exists because a converter
 * reproduces timbre, not range: a voice trained on a high register given a low
 * pitch track sounds like that voice straining, so the base voice has to be
 * moved into the character's range first.
 */
export async function convert(
  character: Character,
  samples: Float32Array,
  sampleRate: number,
  semitones: number
): Promise<Converted> {
  // Both analysis models were trained at 16 kHz and neither is tolerant of
  // being fed something else.
  const audio = resample(samples, sampleRate, RMVPE_MEL.sampleRate)

  // The two analyses are independent, and each is mostly waiting on the
  // runtime's own threads.
  const [content, f0] = await Promise.all([
    contentOf(character.content, audio),
    pitchOf(character.pitch, audio)
  ])

  const phone = upsampleFeatures(content.features, content.frames, content.dim)
  const shifted = transpose(f0, semitones)

  /*
    One length for all three inputs.

    The content encoder drops a frame at the end and the spectrogram gains one
    from being centred, so the two analyses disagree by a few frames. The
    shortest is the only length every input actually has data for.
  */
  const frames = commonLength(content.frames * 2, shifted.length)
  if (frames === 0) return { samples: new Float32Array(0), sampleRate }

  const nsff0 = shifted.subarray(0, frames)
  const coarse = coarsePitch(nsff0)

  const output = await character.voice.run({
    phone: new ort.Tensor('float32', phone.subarray(0, frames * content.dim), [
      1,
      frames,
      content.dim
    ]),
    phone_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]),
    pitch: new ort.Tensor('int64', coarse, [1, frames]),
    nsff0: new ort.Tensor('float32', Float32Array.from(nsff0), [1, frames]),
    // Single-speaker models still take a speaker id, and it is always zero.
    sid: new ort.Tensor('int64', BigInt64Array.from([0n]), [1])
  })

  const audioOut = output['audio']
  if (!audioOut) throw new Error('voice model produced nothing')

  /*
    The model reports its own output rate.

    It is a property of what the voice was trained on -- this one is 32 kHz,
    others are 40 or 48 -- and guessing it wrong does not fail, it just plays
    the sentence at the wrong speed and pitch.
  */
  const reported = output['sr']?.data
  const rate =
    reported && reported.length > 0 ? Number((reported as BigInt64Array | Float32Array)[0]) : 32000

  return { samples: Float32Array.from(audioOut.data as Float32Array), sampleRate: rate }
}

/** How long a converted second of speech is, for sizing a background queue. */
export const FRAMES_PER_SECOND = FRAME_RATE
