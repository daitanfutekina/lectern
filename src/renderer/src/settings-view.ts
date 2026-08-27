import { SORT_LABELS, SORT_ORDER } from '@shared/shelf'
import type { Settings } from '@shared/settings'
import type { PiperVoice } from '@shared/voice'

/**
 * The settings page. SPEC section 7.
 *
 * A view inside the reader rather than a separate window: everything here
 * changes how the thing behind it reads, and a dialog that covers the book you
 * are adjusting the voice for is the wrong shape for that.
 *
 * Every control writes immediately. There is no Save button, because there is
 * nothing a reader could usefully do between changing a slider and it taking
 * effect, and a Save button on a preferences page is a way to lose changes.
 */

export interface SettingsContext {
  readonly settings: Settings
  readonly neuralVoices: readonly PiperVoice[]
  readonly systemVoices: readonly { name: string; lang: string }[]
  readonly voicesFolder: string
  readonly characters: {
    readonly names: readonly string[]
    /** Whether the shared encoders every character runs through are installed. */
    readonly ready: boolean
    readonly folder: string
  }
  readonly store: { readonly files: number; readonly bytes: number }
  readonly onChange: (change: Partial<Settings>) => void
  readonly onClearStore: (done: () => void) => void
  readonly onReveal: () => void
  readonly onRescan: () => void
  readonly onExportIndex: (done: () => void) => void
  readonly onPreview: (text: string) => void
}

