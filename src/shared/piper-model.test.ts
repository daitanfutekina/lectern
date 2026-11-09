import { describe, expect, it } from 'vitest'
import { piperOnnxMetadata, piperTokens } from './piper-model'

const config = {
  audio: { sample_rate: 22050 },
  espeak: { voice: 'en-us' },
  language: { name_english: 'English' },
  num_speakers: 1,
  phoneme_id_map: { _: [0], '^': [1], ' ': [3] }
}

describe('official Piper model conversion', () => {
  it('creates sherpa tokens from the first id for each phoneme', () => {
    expect(piperTokens(config)).toBe('_ 0\n^ 1\n  3\n')
  })

  it('encodes the metadata sherpa reads from the ONNX protobuf', () => {
    const encoded = new TextDecoder().decode(piperOnnxMetadata(config))
    expect(encoded).toContain('model_type')
    expect(encoded).toContain('piper')
    expect(encoded).toContain('en-us')
    expect(encoded).toContain('22050')
  })

  it('rejects a config without a phoneme map', () => {
    expect(() => piperTokens({ audio: { sample_rate: 22050 } })).toThrow('config is invalid')
  })
})
