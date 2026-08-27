import { clampRate } from '@shared/speech'
import {
  BOOK_VOICE,
  speak as speakNeural,
  synthesise,
  type NeuralUtterance,
  type Playing,
  type Spoken
} from './neural-voice'
import type { VoiceShape } from '@shared/voice'
import { rangeWithin, sourceIndex, utteranceRange, utteranceSpan, type Utterance } from './blocks'

/**
 * Reading aloud. SPEC section 5.
 *
 * `speechSynthesis`, built into the renderer: no dependency, no install, no
 * network, and it uses the voices already on the system. That is the whole
 * reason the application can promise to work offline and cost nothing.
 *
 * The queue is one utterance per sentence rather than per block. Browser
 * engines truncate or stall on long utterances, pausing should land at the end
 * of a sentence rather than mid-clause, and short utterances are what make
 * seeking and word-follow responsive.
 */

export interface SpeechState {
  readonly playing: boolean
  readonly index: number
  readonly total: number
  readonly rate: number
  readonly voice: string | null
  /** True when a neural voice is speaking rather than a system one. */
  readonly neural: boolean
}

type Listener = (state: SpeechState) => void

/** The highlight registry is recent; a browser without it simply shows no follow. */
const HIGHLIGHTS: { set?: (name: string, highlight: unknown) => void; delete?: (name: string) => void } =
  (globalThis as { CSS?: { highlights?: typeof HIGHLIGHTS } }).CSS?.highlights ?? {}

const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight

export class Reader {
  private queue: Utterance[] = []
  private at = 0
  private playing = false
  private rate = 1
  private voiceName: string | null = null
  private listeners = new Set<Listener>()

  /**
   * A neural voice, when one is chosen. Held separately from `voiceName`
   * because the two engines are different in kind: one is asked to speak, the
   * other returns audio to be played.
   */
  private neuralVoice: string | null = null
  private shape: VoiceShape = BOOK_VOICE
  private pauseScale = 1

  /**
   * A character voice applied on top of the neural one, and how far to move the
   * base voice before converting into it.
   */
  private character: string | null = null
  private characterPitch = 0
  private playing_: Playing | null = null

  /**
   * Set when we stop speech ourselves. `speechSynthesis.cancel()` fires `end`
   * on the current utterance exactly as a natural finish does, so without this
   * flag every pause immediately advances the queue by one.
   */
  private interrupting = false

  /** The utterance currently with the engine, so a stale `end` can be ignored. */
  private live: SpeechSynthesisUtterance | null = null

  /** Identifies the in-flight neural utterance, so a stale one cannot advance. */
  private neuralToken: object | null = null

  /**
   * The next sentence's audio, being made while this one plays.
   *
   * Held with the index it was made for, because everything that invalidates it
   * -- a jump, a new chapter, a different voice -- changes which sentence comes
   * next, and comparing indices is cheaper and harder to get wrong than
   * remembering to clear it in each of those places.
   */
  private ahead: { index: number; audio: Promise<Spoken | null> } | null = null

  load(utterances: Utterance[], startAt = 0): void {
    this.stop()
    this.queue = utterances
    this.at = Math.max(0, Math.min(startAt, Math.max(0, utterances.length - 1)))
    this.prime()
    this.emit()
  }

