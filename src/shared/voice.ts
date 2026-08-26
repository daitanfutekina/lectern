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
 * Slightly slower and slightly flatter than a model's default: a long technical
 * passage wants steadiness, and expressiveness that charms for a paragraph is
 * tiring across an hour.
 */
export const BOOK_VOICE: VoiceShape = {
  lengthScale: 1.1,
  noiseScale: 0.6,
  noiseW: 0.7
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
