/**
 * Neural voice types, shared across the three processes. SPEC section 5.
 *
 * Kept here rather than in main because the renderer's picker, the settings it
 * writes, and the synthesiser that reads them all have to agree about what a
 * voice is and what can be adjusted about it.
 */

export interface PiperVoice {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly sampleRate: number
  readonly speakers: number
}

/**
 * What can be adjusted about a voice, and what each control does.
 *
 * These are the levers a VITS model exposes and there are no others, which is
 * worth stating plainly: "make it sound better" resolves to these three.
 */
export interface VoiceShape {
  /**
   * Phoneme duration. Longer is *slower*, which is the opposite of what the
   * name suggests, so the reader is shown a speed and it is inverted on the
   * way in.
   */
  readonly lengthScale: number
  /** Expressiveness. Low is flat and machine-like; high wanders. */
  readonly noiseScale: number
  /** Variation in timing. Low is metronomic; high is loose. */
  readonly noiseW: number
}

/**
 * Reading a textbook is not reading a novel.
 *
 * The number here was measured, not guessed. At Piper's own default the voice
 * reads at **182 words per minute**; the first attempt at a "book voice" used
 * 1.1 and managed 179, which is to say it changed nothing. Audiobook narration
 * sits around 150, and past roughly 180 it stops being restful -- which is
 * exactly what "they sound like they are about to run out of breath" describes.
 *
 * 1.35 measures at about 155 wpm on the same passage.
 */
export const BOOK_VOICE: VoiceShape = {
  lengthScale: 1.35,
  noiseScale: 0.667,
  noiseW: 0.8
}

/**
 * Silence after an utterance, in milliseconds.
 *
 * A browser speech engine puts a natural gap between utterances. A queue of
 * audio buffers played back to back has none at all, so every sentence begins
 * the instant the last one ends and the whole passage runs together -- the
 * other half of "no breath".
 *
 * The pause is chosen from how the sentence ended, because that is what the
 * punctuation is for.
 */
export function pauseAfter(text: string): number {
  const trimmed = text.trimEnd()
  if (/[.!?]["')\]]?$/.test(trimmed)) return 380
  if (/[:;]$/.test(trimmed)) return 300
  if (/,$/.test(trimmed)) return 180
  // A fragment with no terminator is usually a heading or a broken line, and
  // both want a beat before whatever follows.
  return 260
}

export const DEFAULT_VOICE_SHAPE: VoiceShape = {
  lengthScale: 1,
  noiseScale: 0.667,
  noiseW: 0.8
}

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min

/** Ranges a model actually behaves within. Outside them it distorts or drones. */
export function clampShape(shape: VoiceShape): VoiceShape {
  return {
    lengthScale: clamp(shape.lengthScale, 0.5, 2),
    noiseScale: clamp(shape.noiseScale, 0, 1),
    noiseW: clamp(shape.noiseW, 0, 1)
  }
}
