import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { authoringKitSource, installAuthoringKit } from '../main/authoring-kit'
import { BOX_DIRECTIVES } from './markdown'

const PUBLIC_KIT = resolve('resources', 'authoring', 'textbook')

describe('public authoring kit', () => {
  it('keeps its documented and demonstrated directives aligned with the renderer', async () => {
    const skill = await readFile(join(PUBLIC_KIT, 'SKILL.md'), 'utf8')
    const example = await readFile(join(PUBLIC_KIT, 'references', 'example-chapter.md'), 'utf8')
    const documented = new Set(
      [...skill.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1])
    )
    const demonstrated = new Set(
      [...example.matchAll(/^:{3,}([a-z-]+)(?:\[|\{)/gm)].map((match) => match[1])
    )

    expect([...documented].sort()).toEqual([...BOX_DIRECTIVES].sort())
    expect([...demonstrated].sort()).toEqual([...BOX_DIRECTIVES].sort())
  })

  it('resolves the checked-in and packaged kit locations', () => {
    expect(authoringKitSource(false, 'unused', join('project', 'out', 'main'))).toBe(
      join('project', 'resources', 'authoring', 'textbook')
    )
    expect(authoringKitSource(true, join('install', 'resources'), 'unused')).toBe(
      join('install', 'resources', 'app', 'resources', 'authoring', 'textbook')
    )
  })

  it('copies missing files to both agents without overwriting an existing file', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'lectern-authoring-kit-'))
    const source = join(scratch, 'source')
    const library = join(scratch, 'library')
    try {
      await mkdir(join(source, 'references'), { recursive: true })
      await writeFile(join(source, 'SKILL.md'), 'bundled skill', 'utf8')
      await writeFile(join(source, 'references', 'figures.md'), 'bundled figures', 'utf8')
      await mkdir(join(library, '.claude', 'skills', 'textbook'), { recursive: true })
      await writeFile(
        join(library, '.claude', 'skills', 'textbook', 'SKILL.md'),
        'custom skill',
        'utf8'
      )

      const result = await installAuthoringKit(library, source)

      expect(result).toEqual({ copied: 3, existing: 1 })
      expect(
        await readFile(join(library, '.claude', 'skills', 'textbook', 'SKILL.md'), 'utf8')
      ).toBe('custom skill')
      expect(
        await readFile(
          join(library, '.claude', 'skills', 'textbook', 'references', 'figures.md'),
          'utf8'
        )
      ).toBe('bundled figures')
      expect(
        await readFile(join(library, '.agents', 'skills', 'textbook', 'SKILL.md'), 'utf8')
      ).toBe('bundled skill')
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
