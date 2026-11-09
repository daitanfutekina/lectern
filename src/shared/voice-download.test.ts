import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  downloadVoice,
  type VoiceDownloadFile,
  type VoiceDownloadManifest,
  type VoiceDownloadSink,
  type VoiceDownloadTransport,
  type VoiceInstallTarget
} from './voice-download'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')

function fixture(value = bytes('voice model')): VoiceDownloadManifest {
  return {
    id: 'test-voice',
    label: 'Test voice',
    files: [
      {
        name: 'voice.onnx',
        label: 'voice model',
        url: 'https://example.test/voice.onnx',
        bytes: value.byteLength,
        hash: { algorithm: 'sha256', value: digest(value) }
      }
    ]
  }
}

class MemoryTarget implements VoiceInstallTarget {
  readonly files = new Map<string, Uint8Array>()
  readonly events: string[] = []
  constructor(private readonly installed = false) {}

  async prepare(): Promise<'ready' | 'already-installed'> {
    this.events.push('prepare-temp')
    return this.installed ? 'already-installed' : 'ready'
  }

  async open(file: VoiceDownloadFile): Promise<VoiceDownloadSink> {
    const chunks: Uint8Array[] = []
    return {
      write: async (chunk) => {
        chunks.push(chunk)
      },
      finish: async () => {
        const value = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
        this.files.set(file.name, Uint8Array.from(value))
        return {
          bytes: value.byteLength,
          hash: createHash(file.hash.algorithm).update(value).digest('hex')
        }
      }
    }
  }

  async install(): Promise<void> {
    this.events.push('rename-temp')
  }

  async discard(): Promise<void> {
    this.events.push('remove-temp')
    this.files.clear()
  }
}

function stubTransport(value: Uint8Array): VoiceDownloadTransport {
  return vi.fn(async () => ({
    contentLength: value.byteLength,
    body: (async function* () {
      yield value.subarray(0, 3)
      yield value.subarray(3)
    })()
  }))
}

describe('voice download', () => {
  it('does no network work until called, then verifies before renaming the temp install', async () => {
    const value = bytes('voice model')
    const transport = stubTransport(value)
    const target = new MemoryTarget()
    const progress = vi.fn()

    expect(transport).not.toHaveBeenCalled()
    await expect(
      downloadVoice(fixture(value), transport, target, new AbortController().signal, progress)
    ).resolves.toEqual({ status: 'installed' })

    expect(transport).toHaveBeenCalledOnce()
    expect(target.files.get('voice.onnx')).toEqual(value)
    expect(target.events).toEqual(['prepare-temp', 'rename-temp'])
    expect(progress).toHaveBeenLastCalledWith({
      phase: 'installing',
      file: 'Test voice',
      downloaded: value.byteLength,
      total: value.byteLength
    })
  })

  it('removes the temp install when integrity verification fails', async () => {
    const value = bytes('corrupt')
    const target = new MemoryTarget()
    const manifest = fixture(bytes('expected'))

    const result = await downloadVoice(
      { ...manifest, files: [{ ...manifest.files[0]!, bytes: value.byteLength }] },
      stubTransport(value),
      target,
      new AbortController().signal
    )

    expect(result).toEqual({ status: 'failed', message: 'voice model failed its integrity check' })
    expect(target.events).toEqual(['prepare-temp', 'remove-temp'])
    expect(target.files.size).toBe(0)
  })

  it('cancels an in-flight transport and removes the temp install', async () => {
    const controller = new AbortController()
    const target = new MemoryTarget()
    const value = bytes('voice model')
    const transport: VoiceDownloadTransport = async () => ({
      body: (async function* () {
        yield value.subarray(0, 3)
        controller.abort()
        yield value.subarray(3)
      })()
    })

    await expect(
      downloadVoice(fixture(value), transport, target, controller.signal)
    ).resolves.toEqual({ status: 'cancelled' })
    expect(target.events).toEqual(['prepare-temp', 'remove-temp'])
  })

  it('fails cleanly when the transport is offline', async () => {
    const target = new MemoryTarget()
    const transport: VoiceDownloadTransport = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })

    await expect(
      downloadVoice(fixture(), transport, target, new AbortController().signal)
    ).resolves.toEqual({
      status: 'failed',
      message: 'Could not download the voice. Check your connection and try again.'
    })
    expect(target.events).toEqual(['prepare-temp', 'remove-temp'])
  })
})
