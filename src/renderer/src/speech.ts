import { clampRate } from '@shared/speech'
import { rangeWithin, sourceIndex, type Utterance } from './blocks'

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
   * Set when we stop speech ourselves. `speechSynthesis.cancel()` fires `end`
   * on the current utterance exactly as a natural finish does, so without this
   * flag every pause immediately advances the queue by one.
   */
  private interrupting = false

  /** The utterance currently with the engine, so a stale `end` can be ignored. */
  private live: SpeechSynthesisUtterance | null = null

  load(utterances: Utterance[], startAt = 0): void {
    this.stop()
    this.queue = utterances
    this.at = Math.max(0, Math.min(startAt, Math.max(0, utterances.length - 1)))
    this.emit()
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
      voice: this.voiceName
    }
  }

  setRate(rate: number): void {
    this.rate = clampRate(rate)
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
      if (utterance) this.showElement(utterance.element)
      this.clearHighlight()
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
    this.showElement(utterance.element)
    speechSynthesis.speak(spoken)
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

  /** Keep the sentence being spoken on screen, without yanking the page around. */
  private showElement(element: HTMLElement): void {
    const container = element.closest('#content')
    if (!(container instanceof HTMLElement)) return

    const box = element.getBoundingClientRect()
    const view = container.getBoundingClientRect()
    const margin = 80

    if (box.top >= view.top + margin && box.bottom <= view.bottom - margin) return
    container.scrollTo({
      top: container.scrollTop + (box.top - view.top) - margin,
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
