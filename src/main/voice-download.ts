import { createHash } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { unzip } from 'fflate'
import { piperOnnxMetadata, piperTokens } from '@shared/piper-model'
import {
  downloadVoice,
  type VoiceDownloadFile,
  type VoiceDownloadManifest,
  type VoiceDownloadProgress,
  type VoiceDownloadResult,
  type VoiceDownloadSink,
  type VoiceDownloadTransport,
  type VoiceInstallTarget
} from '@shared/voice-download'

const VOICE_ID = 'vits-piper-en_US-lessac-medium'
const MODEL = 'en_US-lessac-medium.onnx'
const CONFIG = `${MODEL}.json`
const SUPPORT = 'piper_windows_amd64.zip'

/**
 * The model and config are the official v1.0.0 Piper files. Their sizes and
 * MD5 digests are published in that tag's voices.json. The support archive is
 * the official Piper Windows release; only its eSpeak data is retained.
 */
export const DEFAULT_VOICE: VoiceDownloadManifest = {
  id: VOICE_ID,
  label: 'Lessac (en US, medium)',
  files: [
    {
      name: MODEL,
      label: 'voice model',
      url:
        'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx',
      bytes: 63_201_294,
      hash: { algorithm: 'md5', value: '2fc642b535197b6305c7c8f92dc8b24f' }
    },
    {
      name: CONFIG,
      label: 'voice configuration',
      url:
        'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json',
      bytes: 4_885,
      hash: { algorithm: 'md5', value: 'c1f2b7bddefe113f3255ff9ef234cfd3' }
    },
    {
      name: SUPPORT,
      label: 'pronunciation data',
      url:
        'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
      hash: {
        algorithm: 'sha256',
        value: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea'
      }
    }
  ]
}

export async function installDefaultVoice(
  libraryRoot: string,
  transport: VoiceDownloadTransport,
  signal: AbortSignal,
  onProgress: (progress: VoiceDownloadProgress) => void
): Promise<VoiceDownloadResult> {
  const target = new PiperVoiceTarget(libraryRoot, DEFAULT_VOICE)
  return downloadVoice(DEFAULT_VOICE, transport, target, signal, onProgress)
}

class PiperVoiceTarget implements VoiceInstallTarget {
  private readonly voices: string
  private readonly final: string
  private readonly temporary: string
  private readonly handles = new Set<FileHandle>()

  constructor(libraryRoot: string, private readonly manifest: VoiceDownloadManifest) {
    this.voices = join(libraryRoot, '.library', 'voices')
    this.final = join(this.voices, manifest.id)
    this.temporary = join(this.voices, `${manifest.id}.download`)
  }

  async prepare(): Promise<'ready' | 'already-installed'> {
    if (await exists(this.final)) return 'already-installed'
    await mkdir(this.voices, { recursive: true })
    // A terminated process can leave only this deliberately named sibling.
    await rm(this.temporary, { recursive: true, force: true })
    await mkdir(this.temporary)
    return 'ready'
  }

  async open(file: VoiceDownloadFile): Promise<VoiceDownloadSink> {
    const handle = await open(join(this.temporary, file.name), 'wx')
    const hash = createHash(file.hash.algorithm)
    this.handles.add(handle)
    let bytes = 0

    return {
      write: async (chunk) => {
        await writeAll(handle, chunk)
        hash.update(chunk)
        bytes += chunk.byteLength
      },
      finish: async () => {
        await handle.close()
        this.handles.delete(handle)
        return { bytes, hash: hash.digest('hex') }
      }
    }
  }

  async install(signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal)
    const config = JSON.parse(await readFile(join(this.temporary, CONFIG), 'utf8')) as unknown
    await writeFile(join(this.temporary, 'tokens.txt'), piperTokens(config), 'utf8')
    await appendFile(join(this.temporary, MODEL), piperOnnxMetadata(config))
    await extractEspeak(
      join(this.temporary, SUPPORT),
      join(this.temporary, 'espeak-ng-data'),
      signal
    )
    throwIfCancelled(signal)
    await rm(join(this.temporary, SUPPORT), { force: true })
    // The folder becomes visible to listVoices atomically, after every required
    // file exists and every remote byte has passed its integrity check.
    await rename(this.temporary, this.final)
  }

  async discard(): Promise<void> {
    await Promise.allSettled([...this.handles].map((handle) => handle.close()))
    this.handles.clear()
    await rm(this.temporary, { recursive: true, force: true })
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
    if (bytesWritten === 0) throw new Error('Could not write the voice download')
    offset += bytesWritten
  }
}

async function extractEspeak(
  zipPath: string,
  destination: string,
  signal: AbortSignal
): Promise<void> {
  const archive = await readFile(zipPath)
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(
      archive,
      {
        filter: (entry) => entry.name.replace(/\\/g, '/').includes('/espeak-ng-data/')
      },
      (error, result) => (error ? reject(error) : resolve(result))
    )
  })

  const entries = Object.entries(files)
    .map(([name, data]) => ({ relative: espeakRelative(name), data }))
    .filter((entry): entry is { relative: string; data: Uint8Array } => Boolean(entry.relative))
  if (entries.length === 0) throw new Error('The pronunciation archive contained no eSpeak data')

  for (const entry of entries) {
    throwIfCancelled(signal)
    const path = join(destination, entry.relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, entry.data)
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The download was cancelled', 'AbortError')
}

function espeakRelative(name: string): string | null {
  const normal = name.replace(/\\/g, '/')
  const marker = '/espeak-ng-data/'
  const at = normal.indexOf(marker)
  if (at < 0) return null
  const relative = normal.slice(at + marker.length)
  if (!relative || relative.split('/').includes('..')) return null
  return relative
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
