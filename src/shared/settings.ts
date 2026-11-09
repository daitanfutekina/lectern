import { BOOK_VOICE, clampShape, type VoiceShape } from './voice'
import { DEFAULT_GATE, type GateSettings } from './math-gate'
import { isShelfSort, type ShelfSort } from './shelf'

/**
 * Everything the reader can change. SPEC section 7.
 *
 * One flat record, parsed defensively: it is a file on disk that can be edited
 * by hand, so a missing or nonsensical field must fall back rather than break
 * the application. Every number is clamped to a range the feature behind it
 * actually behaves in.
 */

export interface Settings {
  /* Reading */
  readonly fontScale: number
  readonly measure: number
  readonly theme: 'dark' | 'light'

  /* Speech */
  readonly voiceId: string | null
  readonly neural: boolean
  readonly rate: number
  readonly shape: VoiceShape
  /** Silence after a sentence, scaled. 1 is the measured default. */
  readonly pauseScale: number

  /*
    A character voice, applied on top of the neural one.

    Null is the ordinary case. Conversion runs at roughly realtime rather than
    the twenty times realtime Piper manages, so a chapter in a character voice
    is prepared ahead of being read rather than spoken on demand -- which is
    why this is a separate setting and not another entry in the voice list.
  */
  readonly character: string | null
  /**
   * Semitones to move the base voice before converting. A converter reproduces
   * timbre but not range, so a voice trained high and given a low pitch track
   * sounds like that voice straining.
   */
  readonly characterPitch: number
  /**
   * How strongly to pull the conversion toward the character's own recordings,
   * 0 to 1. Does nothing unless the voice ships a retrieval index.
   */
  readonly characterIndex: number
  /**
   * How far to leave unvoiced sounds -- t, k, s, breath -- alone, 0 to 0.5.
   * Lower protects more; 0.5 is off.
   */
  readonly characterProtect: number

  /* Mathematics */
  readonly math: GateSettings

  /* Scans */
  readonly ocrDpi: number
  readonly ocrAuto: boolean

  /* Shelf */
  readonly sort: ShelfSort

  /** Whether the sidebar lists the open chapter's sections. */
  readonly sections: boolean
  /** Whether the sidebar is hidden altogether, for reading without it. */
  readonly collapsed: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  fontScale: 1,
  measure: 72,
  theme: 'dark',
  voiceId: null,
  neural: true,
  rate: 1,
  shape: BOOK_VOICE,
  pauseScale: 1,
  character: null,
  characterPitch: 0,
  // RVC's own defaults, which are what its models were tuned against.
  characterIndex: 0.75,
  characterProtect: 0.33,
  math: DEFAULT_GATE,
  ocrDpi: 300,
  ocrAuto: true,
  sort: 'added',
  sections: true,
  collapsed: false
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const num = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, min), max)
    : fallback

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

export function parseSettings(source: string): Settings {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return DEFAULT_SETTINGS
  }
  if (!isRecord(raw)) return DEFAULT_SETTINGS

  const shape = isRecord(raw['shape']) ? raw['shape'] : {}

  return {
    // Below 0.8 the grid stops being readable and above 1.6 two words fit a
    // line; neither is a setting anyone wants to be able to reach.
    fontScale: num(raw['fontScale'], 1, 0.8, 1.6),
    measure: num(raw['measure'], 72, 45, 120),
    theme: raw['theme'] === 'light' ? 'light' : 'dark',
    voiceId: typeof raw['voiceId'] === 'string' ? raw['voiceId'] : null,
    neural: bool(raw['neural'], true),
    rate: num(raw['rate'], 1, 0.5, 3),
    shape: clampShape({
      lengthScale: num(shape['lengthScale'], BOOK_VOICE.lengthScale, 0.5, 2),
      noiseScale: num(shape['noiseScale'], BOOK_VOICE.noiseScale, 0, 1),
      noiseW: num(shape['noiseW'], BOOK_VOICE.noiseW, 0, 1)
    }),
    pauseScale: num(raw['pauseScale'], 1, 0, 3),
    character: typeof raw['character'] === 'string' && raw['character'] ? raw['character'] : null,
    // An octave either way. Past that the converter is being asked to invent a
    // register the model has never produced, and it stops sounding like anyone.
    characterPitch: Math.round(num(raw['characterPitch'], 0, -12, 12)),
    characterIndex: num(raw['characterIndex'], 0.75, 0, 1),
    characterProtect: num(raw['characterProtect'], 0.33, 0, 0.5),
    math: {
      maxWords: num(
        isRecord(raw['math']) ? raw['math']['maxWords'] : undefined,
        DEFAULT_GATE.maxWords,
        5,
        400
      ),
      alwaysSpeakInline: bool(
        isRecord(raw['math']) ? raw['math']['alwaysSpeakInline'] : undefined,
        true
      )
    },
    // Below 200 Tesseract's accuracy falls off a cliff; above 400 the time per
    // page doubles for no gain worth having.
    ocrDpi: num(raw['ocrDpi'], 300, 150, 450),
    ocrAuto: bool(raw['ocrAuto'], true),
    sort: isShelfSort(raw['sort']) ? raw['sort'] : 'added',
    sections: bool(raw['sections'], true),
    collapsed: bool(raw['collapsed'], false)
  }
}

/** Apply a partial change, re-validating the whole thing. */
export function withChange(current: Settings, change: Partial<Settings>): Settings {
  return parseSettings(JSON.stringify({ ...current, ...change }))
}
