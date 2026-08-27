import { BOOK_VOICE, pauseAfter, type PiperVoice, type VoiceShape } from '@shared/voice'

/**
 * Playing neural speech. SPEC section 5.
 *
 * The main process synthesises and hands back raw PCM; this plays it. Two
 * engines therefore live behind one reader: the system voices, which speak for
 * themselves, and this, which is handed audio.
 *
 * The awkward part is that `speechSynthesis` reports word boundaries as it
 * speaks and a PCM buffer reports nothing at all. Word-follow is preserved by
 * estimating it from the audio's own duration, which is honest about what it is
 * -- a good guess, not a measurement.
 */

export interface NeuralUtterance {
  readonly text: string
  readonly voiceId: string
  readonly shape: VoiceShape
  readonly speed: number
  /** Scales the gap after this sentence; 0 runs it into the next. */
  readonly pauseScale?: number
  /** A character voice to convert into after synthesis, if any. */
  readonly character?: string | null
  /** Semitones to move the base voice before converting. */
  readonly semitones?: number
  /** How strongly to pull the conversion toward the character's own recordings. */
  readonly indexRate?: number
  /** How far to leave unvoiced sounds alone. */
  readonly protect?: number
}

export interface Playing {
  /** Resolves when playback finishes; rejects never. */
  readonly done: Promise<void>
  stop: () => void
}

let context: AudioContext | null = null

function audio(): AudioContext {
  // Created on first use: an AudioContext opened at startup is a device the
  // application holds for a session that may never play anything.
  context ??= new AudioContext()
  return context
}

export async function voices(): Promise<PiperVoice[]> {
  try {
    return await window.lectern.voice.list()
  } catch {
    return []
  }
}

export async function voiceFolder(): Promise<string> {
  try {
    return await window.lectern.voice.folder()
  } catch {
    return ''
  }
}

/** Words in an utterance, with where each one starts as a fraction of the whole. */
export interface WordTiming {
  readonly index: number
  readonly at: number
}

/**
 * Where each word falls, estimated from its length.
 *
 * A synthesiser that returns a buffer cannot say when it said what. Weighting
 * by character count is a better approximation than dividing the time evenly,
 * because "the" and "eigendecomposition" do not take the same time to say --
 * and it is what keeps the highlight roughly under the voice.
 */
export function estimateWordTimings(text: string): WordTiming[] {
  const words = [...text.matchAll(/\S+/g)]
  const total = words.reduce((sum, word) => sum + word[0].length + 1, 0)
  if (total === 0) return []

  const timings: WordTiming[] = []
  let sofar = 0
  for (const word of words) {
    timings.push({ index: word.index, at: sofar / total })
    sofar += word[0].length + 1
  }
  return timings
}

/**
 * Speak one utterance.
 *
 * `onWord` fires with the character offset of each word as it is estimated to
 * begin, so the reader's existing word-follow works unchanged.
 */
export interface Spoken {
  readonly pcm: Int16Array
  readonly sampleRate: number
}

/**
 * Generate the audio for an utterance without playing it.
 *
 * Split from playing so the *next* sentence can be made while the current one
 * is still speaking. That is not an optimisation. Piper synthesises at about
 * twenty times realtime, fast enough that generating on demand is never
 * noticed; Kokoro runs at about twice realtime, and generating on demand there
 * leaves a pause of roughly half a sentence before every single sentence.
 */
export async function synthesise(utterance: NeuralUtterance): Promise<Spoken | null> {
  const result = await window.lectern.voice.speak(
    utterance.voiceId,
    utterance.text,
    utterance.shape,
    utterance.speed,
    utterance.character ?? null,
    utterance.semitones ?? 0,
    utterance.indexRate ?? 0.75,
    utterance.protect ?? 0.33
  )
  return result && result.pcm.length > 0 ? result : null
}

export async function speak(
  utterance: NeuralUtterance,
  onWord?: (charIndex: number) => void,
  ready?: Spoken | null
): Promise<Playing> {
  // Use what was made ahead of time, when something looked ahead.
  const result = ready ?? (await synthesise(utterance))

  if (!result || result.pcm.length === 0) {
    return { done: Promise.resolve(), stop: () => {} }
  }

  const engine = audio()
  await engine.resume()

  const buffer = engine.createBuffer(1, result.pcm.length, result.sampleRate)
  const channel = buffer.getChannelData(0)
  for (let at = 0; at < result.pcm.length; at += 1) {
    channel[at] = (result.pcm[at] ?? 0) / 32768
  }

  const source = engine.createBufferSource()
  source.buffer = buffer
  source.connect(engine.destination)

  const timers: ReturnType<typeof setTimeout>[] = []
  if (onWord) {
    const duration = buffer.duration * 1000
    for (const timing of estimateWordTimings(utterance.text)) {
      timers.push(setTimeout(() => onWord(timing.index), timing.at * duration))
    }
  }

  let stopped = false
  let gap: ReturnType<typeof setTimeout> | null = null

  const done = new Promise<void>((resolve) => {
    source.addEventListener('ended', () => {
      for (const timer of timers) clearTimeout(timer)
      if (stopped) {
        resolve()
        return
      }
      /*
        A beat before the next sentence.

        A browser speech engine leaves a natural gap between utterances; a queue
        of audio buffers played back to back leaves none, so every sentence
        starts the instant the last one ends and the passage runs together.
      */
      gap = setTimeout(resolve, pauseAfter(utterance.text) * (utterance.pauseScale ?? 1))
    })
  })

  source.start()

  return {
    done,
    stop: () => {
      if (stopped) return
      stopped = true
      for (const timer of timers) clearTimeout(timer)
      if (gap) clearTimeout(gap)
      try {
        source.stop()
      } catch {
        // Already finished.
      }
    }
  }
}

export { BOOK_VOICE }
