/**
 * Reading an RVC retrieval index. SPEC section 5.
 *
 * Every RVC voice ships two files: the model, and an *index* of the features of
 * the audio it was trained on. Running without the index -- which is what
 * `index_rate: 0` means, and what this application did at first -- produces a
 * conversion that is recognisably in the right direction and generically so.
 * It is the difference people mean when they say a conversion sounds untuned.
 *
 * The index is a faiss `IndexIVFFlat`. That format matters more than it looks:
 * a flat index would mean comparing each frame against all 77,000 training
 * vectors, which is far too slow in a reading application. An inverted file
 * groups them into clusters around 1,985 centres, so a frame is compared
 * against the centres and then against only the ~39 vectors in the nearest one.
 *
 * The parsing is pure and the search is arithmetic, so both live here and are
 * tested without a 233 MB file present.
 */

export interface IvfIndex {
  /** Feature dimension. 768 for the ContentVec encoder RVC v2 uses. */
  readonly dim: number
  readonly total: number
  /** Cluster centres, `[lists][dim]`. */
  readonly centroids: Float32Array
  readonly lists: number
  /** Where each list starts in `vectors`, in vectors. Length is `lists + 1`. */
  readonly offsets: Int32Array
  /** Every training vector, grouped by the list it belongs to. */
  readonly vectors: Float32Array
}

class Cursor {
  private at = 0
  constructor(private readonly bytes: Uint8Array, private readonly view: DataView) {}

  fourcc(): string {
    let out = ''
    for (let k = 0; k < 4; k += 1) out += String.fromCharCode(this.bytes[this.at + k] ?? 0)
    this.at += 4
    return out
  }

  u8(): number {
    const value = this.bytes[this.at] ?? 0
    this.at += 1
    return value
  }

  i32(): number {
    const value = this.view.getInt32(this.at, true)
    this.at += 4
    return value
  }

  /** faiss writes sizes as 64-bit; every one here fits in a double comfortably. */
  u64(): number {
    const value = Number(this.view.getBigUint64(this.at, true))
    this.at += 8
    return value
  }

  skip(bytes: number): void {
    this.at += bytes
  }

  get offset(): number {
    return this.at
  }

  /** A block of little-endian floats, copied out. */
  floats(count: number): Float32Array {
    const out = new Float32Array(count)
    // Copied element by element rather than through a typed-array view: the
    // data is not four-byte aligned in the file, and a view would throw.
    for (let k = 0; k < count; k += 1) out[k] = this.view.getFloat32(this.at + k * 4, true)
    this.at += count * 4
    return out
  }

  floatsInto(target: Float32Array, at: number, count: number): void {
    for (let k = 0; k < count; k += 1) target[at + k] = this.view.getFloat32(this.at + k * 4, true)
    this.at += count * 4
  }
}

/** Skip the fields every faiss index writes before its own. */
function readHeader(cursor: Cursor): { dim: number; total: number } {
  const dim = cursor.i32()
  const total = cursor.u64()
  cursor.u64()
  cursor.u64()
  cursor.u8()
  const metric = cursor.i32()
  // Metrics past L2 carry an extra argument. None of the ones RVC produces do,
  // but reading past it costs nothing and misreading it costs everything.
  if (metric > 1) cursor.skip(4)
  return { dim, total }
}

