import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, parseSettings, withChange, type Settings } from '@shared/settings'

/**
 * Settings, stored beside the library. SPEC section 7.
 *
 * Kept in the library rather than in the application's own data directory so
 * that a library carries its own reading preferences: the voice, the pacing and
 * the maths threshold belong to the books being read, not to the machine.
 */

let root = ''
let current: Settings = DEFAULT_SETTINGS
let loaded = false

export function configureSettings(libraryRoot: string): void {
  root = libraryRoot
  current = { ...DEFAULT_SETTINGS, root: libraryRoot }
  loaded = false
}

const path = (): string => join(root, '.library', 'settings.json')

export async function loadSettings(): Promise<Settings> {
  if (loaded) return current
  try {
    current = parseSettings(await readFile(path(), 'utf8'))
  } catch {
    current = { ...DEFAULT_SETTINGS, root }
  }
  loaded = true
  return current
}

export function getSettings(): Settings {
  return current
}

export async function saveSettings(change: Partial<Settings>): Promise<Settings> {
  await loadSettings()
  current = withChange(current, change)
  try {
    await mkdir(join(root, '.library'), { recursive: true })
    await writeFile(path(), JSON.stringify(current, null, 2), 'utf8')
  } catch {
    // Unwritable settings still apply for this session; they just will not
    // survive it, which is better than refusing the change.
  }
  return current
}
