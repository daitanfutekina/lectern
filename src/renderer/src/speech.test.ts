import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Utterance } from './blocks'
import { Reader } from './speech'

class FakeSpokenUtterance {
  rate = 1
  voice: SpeechSynthesisVoice | null = null
  private readonly listeners = new Map<string, Array<() => void>>()

  constructor(readonly text: string) {}

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  finish(): void {
    for (const listener of this.listeners.get('end') ?? []) listener()
  }
}

const utterance = (text: string): Utterance => ({
  text,
  element: { closest: () => null } as unknown as HTMLElement,
  source: text,
  map: [],
  offset: 0,
  kind: 'paragraph'
})

let spoken: FakeSpokenUtterance[]

beforeEach(() => {
  spoken = []
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('SpeechSynthesisUtterance', FakeSpokenUtterance)
  vi.stubGlobal('speechSynthesis', {
    cancel: vi.fn(() => spoken.at(-1)?.finish()),
    getVoices: () => [],
    speak: vi.fn((item: FakeSpokenUtterance) => spoken.push(item))
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('Reader completion', () => {
  it('signals only after the last utterance finishes naturally', () => {
    const reader = new Reader()
    const ended = vi.fn()
    reader.onEnd(ended)
    reader.load([utterance('First.'), utterance('Second.')])

    reader.play()
    spoken[0]?.finish()
    expect(ended).not.toHaveBeenCalled()
    expect(reader.state.index).toBe(1)

    spoken[1]?.finish()
    expect(ended).toHaveBeenCalledOnce()
    expect(reader.state.playing).toBe(false)
    expect(reader.state.finished).toBe(true)
    expect(reader.state.remainingSeconds).toBe(0)
  })

  it('does not signal completion when playback is paused', () => {
    const reader = new Reader()
    const ended = vi.fn()
    reader.onEnd(ended)
    reader.load([utterance('First.')])

    reader.play()
    reader.pause()

    expect(ended).not.toHaveBeenCalled()
    expect(reader.state.finished).toBe(false)
  })
})
