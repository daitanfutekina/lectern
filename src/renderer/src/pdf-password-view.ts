export interface PdfPasswordRequest {
  readonly name: string
  readonly incorrect: boolean
}

let promptQueue: Promise<void> = Promise.resolve()

/** Serialize prompts because library scans can discover several protected PDFs together. */
export function promptForPdfPassword(request: PdfPasswordRequest): Promise<string | null> {
  let answer!: (password: string | null) => void
  const result = new Promise<string | null>((resolve) => {
    answer = resolve
  })

  promptQueue = promptQueue.then(
    () => showPrompt(request).then(answer),
    () => showPrompt(request).then(answer)
  )
  return result
}

function showPrompt(request: PdfPasswordRequest): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div')
    backdrop.className = 'pdf-password-backdrop'

    const dialog = document.createElement('form')
    dialog.className = 'pdf-password-dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'pdf-password-title')

    const title = document.createElement('h2')
    title.id = 'pdf-password-title'
    title.textContent = 'Password required'

    const message = document.createElement('p')
    message.textContent = request.incorrect
      ? `That password did not open ${request.name}. Try again.`
      : `${request.name} is password protected.`

    const input = document.createElement('input')
    input.type = 'password'
    input.autocomplete = 'current-password'
    input.setAttribute('aria-label', 'PDF password')

    const actions = document.createElement('div')
    actions.className = 'pdf-password-actions'

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'Cancel'

    const open = document.createElement('button')
    open.type = 'submit'
    open.className = 'primary'
    open.textContent = 'Open PDF'

    const finish = (password: string | null): void => {
      document.removeEventListener('keydown', onKeyDown)
      backdrop.remove()
      resolve(password)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish(null)
    }

    cancel.addEventListener('click', () => finish(null))
    dialog.addEventListener('submit', (event) => {
      event.preventDefault()
      finish(input.value)
    })
    document.addEventListener('keydown', onKeyDown)

    actions.append(cancel, open)
    dialog.append(title, message, input, actions)
    backdrop.append(dialog)
    document.body.append(backdrop)
    input.focus()
  })
}