export function renderSettings(container: HTMLElement, context: SettingsContext): void {
  container.replaceChildren()

  const page = el('div', 'settings')
  page.append(heading('Settings'))

  page.append(
    section('Reading', [
      slider('Text size', context.settings.fontScale, 0.8, 1.6, 0.05, (value) =>
        context.onChange({ fontScale: value })
      , (value) => `${Math.round(value * 100)}%`),
      slider(
        'Line width',
        context.settings.measure,
        45,
        120,
        1,
        (value) => context.onChange({ measure: value }),
        (value) => `${Math.round(value)} characters`
      ),
      note('Line width applies to the hand-written textbooks. A PDF keeps its own layout and an EPUB keeps the publisher’s.')
    ])
  )

  /* ── Voice ─────────────────────────────────────────────────────── */

  const voiceControls: HTMLElement[] = []

  const picker = document.createElement('select')
  picker.className = 'settings-select'

  /*
    Grouped by engine, best first.

    Two engines rather than one because Piper is not the ceiling of free local
    speech, and a reader looking at a flat list of thirty voices has no way to
    tell that half of them are a generation better than the other half.
  */
  for (const engine of ['kokoro', 'piper'] as const) {
    const voices = context.neuralVoices.filter((voice) => voice.engine === engine)
    if (voices.length === 0) continue
    const group = document.createElement('optgroup')
    group.label = engine === 'kokoro' ? 'Kokoro' : 'Piper'
    for (const voice of voices) group.append(option(`piper:${voice.id}`, voice.name))
    picker.append(group)
  }

  /*
    Characters sit in the voice list, between the neural voices they run on and
    the system ones. A character is a conversion rather than a voice, which
    matters to the code and not to the reader: they are choosing who reads to
    them, and that belongs where voices are chosen. What stays in its own
    section below is only what has no equivalent for an ordinary voice -- the
    pitch it has to be shifted by, and the speech prepared for it so far.
  */
  if (context.neuralVoices.length > 0 && context.characters.ready) {
    const group = document.createElement('optgroup')
    group.label = 'Character'
    for (const name of context.characters.names) {
      group.append(option(`character:${name}`, prettyCharacter(name)))
    }
    if (group.children.length > 0) picker.append(group)
  }

  const systemGroup = document.createElement('optgroup')
  systemGroup.label = 'System'
  for (const voice of context.systemVoices) {
    systemGroup.append(option(voice.name, `${voice.name} (${voice.lang})`))
  }
  picker.append(systemGroup)

  /*
    A stored voice, or the best available one.

    With no voice chosen yet the value was `piper:` -- which matches no option,
    so the picker rendered blank and looked broken on first run. Falling back to
    the first neural voice, then the first system one, means it always shows
    what is actually going to speak.
  */
  const stored = context.settings.character
    ? `character:${context.settings.character}`
    : context.settings.voiceId
      ? context.settings.neural
        ? `piper:${context.settings.voiceId}`
        : context.settings.voiceId
      : ''
  const fallback = context.neuralVoices[0]
    ? `piper:${context.neuralVoices[0].id}`
    : (context.systemVoices[0]?.name ?? '')

  picker.value = stored
  if (!picker.value) picker.value = fallback
  picker.addEventListener('change', () => {
    const value = picker.value

    if (value.startsWith('character:')) {
      // A character runs on top of a neural voice, so one is kept underneath it.
      const base =
        context.settings.neural && context.settings.voiceId
          ? context.settings.voiceId
          : context.neuralVoices[0]?.id
      if (!base) return
      context.onChange({
        neural: true,
        voiceId: base,
        character: value.slice('character:'.length)
      })
      return
    }

    context.onChange(
      value.startsWith('piper:')
        ? { neural: true, voiceId: value.slice('piper:'.length), character: null }
        : { neural: false, voiceId: value, character: null }
    )
  })
  voiceControls.push(row('Voice', picker))

  voiceControls.push(
    slider('Speed', context.settings.rate, 0.5, 2, 0.05, (value) =>
      context.onChange({ rate: value })
    , (value) => `${value.toFixed(2)}×`)
  )

  if (context.neuralVoices.length > 0) {
    voiceControls.push(
      slider(
        'Pace',
        context.settings.shape.lengthScale,
        0.8,
        2,
        0.05,
        (value) =>
          context.onChange({ shape: { ...context.settings.shape, lengthScale: value } }),
        // The number nobody can judge from a slider position, so it is stated.
        (value) => `about ${Math.round(210 / value)} words per minute`
      ),
      slider(
        'Expression',
        context.settings.shape.noiseScale,
        0,
        1,
        0.05,
        (value) =>
          context.onChange({
            shape: {
              ...context.settings.shape,
              noiseScale: value,
              // Timing variation tracks expressiveness: a flat voice with loose
              // timing sounds broken rather than calm.
              noiseW: 0.4 + value * 0.5
            }
          }),
        (value) => (value < 0.35 ? 'flat' : value > 0.75 ? 'lively' : 'even')
      ),
      slider(
        'Pause between sentences',
        context.settings.pauseScale,
        0,
        3,
        0.1,
        (value) => context.onChange({ pauseScale: value }),
        (value) => (value === 0 ? 'none' : `${Math.round(380 * value)} ms`)
      )
    )
  } else {
    voiceControls.push(
      note(`No neural voice installed. Put a Piper voice folder in ${context.voicesFolder} to get one.`)
    )
  }

  const preview = document.createElement('button')
  preview.type = 'button'
  preview.className = 'settings-button'
  preview.textContent = 'Hear a sentence'
  preview.addEventListener('click', () =>
    context.onPreview(
      'The characteristic polynomial is a determinant, and its roots are the eigenvalues of the matrix.'
    )
  )
  voiceControls.push(row('Preview', preview))

  page.append(section('Voice', voiceControls))

  /* ── Character voice ───────────────────────────────────────────── */

  /*
    A conversion applied to the neural voice, not an alternative to it.

    It reads as a separate section for that reason: the voice above still
    decides the pronunciation and the pacing, and this only changes who it
    sounds like. Presenting it as another entry in the voice list would suggest
    the two are interchangeable, and would hide that one of them is roughly
    realtime while the other is twenty times faster.
  */
  const characterControls: HTMLElement[] = []

  if (context.characters.names.length === 0) {
    characterControls.push(
      note(`No character voice installed. Put one in ${context.characters.folder} to get one.`)
    )
  } else if (!context.characters.ready) {
    characterControls.push(
      note(
        `A character voice is installed but the two models it runs through are not. ` +
          `Both belong in ${context.characters.folder}.`
      )
    )
  } else {
    characterControls.push(
      slider(
        'Pitch',
        context.settings.characterPitch,
        -12,
        12,
        1,
        (value) => context.onChange({ characterPitch: Math.round(value) }),
        (value) => {
          const semitones = Math.round(value)
          if (semitones === 0) return 'unchanged'
          return `${semitones > 0 ? '+' : ''}${semitones} semitone${Math.abs(semitones) === 1 ? '' : 's'}`
        }
      )
    )

    /*
      What preparing a chapter has cost so far, and a way to reclaim it.

      The store has no size limit on purpose: throwing away a sentence that took
      a second of real work to make, to save a few kilobytes, is the wrong
      trade. But that means it only ever grows, so the reader is told how large
      it is and can empty it.
    */
    const used = text(describeStore(context.store))
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'settings-button'
    clear.textContent = 'Clear prepared speech'
    clear.addEventListener('click', () => {
      clear.textContent = 'Clearing…'
      context.onClearStore(() => {
        used.textContent = describeStore({ files: 0, bytes: 0 })
        clear.textContent = 'Clear prepared speech'
      })
    })

    characterControls.push(
      slider(
        'Likeness',
        context.settings.characterIndex,
        0,
        1,
        0.05,
        (value) => context.onChange({ characterIndex: value }),
        (value) =>
          value === 0 ? 'off' : value < 0.4 ? 'light' : value > 0.85 ? 'strong' : 'balanced'
      ),
      slider(
        'Keep consonants',
        // Shown the other way up: the stored number is how much conversion to
        // *allow* on unvoiced sounds, and nobody thinks about it that way.
        0.5 - context.settings.characterProtect,
        0,
        0.5,
        0.02,
        (value) => context.onChange({ characterProtect: 0.5 - value }),
        (value) => (value <= 0 ? 'off' : value >= 0.48 ? 'most' : 'some')
      ),
      note(
        'Likeness pulls each moment toward the nearest thing the character ' +
          'actually recorded. Keeping consonants leaves the T and S sounds to ' +
          'the base voice, which is where a converter does its worst work.'
      )
    )

    characterControls.push(row('Prepared', used), row('', clear))

    characterControls.push(
      note(
        'Conversion reproduces a voice but not its range, so a base voice far ' +
          'below the character sounds strained until it is moved up. It runs at ' +
          'about the speed of speech rather than twenty times faster, so a ' +
          'chapter is prepared in the background before it is read, and kept.'
      )
    )
  }

  page.append(section('Character voice', characterControls))

  /* ── Mathematics ───────────────────────────────────────────────── */

  page.append(
    section('Mathematics', [
      slider(
        'Longest equation to speak',
        context.settings.math.maxWords,
        5,
        200,
        5,
        (value) => context.onChange({ math: { ...context.settings.math, maxWords: value } }),
        (value) => `${Math.round(value)} spoken words`
      ),
      toggle('Always speak inline mathematics', context.settings.math.alwaysSpeakInline, (value) =>
        context.onChange({ math: { ...context.settings.math, alwaysSpeakInline: value } })
      ),
      note('Longer equations are announced and left on screen. Inline mathematics sits inside a sentence, so skipping it leaves a hole in the prose.')
    ])
  )

  /* ── Scans ─────────────────────────────────────────────────────── */

  page.append(
    section('Scanned pages', [
      slider(
        'Recognition detail',
        context.settings.ocrDpi,
        150,
        450,
        25,
        (value) => context.onChange({ ocrDpi: value }),
        (value) => `${Math.round(value)} DPI`
      ),
      toggle('Recognise a scan as soon as it is opened', context.settings.ocrAuto, (value) =>
        context.onChange({ ocrAuto: value })
      ),
      note('Higher detail is slower per page and rarely better above 300 DPI. Scan quality matters more than this setting does.')
    ])
  )

  /* ── Library ───────────────────────────────────────────────────── */

  const sort = document.createElement('select')
  sort.className = 'settings-select'
  for (const value of SORT_ORDER) sort.append(option(value, SORT_LABELS[value]))
  sort.value = context.settings.sort
  sort.addEventListener('change', () => context.onChange({ sort: sort.value as Settings['sort'] }))

  const reveal = document.createElement('button')
  reveal.type = 'button'
  reveal.className = 'settings-button'
  reveal.textContent = 'Open library folder'
  reveal.addEventListener('click', context.onReveal)

  const rescan = document.createElement('button')
  rescan.type = 'button'
  rescan.className = 'settings-button'
  rescan.textContent = 'Rescan library'
  rescan.addEventListener('click', context.onRescan)

  const index = document.createElement('button')
  index.type = 'button'
  index.className = 'settings-button'
  index.textContent = 'Write INDEX.md'
  index.addEventListener('click', () => {
    index.textContent = 'Writing…'
    context.onExportIndex(() => {
      index.textContent = 'Written'
      setTimeout(() => {
        index.textContent = 'Write INDEX.md'
      }, 2000)
    })
  })

  page.append(
    section('Library', [
      row('Shelf order', sort),
      row('Location', text(context.settings.root)),
      row('', reveal),
      row('', rescan),
      row('', index),
      note('Only the books folder is scanned. PDFs and EPUBs join the library by being dropped on the window, and are read where they live rather than copied.')
    ])
  )

  container.append(page)
}