  /**
   * What the queue will actually say, in order.
   *
   * Handed to the background job so it prepares the sentences that get spoken
   * rather than the ones a second walk of the document would produce -- the two
   * differ wherever an equation was turned into words.
   */
  texts(): string[] {
    return this.queue.map((utterance) => utterance.text)
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get state(): SpeechState {
    return {
      playing: this.playing,
      index: this.at,
      total: this.queue.length,
      rate: this.rate,
      voice: this.neuralVoice ?? this.voiceName,
      neural: this.neuralVoice !== null
    }
  }

  /** Choose a neural voice, or pass null to fall back to the system voices. */
  setNeuralVoice(id: string | null): void {
    this.neuralVoice = id
    // Made for a voice that is no longer the voice.
    this.ahead = null
    if (this.playing) this.restartCurrent()
    else {
      this.prime()
      this.emit()
    }
  }

  /**
   * Choose a character voice, or null for none.
   *
   * Deliberately not part of `setNeuralVoice`: a character is a conversion
   * applied to whichever neural voice is speaking, not an alternative to it,
   * and the base voice still decides the pronunciation and the pacing.
   */
  setCharacter(name: string | null, semitones: number): void {
    this.character = name
    this.characterPitch = semitones
    this.ahead = null
    if (this.playing) this.restartCurrent()
    else {
      this.prime()
      this.emit()
    }
  }

  setShape(shape: VoiceShape): void {
    this.shape = shape
    this.ahead = null
    if (this.playing) this.restartCurrent()
    else this.emit()
  }

  currentShape(): VoiceShape {
    return this.shape
  }

  /** Scale the silence between sentences; 0 runs them together. */
  setPauseScale(scale: number): void {
    this.pauseScale = Number.isFinite(scale) ? Math.min(Math.max(scale, 0), 3) : 1
  }

  setRate(rate: number): void {
    this.rate = clampRate(rate)
    this.ahead = null
    // The rate of an utterance already with the engine cannot be changed, so
    // the current sentence is restarted at the new speed rather than the change
    // appearing to do nothing until the next one.
    if (this.playing) this.restartCurrent()
    else this.emit()
  }

  setVoice(name: string | null): void {
    this.voiceName = name
    if (this.playing) this.restartCurrent()
    else this.emit()
  }

  play(): void {
    if (this.queue.length === 0 || this.playing) return
    this.playing = true
    this.speakCurrent()
    this.emit()
  }

  pause(): void {
    if (!this.playing) return
    this.playing = false
    this.cancel()
    this.emit()
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  stop(): void {
    this.playing = false
    this.cancel()
    this.clearHighlight()
    this.emit()
  }

  /** Move by whole utterances, staying inside the queue. */
  skip(delta: number): void {
    if (this.queue.length === 0) return
    this.jumpTo(this.at + delta)
  }

  /** Move to the next or previous heading, which is a section in practice. */
  skipSection(direction: 1 | -1): void {
    if (this.queue.length === 0) return
    let index = this.at + direction
    while (index > 0 && index < this.queue.length && this.queue[index]?.kind !== 'heading') {
      index += direction
    }
    this.jumpTo(index)
  }

  jumpTo(index: number): void {
    const target = Math.max(0, Math.min(index, this.queue.length - 1))
    const wasPlaying = this.playing
    this.cancel()
    this.at = target

    if (wasPlaying) {
      this.speakCurrent()
    } else {
      // Skipping while paused still moves the view. Otherwise the counter
      // changes, nothing else does, and the control looks broken.
      const utterance = this.queue[this.at]
      if (utterance) this.showUtterance(utterance)
      this.clearHighlight()
      // Clicking a paragraph is usually a prelude to pressing play.
      this.prime()
    }
    this.emit()
  }

  /** The utterance nearest a block element, so playback can start where the reader is. */
  indexNear(element: HTMLElement): number {
    const found = this.queue.findIndex((utterance) => utterance.element === element)
    if (found >= 0) return found
    const found2 = this.queue.findIndex((utterance) => element.contains(utterance.element))
    return found2 >= 0 ? found2 : 0
  }

  /**
   * The utterance covering a character offset inside a block.
   *
   * Matching on the element alone is not enough where a whole PDF page is one
   * block: every sentence on it shares an element, so a click anywhere on the
   * page started reading from the top of it -- sometimes a screen and a half
   * above where the reader had actually pointed.
   */
  indexAt(element: HTMLElement, offset: number): number {
    let fallback = -1

    for (const [at, utterance] of this.queue.entries()) {
      if (utterance.element !== element) continue
      if (fallback < 0) fallback = at

      const span = utteranceSpan(utterance)
      if (offset >= span.from && offset < span.to) return at
      // Past the click: the nearest sentence that starts after it.
      if (span.from > offset) return at
    }

    if (fallback >= 0) return fallback
    return this.indexNear(element)
  }

  current(): Utterance | null {
    return this.queue[this.at] ?? null
  }

  private restartCurrent(): void {
    this.cancel()
    this.speakCurrent()
    this.emit()
  }

  private cancel(): void {
    this.interrupting = true
    this.live = null
    this.playing_?.stop()
    this.playing_ = null
    speechSynthesis.cancel()
    this.interrupting = false
  }

  private speakCurrent(): void {
    const utterance = this.queue[this.at]
    if (!utterance) {
      this.playing = false
      this.clearHighlight()
      this.emit()
      return
    }

    if (this.neuralVoice) {
      void this.speakNeuralCurrent(utterance, this.neuralVoice)
      return
    }

    const spoken = new SpeechSynthesisUtterance(utterance.text)
    spoken.rate = this.rate
    const voice = this.voiceName
      ? speechSynthesis.getVoices().find((v) => v.name === this.voiceName)
      : undefined
    if (voice) spoken.voice = voice

    spoken.addEventListener('boundary', (event) => {
      if (this.live !== spoken) return
      this.highlightWord(utterance, event.charIndex, event.charLength)
    })

    spoken.addEventListener('end', () => {
      // A cancel fires `end` exactly as a natural finish does. Advancing on
      // both would skip a sentence every time playback is paused.
      if (this.interrupting || this.live !== spoken) return
      this.live = null
      if (!this.playing) return
      if (this.at + 1 >= this.queue.length) {
        this.playing = false
        this.clearHighlight()
        this.emit()
        return
      }
      this.at += 1
      this.speakCurrent()
      this.emit()
    })

    spoken.addEventListener('error', (event) => {
      if (this.live !== spoken) return
      console.warn(`speech error: ${event.error} at ${this.at}`)
      this.live = null
      this.playing = false
      this.emit()
    })

    this.live = spoken
    this.showUtterance(utterance)
    speechSynthesis.speak(spoken)
  }

  /**
   * Speak through a neural voice.
   *
   * The engine returns audio rather than speaking, so advancing the queue hangs
   * off the buffer finishing rather than off an `end` event -- and the guard
   * against a stale finish is the same one the system path needs.
   */
  private async speakNeuralCurrent(utterance: Utterance, voiceId: string): Promise<void> {
    const token = {}
    this.neuralToken = token

    // Whatever was made ahead of time, if it was made for this sentence.
    const ready = this.ahead?.index === this.at ? await this.ahead.audio : null
    this.ahead = null

    let playing: Playing
    try {
      playing = await speakNeural(
        this.request(utterance, voiceId),
        (charIndex) => {
          if (this.neuralToken !== token) return
          this.highlightWord(utterance, charIndex, 0)
        },
        ready
      )
    } catch {
      this.playing = false
      this.emit()
      return
    }

    // Cancelled, or moved on, while the audio was being generated.
    if (this.neuralToken !== token || !this.playing) {
      playing.stop()
      return
    }

    this.playing_ = playing
    this.showUtterance(utterance)

    // The next sentence, made while this one speaks. At twice realtime the
    // generator stays comfortably ahead of the voice, so the join is silent.
    this.lookAhead(voiceId)

    await playing.done
    if (this.neuralToken !== token || !this.playing) return

    this.playing_ = null
    if (this.at + 1 >= this.queue.length) {
      this.playing = false
      this.clearHighlight()
      this.emit()
      return
    }
    this.at += 1
    this.speakCurrent()
    this.emit()
  }

  /** Everything the synthesiser needs, in one place so look-ahead cannot drift. */
  private request(utterance: Utterance, voiceId: string): NeuralUtterance {
    return {
      text: utterance.text,
      voiceId,
      shape: this.shape,
      speed: this.rate,
      pauseScale: this.pauseScale,
      character: this.character,
      semitones: this.characterPitch
    }
  }

  /**
   * Start making the sentence after this one.
   *
   * Nothing waits on it. If the reader jumps, changes voice, or stops, the
   * result is simply dropped -- `ahead` is only ever used when its index still
   * matches the sentence about to be spoken, so a stale one cannot be played.
   */
  private lookAhead(voiceId: string): void {
    this.prefetch(this.at + 1, voiceId)
  }

  /**
   * Make the sentence at `index` ahead of time, if it is not already being made.
   *
   * The guard matters more than it looks: a PDF rebuilds its speech queue every
   * time a page finishes drawing, so without it a scroll would start a fresh
   * synthesis of the same sentence several times a second.
   */
  private prefetch(index: number, voiceId: string): void {
    if (index < 0 || index >= this.queue.length) {
      this.ahead = null
      return
    }
    if (this.ahead?.index === index) return

    const utterance = this.queue[index]
    if (!utterance) return

    this.ahead = {
      index,
      // Rejections are swallowed here rather than left unhandled: this promise
      // may never be awaited at all.
      audio: synthesise(this.request(utterance, voiceId)).catch(() => null)
    }
  }

  /**
   * Make the sentence that would be spoken next, before anyone asks for it.
   *
   * Look-ahead keeps the *middle* of a chapter seamless but does nothing for the
   * start, because the first sentence has nothing playing in front of it to be
   * made behind. At Kokoro's speed that is several seconds between pressing
   * play and hearing anything, which reads as the button not working.
   */
  private prime(): void {
    if (this.playing || !this.neuralVoice) return
    this.prefetch(this.at, this.neuralVoice)
  }

  /**
   * Highlight the word being spoken.
   *
   * The offsets the engine reports address the text it was given, which is not
   * the text on screen -- symbols were rewritten before speaking. The map
   * carried on each utterance converts one to the other.
   */
  private highlightWord(utterance: Utterance, charIndex: number, charLength: number): void {
    if (!HighlightCtor || !HIGHLIGHTS.set) return

    const from = sourceIndex(utterance, charIndex)
    const length = charLength > 0 ? charLength : wordLengthAt(utterance.source, from)
    const range = rangeWithin(utterance.element, from, from + length)
    if (!range) return

    try {
      HIGHLIGHTS.set('spoken', new HighlightCtor(range))
    } catch {
      // A browser without the registry simply shows no follow.
    }
  }

  private clearHighlight(): void {
    try {
      HIGHLIGHTS.delete?.('spoken')
    } catch {
      // Nothing to do; the highlight is decoration.
    }
  }

  /**
   * Keep the sentence being spoken on screen, without yanking the page around.
   *
   * Scrolls to the *sentence*, not to the block holding it. On a PDF the block
   * is a whole page, so scrolling to it put the top of the page in view while
   * the voice read something near the bottom -- which is what made the reading
   * position feel lost.
   */
  private showUtterance(utterance: Utterance): void {
    const container = utterance.element.closest('#content')
    if (!(container instanceof HTMLElement)) return

    const range = utteranceRange(utterance)
    const box = range?.getBoundingClientRect()
    // A collapsed rect means the range resolved to nothing useful; the element
    // is a worse answer but a better one than not scrolling at all.
    const target =
      box && box.height > 0 ? box : utterance.element.getBoundingClientRect()

    const view = container.getBoundingClientRect()
    const margin = 120

    if (target.top >= view.top + margin && target.bottom <= view.bottom - margin) return
    container.scrollTo({
      top: container.scrollTop + (target.top - view.top) - margin,
      behavior: 'smooth'
    })
  }

  private emit(): void {
    const state = this.state
    for (const listener of this.listeners) listener(state)
  }
}

/** How long the word at an index is, for engines that report no length. */
function wordLengthAt(source: string, from: number): number {
  const match = /^\S+/.exec(source.slice(from))
  return match ? match[0].length : 1
}

/**
 * Voices load asynchronously and slowly.
 *
 * On Windows the system voices took several seconds to appear, and waiting on
 * `voiceschanged` alone was not enough -- an earlier version resolved after
 * 1.5s with an empty list and left the picker permanently empty even though
 * three voices existed. So this polls to a generous deadline as well as
 * listening, and `onVoicesChanged` lets the picker fill itself in later
 * whenever they do arrive.
 */
export function voices(timeoutMs = 8000): Promise<SpeechSynthesisVoice[]> {
  const available = speechSynthesis.getVoices()
  if (available.length > 0) return Promise.resolve(available)

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      speechSynthesis.removeEventListener('voiceschanged', finish)
      clearInterval(poll)
      resolve(speechSynthesis.getVoices())
    }

    const poll = setInterval(() => {
      if (speechSynthesis.getVoices().length > 0 || Date.now() > deadline) finish()
    }, 250)

    speechSynthesis.addEventListener('voiceschanged', finish)
  })
}

/** Re-run when the voice list changes, so a late arrival still fills the picker. */
export function onVoicesChanged(listener: () => void): () => void {
  speechSynthesis.addEventListener('voiceschanged', listener)
  return () => speechSynthesis.removeEventListener('voiceschanged', listener)
}
