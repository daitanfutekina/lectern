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
  readonly onChange: (change: Partial<Settings>) => void
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

  if (context.neuralVoices.length > 0) {
    const group = document.createElement('optgroup')
    group.label = 'Neural (Piper)'
    for (const voice of context.neuralVoices) {
      group.append(option(`piper:${voice.id}`, voice.name))
    }
    picker.append(group)
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
  const stored = context.settings.voiceId
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
    context.onChange(
      value.startsWith('piper:')
        ? { neural: true, voiceId: value.slice('piper:'.length) }
        : { neural: false, voiceId: value }
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
