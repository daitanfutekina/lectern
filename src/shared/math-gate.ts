/**
 * Which equations are worth hearing.
 *
 * SPEC section 5. The rule the reader gave: a statistical definition or a
 * simple relation should be spoken in full; a triple integral should be
 * announced and left on screen to be read with the eyes.
 *
 * The gate is a heuristic and will be wrong sometimes. It is tunable, and the
 * threshold is a setting rather than a constant buried in the code.
 */

export interface GateSettings {
  /** Longest spoken form worth listening to, in words. */
  readonly maxWords: number
  /** Speak inline mathematics regardless of length. */
  readonly alwaysSpeakInline: boolean
}

export const DEFAULT_GATE: GateSettings = {
  // Around fifteen seconds of speech. Past that a listener has lost the start
  // of the equation before the end arrives, which is the actual failure.
  maxWords: 40,
  // Inline mathematics is inline because it is short, and it sits inside a
  // sentence -- skipping it leaves a hole in the prose rather than a gap
  // between paragraphs.
  alwaysSpeakInline: true
}

export type GateVerdict =
  | { readonly speak: true }
  | { readonly speak: false; readonly reason: 'multi-line' | 'too-long' | 'no-speech' }

/**
 * Environments that are several equations stacked up. Read aloud they run
 * together into one unfollowable sentence, and the reader is looking at a
 * derivation they can see laid out far more clearly than they can hear it.
 */
const MULTI_LINE = /\\begin\{(align|aligned|alignat|gather|gathered|cases|eqnarray|split|multline)\*?\}/

/** What the reader hears in place of a deferred equation. */
export const DEFERRED_PHRASE: Readonly<Record<'multi-line' | 'too-long' | 'no-speech', string>> = {
  'multi-line': 'A displayed derivation follows on screen.',
  'too-long': 'A displayed equation follows on screen.',
  'no-speech': 'A displayed equation follows on screen.'
}

const wordCount = (text: string): number => (text.match(/\S+/g) ?? []).length

/**
 * Judge one equation.
 *
 * The primary signal is the **length of the generated speech**, not the length
 * of the LaTeX. They differ a lot -- a short `\frac{1}{n}\sum` expands to a
 * dozen spoken words, while a long `\begin{bmatrix}` of single digits stays
 * short -- and it is the spoken length that decides whether a listener can
 * follow it.
 */
export function gate(
  latex: string,
  speech: string | null,
  display: boolean,
  settings: GateSettings = DEFAULT_GATE
): GateVerdict {
  if (!speech || !speech.trim()) return { speak: false, reason: 'no-speech' }

  if (!display && settings.alwaysSpeakInline) return { speak: true }

  // Checked on the source rather than the speech: a stack of equations is a
  // structural fact, and a short one is no easier to follow by ear than a long
  // one because the line breaks carry the meaning.
  if (MULTI_LINE.test(latex)) return { speak: false, reason: 'multi-line' }

  if (wordCount(speech) > settings.maxWords) return { speak: false, reason: 'too-long' }

  return { speak: true }
}

/** What to say for one equation: its speech, a short placeholder, or nothing. */
export function mathUtterance(
  latex: string,
  speech: string | null,
  display: boolean,
  settings: GateSettings = DEFAULT_GATE
): string | null {
  const verdict = gate(latex, speech, display, settings)
  if (verdict.speak) return speech
  // Inline mathematics that cannot be spoken is passed over silently: a
  // placeholder mid-sentence is more disruptive than the gap it fills.
  if (!display) return null
  return DEFERRED_PHRASE[verdict.reason]
}
