import { app, dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decideLibraryRoot } from '@shared/library-root'
import { authoringKitSource, installAuthoringKit } from './authoring-kit'
import { DEFAULT_ROOT } from './library'

const LOCATION_FILE = 'library-root.txt'
const LIBRARY_FOLDERS = ['books', 'pdfs', 'epubs', '.library'] as const

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function storedRoot(userData: string): Promise<string | null> {
  try {
    return (await readFile(join(userData, LOCATION_FILE), 'utf8')).trim() || null
  } catch {
    return null
  }
}

async function prepareRoot(path: string): Promise<void> {
  await Promise.all(LIBRARY_FOLDERS.map((folder) => mkdir(join(path, folder), { recursive: true })))
}

async function preparePickedRoot(path: string): Promise<void> {
  const isNew = !(await isDirectory(join(path, '.library')))
  await prepareRoot(path)
  if (isNew) {
    await installAuthoringKit(
      path,
      authoringKitSource(app.isPackaged, process.resourcesPath, __dirname)
    )
  }
}

async function rememberRoot(userData: string, path: string): Promise<void> {
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, LOCATION_FILE), path, 'utf8')
}

async function pickRoot(owner?: BrowserWindow): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Choose your Lectern library folder',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory']
  }
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

/** Resolve startup state before any library-backed service is configured. */
export async function resolveLibraryRoot(userData: string): Promise<string | null> {
  const stored = await storedRoot(userData)
  const decision = decideLibraryRoot({
    environment: process.env['LECTERN_ROOT'],
    stored,
    storedExists: stored ? await isDirectory(stored) : false,
    fallback: DEFAULT_ROOT,
    fallbackExists: await isDirectory(join(DEFAULT_ROOT, '.library'))
  })

  if (decision.source !== 'picker') {
    await prepareRoot(decision.path)
    return decision.path
  }

  const picked = await pickRoot()
  if (!picked) return null
  await preparePickedRoot(picked)
  await rememberRoot(userData, picked)
  return picked
}

/** Ask for a replacement root and remember it for the next launch. */
export async function changeLibraryRoot(
  userData: string,
  current: string,
  owner: BrowserWindow
): Promise<boolean> {
  const picked = await pickRoot(owner)
  if (!picked) return false
  await preparePickedRoot(picked)
  await rememberRoot(userData, picked)
  return picked !== current
}
