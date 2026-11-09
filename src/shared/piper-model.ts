interface PiperConfig {
  readonly audio: { readonly sample_rate: number }
  readonly espeak: { readonly voice: string }
  readonly language: { readonly name_english: string }
  readonly num_speakers: number
  readonly phoneme_id_map: Readonly<Record<string, readonly number[]>>
}

/** Build the token table sherpa expects from an official Piper config. */
export function piperTokens(value: unknown): string {
  const config = piperConfig(value)
  return Object.entries(config.phoneme_id_map)
    .map(([token, ids]) => {
      const id = ids[0]
      if (!Number.isInteger(id)) throw new Error('The Piper config has an invalid phoneme id')
      return `${token} ${id}`
    })
    .join('\n') + '\n'
}

/**
 * Encode the metadata fields sherpa requires as appendable ONNX protobuf data.
 *
 * ONNX metadata_props is repeated field 14. Protobuf fields may appear in any
 * order, so appending these entries converts the official model without
 * loading and rewriting its 63 MB graph.
 */
export function piperOnnxMetadata(value: unknown): Uint8Array {
  const config = piperConfig(value)
  const entries: Readonly<Record<string, string>> = {
    model_type: 'vits',
    comment: 'piper',
    language: config.language.name_english,
    voice: config.espeak.voice,
    has_espeak: '1',
    n_speakers: String(config.num_speakers),
    sample_rate: String(config.audio.sample_rate)
  }
  return concat(
    Object.entries(entries).map(([key, entry]) => field(14, message([[1, key], [2, entry]])))
  )
}

function piperConfig(value: unknown): PiperConfig {
  if (!value || typeof value !== 'object') throw new Error('The Piper config is invalid')
  const candidate = value as Partial<PiperConfig>
  if (
    !candidate.audio ||
    !Number.isInteger(candidate.audio.sample_rate) ||
    !candidate.espeak ||
    typeof candidate.espeak.voice !== 'string' ||
    !candidate.language ||
    typeof candidate.language.name_english !== 'string' ||
    !Number.isInteger(candidate.num_speakers) ||
    !candidate.phoneme_id_map ||
    typeof candidate.phoneme_id_map !== 'object'
  ) {
    throw new Error('The Piper config is invalid')
  }
  return candidate as PiperConfig
}

function message(entries: readonly (readonly [number, string])[]): Uint8Array {
  return concat(entries.map(([number, value]) => field(number, new TextEncoder().encode(value))))
}

function field(number: number, value: Uint8Array): Uint8Array {
  return concat([varint((number << 3) | 2), varint(value.byteLength), value])
}

function varint(value: number): Uint8Array {
  const bytes: number[] = []
  let rest = value
  do {
    const next = rest & 0x7f
    rest = Math.floor(rest / 128)
    bytes.push(rest > 0 ? next | 0x80 : next)
  } while (rest > 0)
  return Uint8Array.from(bytes)
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}
