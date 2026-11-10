import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { shouldCheckForUpdates, updateNotice } from '@shared/updater'

const CHECK_DELAY_MS = 5000

function describeError(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`
  try {
    return String(reason)
  } catch {
    return '<unprintable value>'
  }
}

/** Schedule a silent background check without delaying the window or library scan. */
export function scheduleAutoUpdate(
  window: BrowserWindow,
  packaged: boolean,
  enabled: boolean,
  userData: string
): void {
  if (!shouldCheckForUpdates(packaged, enabled)) return

  let logged = false
  const logOnce = (reason: unknown): void => {
    if (logged) return
    logged = true
    try {
      mkdirSync(userData, { recursive: true })
      appendFileSync(
        join(userData, 'lectern-errors.log'),
        `[${new Date().toISOString()}] Automatic update\n${describeError(reason)}\n\n`,
        'utf8'
      )
    } catch {
      // An update failure, including failure to log it, must stay invisible.
    }
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.autoRunAppAfterInstall = false
  autoUpdater.logger = null
  autoUpdater.on('error', logOnce)
  autoUpdater.on('update-downloaded', () => {
    const message = updateNotice('downloaded')
    if (message && !window.isDestroyed()) window.webContents.send('update:notice', message)
  })

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(logOnce)
  }, CHECK_DELAY_MS)
}
