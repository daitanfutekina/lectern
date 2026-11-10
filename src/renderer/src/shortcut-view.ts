import { SHORTCUTS } from '@shared/shortcuts'

/** Build help from the same definitions that dispatch the keys. */
export function renderShortcutOverlay(container: HTMLElement, onClose: () => void): HTMLButtonElement {
  const panel = document.createElement('section')
  panel.className = 'shortcut-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-labelledby', 'shortcut-title')

  const header = document.createElement('header')
  const title = document.createElement('h2')
  title.id = 'shortcut-title'
  title.textContent = 'Keyboard shortcuts'

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'shortcut-close'
  close.setAttribute('aria-label', 'Close keyboard shortcuts')
  close.textContent = '×'
  close.addEventListener('click', onClose)
  header.append(title, close)

  const list = document.createElement('dl')
  for (const shortcut of SHORTCUTS) {
    const keys = document.createElement('dt')
    const key = document.createElement('kbd')
    key.textContent = shortcut.keys
    keys.append(key)

    const description = document.createElement('dd')
    description.textContent = shortcut.description
    list.append(keys, description)
  }

  panel.append(header, list)
  container.replaceChildren(panel)
  return close
}
