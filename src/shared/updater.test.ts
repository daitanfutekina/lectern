import { describe, expect, it } from 'vitest'
import { shouldCheckForUpdates, updateNotice } from './updater'

describe('automatic update policy', () => {
  it('checks only in a packaged build with the setting enabled', () => {
    expect(shouldCheckForUpdates(true, true)).toBe(true)
    expect(shouldCheckForUpdates(false, true)).toBe(false)
    expect(shouldCheckForUpdates(true, false)).toBe(false)
  })

  it('shows a notice only after an update has downloaded', () => {
    expect(updateNotice('downloaded')).toContain('installed when you quit')
    expect(updateNotice('not-available')).toBeNull()
    expect(updateNotice('error')).toBeNull()
  })
})
