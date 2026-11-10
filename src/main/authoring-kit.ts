import { constants } from 'node:fs'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface AuthoringKitInstallResult {
  readonly copied: number
  readonly existing: number
}

/** Locate the checked-in kit both beside the development build and in the unpacked app. */
export function authoringKitSource(
  packaged: boolean,
  resourcesPath: string,
  moduleDirectory: string
): string {
  return packaged
    ? join(resourcesPath, 'app', 'resources', 'authoring', 'textbook')
    : join(moduleDirectory, '..', '..', 'resources', 'authoring', 'textbook')
}

async function copyMissing(source: string, target: string): Promise<AuthoringKitInstallResult> {
  await mkdir(target, { recursive: true })
  let copied = 0
  let existing = 0

  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      const result = await copyMissing(from, to)
      copied += result.copied
      existing += result.existing
      continue
    }
    if (!entry.isFile()) continue

    try {
      await copyFile(from, to, constants.COPYFILE_EXCL)
      copied += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      existing += 1
    }
  }

  return { copied, existing }
}

/** Install for both supported coding agents without replacing anything already customised. */
export async function installAuthoringKit(
  libraryRoot: string,
  source: string
): Promise<AuthoringKitInstallResult> {
  let copied = 0
  let existing = 0
  for (const agent of ['.claude', '.agents']) {
    const result = await copyMissing(source, join(libraryRoot, agent, 'skills', 'textbook'))
    copied += result.copied
    existing += result.existing
  }
  return { copied, existing }
}