export function parseIvfIndex(bytes: Uint8Array): IvfIndex {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const cursor = new Cursor(bytes, view)

  const kind = cursor.fourcc()
  if (kind !== 'IwFl') {
    throw new Error(`not an IndexIVFFlat: ${JSON.stringify(kind)}`)
  }

  const { dim, total } = readHeader(cursor)
  const lists = cursor.u64()
  cursor.u64() // nprobe, which this decides for itself

  /*
    The quantizer: a flat index of the cluster centres.

    Its vectors are written as a count of *elements* rather than of bytes, which
    is the one place this format will silently mislead a reader -- the number
    looks like a byte count and is a quarter of one.
  */
  const quantizer = cursor.fourcc()
  if (!quantizer.startsWith('IxF')) {
    throw new Error(`unexpected quantizer: ${JSON.stringify(quantizer)}`)
  }
  const quantizerHeader = readHeader(cursor)
  const centroidCount = cursor.u64()
  const centroids =
    centroidCount === quantizerHeader.total * dim
      ? cursor.floats(centroidCount)
      : // Newer faiss writes the centres as raw bytes instead.
        cursor.floats(centroidCount / 4)

  // The direct map, which RVC does not build.
  cursor.u8()
  cursor.skip(cursor.u64() * 8)

  const invertedKind = cursor.fourcc()
  if (invertedKind !== 'ilar') {
    throw new Error(`unexpected inverted lists: ${JSON.stringify(invertedKind)}`)
  }
  const listCount = cursor.u64()
  const codeSize = cursor.u64()
  if (codeSize !== dim * 4) {
    throw new Error(`expected raw float vectors, got ${codeSize} bytes per entry`)
  }

  const layout = cursor.fourcc()
  if (layout !== 'full') {
    throw new Error(`unsupported list layout: ${JSON.stringify(layout)}`)
  }

  const sizeCount = cursor.u64()
  const offsets = new Int32Array(listCount + 1)
  let running = 0
  for (let list = 0; list < sizeCount; list += 1) {
    offsets[list] = running
    running += cursor.u64()
  }
  offsets[listCount] = running

  /*
    Vectors, grouped by list, with the ids skipped.

    RVC reconstructs the whole set and searches it as one array; searching the
    lists in place needs no ids at all, because the vectors it would look up are
    already the ones in the list being searched.
  */
  const vectors = new Float32Array(running * dim)
  for (let list = 0; list < listCount; list += 1) {
    const size = (offsets[list + 1] ?? 0) - (offsets[list] ?? 0)
    cursor.skip(size * 8)
    cursor.floatsInto(vectors, (offsets[list] ?? 0) * dim, size * dim)
  }

  return { dim, total, centroids, lists: listCount, offsets, vectors }
}

/**
 * Replace a frame's features with a blend of the nearest training features.
 *
 * This is what makes a conversion sound like the voice rather than merely
 * unlike the original: instead of asking the model to interpret whatever the
 * encoder produced, it is handed the closest thing the *character* actually
 * said, so the model is working in territory it was trained on.
 *
 * The eight nearest neighbours weighted by the inverse square of their
 * distance, which is what RVC does. One neighbour would snap each frame to a
 * single training moment and buzz; eight is enough to average smoothly and few
 * enough to stay close.
 */
