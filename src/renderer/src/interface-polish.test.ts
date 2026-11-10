import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginDelayedLoading } from './loading-view'
import { showNotice } from './notice'

class FakeElement {
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, () => void>()
  className = ''
  textContent = ''
  type = ''
  hidden = false
  removed = false

  append(...children: FakeElement[]): void {
    this.children.push(...children)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener)
  }

  remove(): void {
    this.removed = true
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('notices', () => {
  it('announces without taking focus and dismisses after its timeout', () => {
    vi.useFakeTimers()
    const region = new FakeElement()
    vi.stubGlobal('document', {
      querySelector: () => region,
      createElement: () => new FakeElement()
    })

    const notice = showNotice('Added one book.', 'success', 100) as unknown as FakeElement

    expect(region.children).toContain(notice)
    expect(notice.className).toContain('is-success')
    expect(notice.children[1]?.attributes.get('aria-label')).toBe('Dismiss notice')
    vi.advanceTimersByTime(100)
    expect(notice.removed).toBe(true)
  })
})

describe('chapter loading state', () => {
  it('stays hidden for a fast open and appears after 200 ms for a slow one', () => {
    vi.useFakeTimers()
    const fast = new FakeElement()
    fast.hidden = true
    const finishFast = beginDelayedLoading(fast as unknown as HTMLElement)
    vi.advanceTimersByTime(199)
    finishFast()
    vi.advanceTimersByTime(1)
    expect(fast.hidden).toBe(true)

    const slow = new FakeElement()
    slow.hidden = true
    const finishSlow = beginDelayedLoading(slow as unknown as HTMLElement)
    vi.advanceTimersByTime(200)
    expect(slow.hidden).toBe(false)
    finishSlow()
    expect(slow.hidden).toBe(true)
  })
})
