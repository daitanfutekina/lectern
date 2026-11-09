import { afterEach, describe, expect, it, vi } from 'vitest'
import { coalesceAction, mapInChunks } from './scheduling'

afterEach(() => vi.useRealTimers())

describe('coalesceAction', () => {
  it('collapses repeated requests into one trailing action', () => {
    vi.useFakeTimers()
    const action = vi.fn()
    const coalesced = coalesceAction(action, 250)

    coalesced.request()
    coalesced.request()
    vi.advanceTimersByTime(249)
    expect(action).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(action).toHaveBeenCalledTimes(1)

    coalesced.request()
    vi.advanceTimersByTime(250)
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('flushes the pending action now and cancels its timer', () => {
    vi.useFakeTimers()
    const action = vi.fn()
    const coalesced = coalesceAction(action, 250)

    coalesced.request()
    coalesced.flush()
    expect(action).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(250)
    expect(action).toHaveBeenCalledTimes(1)

    coalesced.request()
    coalesced.cancel()
    vi.advanceTimersByTime(250)
    expect(action).toHaveBeenCalledTimes(1)
  })
})

describe('mapInChunks', () => {
  it('preserves order and yields only between bounded chunks', async () => {
    const events: string[] = []
    const result = await mapInChunks(
      [1, 2, 3, 4, 5],
      2,
      (item) => {
        events.push(`map ${item}`)
        return item * 10
      },
      async () => {
        events.push('yield')
      }
    )

    expect(result).toEqual([10, 20, 30, 40, 50])
    expect(events).toEqual(['map 1', 'map 2', 'yield', 'map 3', 'map 4', 'yield', 'map 5'])
  })
})