export function retrieveFrame(
  index: IvfIndex,
  query: Float32Array,
  queryAt: number,
  out: Float32Array,
  outAt: number,
  neighbours = 8
): void {
  const { dim, centroids, lists, offsets, vectors } = index

  // The nearest cluster. Only its vectors are then considered, which is the
  // whole reason this is fast enough to run per frame.
  let bestList = 0
  let bestDistance = Infinity
  for (let list = 0; list < lists; list += 1) {
    const base = list * dim
    let distance = 0
    for (let k = 0; k < dim; k += 1) {
      const delta = (query[queryAt + k] ?? 0) - (centroids[base + k] ?? 0)
      distance += delta * delta
    }
    if (distance < bestDistance) {
      bestDistance = distance
      bestList = list
    }
  }

  const from = offsets[bestList] ?? 0
  const size = (offsets[bestList + 1] ?? 0) - from
  if (size === 0) {
    for (let k = 0; k < dim; k += 1) out[outAt + k] = query[queryAt + k] ?? 0
    return
  }

  const take = Math.min(neighbours, size)
  const bestIndex = new Int32Array(take).fill(-1)
  const bestScore = new Float64Array(take).fill(Infinity)

  for (let entry = 0; entry < size; entry += 1) {
    const base = (from + entry) * dim
    let distance = 0
    for (let k = 0; k < dim; k += 1) {
      const delta = (query[queryAt + k] ?? 0) - (vectors[base + k] ?? 0)
      distance += delta * delta
    }
    if (distance >= (bestScore[take - 1] ?? Infinity)) continue

    // An insertion sort over eight entries, which beats a heap at this size.
    let slot = take - 1
    while (slot > 0 && (bestScore[slot - 1] ?? Infinity) > distance) {
      bestScore[slot] = bestScore[slot - 1] ?? Infinity
      bestIndex[slot] = bestIndex[slot - 1] ?? -1
      slot -= 1
    }
    bestScore[slot] = distance
    bestIndex[slot] = from + entry
  }

  /*
    Weighted by the inverse square of the distance.

    An exact match has distance zero, and dividing by it would put an infinity
    into the features and silence the sentence. It is floored instead, which
    makes an exact match merely dominant rather than absolute.
  */
  let totalWeight = 0
  const weights = new Float64Array(take)
  for (let n = 0; n < take; n += 1) {
    if ((bestIndex[n] ?? -1) < 0) continue
    const distance = Math.max(bestScore[n] ?? 0, 1e-8)
    const weight = 1 / (distance * distance)
    weights[n] = weight
    totalWeight += weight
  }

  if (totalWeight === 0) {
    for (let k = 0; k < dim; k += 1) out[outAt + k] = query[queryAt + k] ?? 0
    return
  }

  for (let k = 0; k < dim; k += 1) out[outAt + k] = 0
  for (let n = 0; n < take; n += 1) {
    const at = bestIndex[n] ?? -1
    if (at < 0) continue
    const share = (weights[n] ?? 0) / totalWeight
    const base = at * dim
    for (let k = 0; k < dim; k += 1) {
      out[outAt + k] = (out[outAt + k] ?? 0) + share * (vectors[base + k] ?? 0)
    }
  }
}

/**
 * Retrieve every frame, and mix the result back in.
 *
 * `rate` is how much of the retrieved features to keep. RVC exposes it because
 * the trade is real in both directions: all the way up the voice is most
 * faithfully the character and least faithful to what was said, and all the way
 * down is the reverse.
 */
export function retrieve(
  index: IvfIndex,
  features: Float32Array,
  frames: number,
  rate: number
): Float32Array {
  if (rate <= 0) return features

  const { dim } = index
  const retrieved = new Float32Array(frames * dim)
  for (let frame = 0; frame < frames; frame += 1) {
    retrieveFrame(index, features, frame * dim, retrieved, frame * dim)
  }

  const keep = 1 - rate
  const out = new Float32Array(frames * dim)
  for (let at = 0; at < out.length; at += 1) {
    out[at] = (retrieved[at] ?? 0) * rate + (features[at] ?? 0) * keep
  }
  return out
}

/**
 * Put the original features back where there is no pitch.
 *
 * Unvoiced sounds -- t, k, p, s, and breath -- are where a converter does its
 * worst work, because it is being asked to reproduce noise as if it were a
 * voice. Measured on a t-heavy sentence, conversion added two and a half times
 * the energy in the 4-8 kHz band, which is heard as spitting on every T.
 *
 * The pitch tracker already says which frames those are: it returns zero for
 * them. So on those frames the retrieved features are faded back toward what
 * the base voice actually said, which keeps its consonants and leaves the
 * vowels -- where the character's identity lives -- entirely converted.
 *
 * This is RVC's `protect`, and it does nothing without retrieval: with no
 * retrieval the two sets of features are the same and the blend is a no-op.
 */
export function protectUnvoiced(
  retrieved: Float32Array,
  original: Float32Array,
  f0: Float32Array,
  frames: number,
  dim: number,
  protect: number
): Float32Array {
  if (protect >= 0.5) return retrieved

  const out = new Float32Array(retrieved.length)
  for (let frame = 0; frame < frames; frame += 1) {
    const voiced = (f0[frame] ?? 0) > 0
    const share = voiced ? 1 : protect
    const base = frame * dim
    for (let k = 0; k < dim; k += 1) {
      out[base + k] = (retrieved[base + k] ?? 0) * share + (original[base + k] ?? 0) * (1 - share)
    }
  }
  return out
}
