/** One file needed to install the built-in Piper voice. */
export interface VoiceDownloadFile {
  readonly name: string
  readonly label: string
  readonly url: string
  readonly bytes?: number
  readonly hash: { readonly algorithm: 'md5' | 'sha256'; readonly value: string }
}

export interface VoiceDownloadManifest {
  readonly id: string
  readonly label: string
  readonly files: readonly VoiceDownloadFile[]
}

export interface VoiceDownloadProgress {
  readonly phase: 'downloading' | 'installing'
  readonly file: string
  readonly downloaded: number
  readonly total: number | null
}

export type VoiceDownloadResult =
  | { readonly status: 'installed' | 'already-installed' | 'cancelled' }
  | { readonly status: 'failed'; readonly message: string }

export interface VoiceDownloadResponse {
  readonly body: AsyncIterable<Uint8Array>
  readonly contentLength?: number
}

export type VoiceDownloadTransport = (
  url: string,
  signal: AbortSignal
) => Promise<VoiceDownloadResponse>

export interface VoiceDownloadSink {
  write(chunk: Uint8Array): Promise<void>
  finish(): Promise<{ bytes: number; hash: string }>
}

export interface VoiceInstallTarget {
  prepare(): Promise<'ready' | 'already-installed'>
  open(file: VoiceDownloadFile): Promise<VoiceDownloadSink>
  install(signal: AbortSignal): Promise<void>
  discard(): Promise<void>
}

/**
 * Download, verify, and install one voice through injected I/O boundaries.
 *
 * Keeping the control flow here makes cancellation, verification, and cleanup
 * testable without Electron, a real network, or a particular filesystem.
 */
export async function downloadVoice(
  manifest: VoiceDownloadManifest,
  transport: VoiceDownloadTransport,
  target: VoiceInstallTarget,
  signal: AbortSignal,
  onProgress: (progress: VoiceDownloadProgress) => void = () => {}
): Promise<VoiceDownloadResult> {
  try {
    if ((await target.prepare()) === 'already-installed') {
      return { status: 'already-installed' }
    }

    let completed = 0
    for (const [index, file] of manifest.files.entries()) {
      throwIfCancelled(signal)
      const response = await transport(file.url, signal)
      throwIfCancelled(signal)

      // A server may omit Content-Length, so exact downloaded bytes and hashes
      // remain the integrity check. The header is used only to improve progress.
      const currentSize = file.bytes ?? response.contentLength
      const remaining = manifest.files.slice(index + 1)
      const progressTotal =
        currentSize !== undefined && remaining.every((entry) => entry.bytes !== undefined)
          ? completed + currentSize + remaining.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
          : null

      const sink = await target.open(file)
      let inFile = 0
      for await (const chunk of response.body) {
        throwIfCancelled(signal)
        await sink.write(chunk)
        inFile += chunk.byteLength
        onProgress({
          phase: 'downloading',
          file: file.label,
          downloaded: completed + inFile,
          total: progressTotal
        })
      }

      const received = await sink.finish()
      if (file.bytes !== undefined && received.bytes !== file.bytes) {
        throw new Error(`${file.label} was incomplete`)
      }
      if (received.hash.toLowerCase() !== file.hash.value.toLowerCase()) {
        throw new Error(`${file.label} failed its integrity check`)
      }
      completed += received.bytes
    }

    throwIfCancelled(signal)
    onProgress({ phase: 'installing', file: manifest.label, downloaded: completed, total: completed })
    await target.install(signal)
    throwIfCancelled(signal)
    return { status: 'installed' }
  } catch (error) {
    await target.discard()
    if (signal.aborted || isAbortError(error)) return { status: 'cancelled' }
    return {
      status: 'failed',
      message: friendlyDownloadError(error)
    }
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The download was cancelled', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function friendlyDownloadError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/integrity check|incomplete|unexpected download size/i.test(detail)) return detail
  return 'Could not download the voice. Check your connection and try again.'
}
