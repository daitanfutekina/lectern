export type NoticeKind = 'success' | 'info' | 'error'

/** Show an outcome without interrupting reading or stealing keyboard focus. */
export function showNotice(
  message: string,
  kind: NoticeKind = 'info',
  duration = kind === 'error' ? 8000 : 4500
): HTMLElement | null {
  const region = document.querySelector<HTMLElement>('#notices')
  if (!region) return null

  const notice = document.createElement('div')
  notice.className = `app-notice is-${kind}`

  const text = document.createElement('span')
  text.textContent = message

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'app-notice-close'
  close.setAttribute('aria-label', 'Dismiss notice')
  close.textContent = '×'

  let timer: ReturnType<typeof setTimeout> | null = null
  const dismiss = (): void => {
    if (timer) clearTimeout(timer)
    notice.remove()
  }
  close.addEventListener('click', dismiss)
  notice.append(text, close)
  region.append(notice)
  timer = setTimeout(dismiss, duration)
  return notice
}
