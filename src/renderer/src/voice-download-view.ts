import type { VoiceDownloadProgress, VoiceDownloadResult } from '@shared/voice-download'

export interface VoiceDownloadActions {
  readonly start: (onProgress: (progress: VoiceDownloadProgress) => void) => Promise<VoiceDownloadResult>
  readonly cancel: () => void
  readonly installed: () => void
}

/** A download control shared by Settings and the first empty shelf. */
export function voiceDownloadControl(actions: VoiceDownloadActions): HTMLElement {
  const control = document.createElement('div')
  control.className = 'voice-download'

  const buttons = document.createElement('div')
  buttons.className = 'voice-download-buttons'

  const download = document.createElement('button')
  download.type = 'button'
  download.className = 'settings-button voice-download-start'
  download.textContent = 'Download free neural voice'

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'settings-button'
  cancel.textContent = 'Cancel'
  cancel.hidden = true

  const progress = document.createElement('progress')
  progress.className = 'voice-download-progress'
  progress.hidden = true

  const status = document.createElement('span')
  status.className = 'voice-download-status'
  status.setAttribute('aria-live', 'polite')

  download.addEventListener('click', () => {
    download.disabled = true
    cancel.disabled = false
    cancel.hidden = false
    progress.hidden = false
    progress.removeAttribute('value')
    status.textContent = 'Starting downloadâ€¦'

    void actions
      .start((update) => showProgress(progress, status, update))
      .then((result) => {
        if (result.status === 'installed' || result.status === 'already-installed') {
          progress.value = 1
          progress.max = 1
          status.textContent = 'Lessac is installed and ready.'
          actions.installed()
          return
        }
        status.textContent = result.status === 'cancelled'
          ? 'Download cancelled.'
          : result.status === 'failed'
            ? result.message
            : ''
        download.disabled = false
        progress.hidden = true
      })
      .catch(() => {
        status.textContent = 'Could not download the voice. Check your connection and try again.'
        download.disabled = false
        progress.hidden = true
      })
      .finally(() => {
        cancel.hidden = true
      })
  })

  cancel.addEventListener('click', () => {
    cancel.disabled = true
    status.textContent = 'Cancellingâ€¦'
    actions.cancel()
  })

  buttons.append(download, cancel)
  control.append(buttons, progress, status)
  return control
}

function showProgress(
  bar: HTMLProgressElement,
  status: HTMLElement,
  progress: VoiceDownloadProgress
): void {
  if (progress.phase === 'installing') {
    bar.removeAttribute('value')
    status.textContent = 'Installing the verified voiceâ€¦'
    return
  }

  if (progress.total === null) bar.removeAttribute('value')
  else {
    bar.max = progress.total
    bar.value = progress.downloaded
  }
  status.textContent = `Downloading ${progress.file}: ${megabytes(progress.downloaded)}`
}

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`
}