/* ── Small builders ──────────────────────────────────────────────── */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  content?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

const heading = (label: string): HTMLElement => el('h2', 'settings-title', label)
const text = (value: string): HTMLElement => el('span', 'settings-value', value)
const note = (value: string): HTMLElement => el('p', 'settings-note', value)

/** "412 sentences, 74 MB", or plain English when there are none. */
function describeStore(store: { files: number; bytes: number }): string {
  if (store.files === 0) return 'nothing prepared yet'
  const mb = store.bytes / 1048576
  const size = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
  return `${store.files} sentence${store.files === 1 ? '' : 's'}, ${size}`
}

/** A folder name is a folder name; `kasane-teto` reads better as `Kasane Teto`. */
function prettyCharacter(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option')
  node.value = value
  node.textContent = label
  return node
}

function section(title: string, children: HTMLElement[]): HTMLElement {
  const group = el('section', 'settings-group')
  group.append(el('h3', 'settings-heading', title))
  for (const child of children) group.append(child)
  return group
}

function row(label: string, control: HTMLElement): HTMLElement {
  const line = el('div', 'settings-row')
  line.append(el('span', 'settings-label', label))
  line.append(control)
  return line
}

function toggle(label: string, value: boolean, onChange: (value: boolean) => void): HTMLElement {
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = value
  input.addEventListener('change', () => onChange(input.checked))
  return row(label, input)
}

/**
 * A slider that says what its position means.
 *
 * "Pace: 1.35" tells a reader nothing; "about 155 words per minute" tells them
 * whether to move it. Every slider here carries a formatter for that reason.
 */
function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (value: number) => void,
  format: (value: number) => string
): HTMLElement {
  const input = document.createElement('input')
  input.type = 'range'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(value)

  const readout = el('span', 'settings-readout', format(value))
  input.addEventListener('input', () => {
    readout.textContent = format(Number(input.value))
  })
  // Written on release rather than on every pixel of the drag: each change is a
  // file write and a voice reload.
  input.addEventListener('change', () => onChange(Number(input.value)))

  const control = el('div', 'settings-slider')
  control.append(input, readout)
  return row(label, control)
}
