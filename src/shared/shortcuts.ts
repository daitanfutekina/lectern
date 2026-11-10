export type ShortcutId =
  | 'help'
  | 'close'
  | 'find'
  | 'bookmark'
  | 'play'
  | 'previous-chapter'
  | 'next-chapter'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'

export interface ShortcutBinding {
  readonly key: string
  readonly ctrl?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
}

export interface ShortcutDefinition {
  readonly id: ShortcutId
  readonly keys: string
  readonly description: string
  readonly bindings: readonly ShortcutBinding[]
}

/** The table drives both dispatch and the help overlay, so their claims cannot drift apart. */
export const SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: 'help',
    keys: '?',
    description: 'Show keyboard shortcuts',
    bindings: [{ key: '?', shift: true }]
  },
  {
    id: 'find',
    keys: 'Ctrl + F',
    description: 'Find in the open book',
    bindings: [{ key: 'f', ctrl: true }]
  },
  {
    id: 'bookmark',
    keys: 'Ctrl + D',
    description: 'Bookmark this spot',
    bindings: [{ key: 'd', ctrl: true }]
  },
  {
    id: 'play',
    keys: 'Space',
    description: 'Read aloud or pause',
    bindings: [{ key: ' ' }]
  },
  {
    id: 'previous-chapter',
    keys: 'Alt + ←',
    description: 'Previous chapter',
    bindings: [{ key: 'arrowleft', alt: true }]
  },
  {
    id: 'next-chapter',
    keys: 'Alt + →',
    description: 'Next chapter',
    bindings: [{ key: 'arrowright', alt: true }]
  },
  {
    id: 'zoom-in',
    keys: 'Ctrl + +',
    description: 'Zoom into a PDF',
    bindings: [
      { key: '+', ctrl: true, shift: true },
      { key: '=', ctrl: true }
    ]
  },
  {
    id: 'zoom-out',
    keys: 'Ctrl + −',
    description: 'Zoom out of a PDF',
    bindings: [
      { key: '-', ctrl: true },
      { key: '_', ctrl: true, shift: true }
    ]
  },
  {
    id: 'zoom-reset',
    keys: 'Ctrl + 0',
    description: 'Reset PDF zoom',
    bindings: [{ key: '0', ctrl: true }]
  },
  {
    id: 'close',
    keys: 'Esc',
    description: 'Close the current panel',
    bindings: [{ key: 'escape' }]
  }
]

export interface ShortcutEvent {
  readonly key: string
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
  readonly shiftKey?: boolean
}

export function shortcutForEvent(
  event: ShortcutEvent,
  allowed: readonly ShortcutId[] = SHORTCUTS.map((shortcut) => shortcut.id)
): ShortcutDefinition | null {
  const key = event.key.toLocaleLowerCase()
  const ctrl = Boolean(event.ctrlKey || event.metaKey)

  for (const shortcut of SHORTCUTS) {
    if (!allowed.includes(shortcut.id)) continue
    if (shortcut.bindings.some((binding) =>
      binding.key === key &&
      Boolean(binding.ctrl) === ctrl &&
      Boolean(binding.alt) === Boolean(event.altKey) &&
      Boolean(binding.shift) === Boolean(event.shiftKey)
    )) return shortcut
  }
  return null
}
