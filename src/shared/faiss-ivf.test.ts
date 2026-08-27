import { describe, expect, it } from 'vitest'
import {
  parseIvfIndex,
  protectUnvoiced,
  retrieve,
  retrieveFrame,
  type IvfIndex
} from './faiss-ivf'

/**
 * The retrieval index, built in miniature.
 *
 * A real one is 233 MB, so the parser is tested against a file written here
 * from the format's own rules. That is worth more than testing against the real
 * file anyway: a test that only ever sees one index cannot tell a correct parse
 * from one that happens to suit that index.
 */

/** Write a faiss `IndexIVFFlat` with the given clusters. */
function buildIndex(dim: number, centroids: number[][], lists: number[][][]): Uint8Array {
  const parts: number[] = []
  const push = (...bytes: number[]): void => {
    for (const byte of bytes) parts.push(byte)
  }
  const fourcc = (text: string): void => {
    for (const character of text) push(character.charCodeAt(0))
  }
  const i32 = (value: number): void => {
    const buffer = new DataView(new ArrayBuffer(4))
    buffer.setInt32(0, value, true)
    for (let k = 0; k < 4; k += 1) push(buffer.getUint8(k))
  }
  const u64 = (value: number): void => {
    const buffer = new DataView(new ArrayBuffer(8))
    buffer.setBigUint64(0, BigInt(value), true)
    for (let k = 0; k < 8; k += 1) push(buffer.getUint8(k))
  }
  const f32 = (value: number): void => {
    const buffer = new DataView(new ArrayBuffer(4))
    buffer.setFloat32(0, value, true)
    for (let k = 0; k < 4; k += 1) push(buffer.getUint8(k))
  }

  const total = lists.reduce((sum, list) => sum + list.length, 0)
  const header = (d: number, ntotal: number): void => {
    i32(d)
    u64(ntotal)
    u64(1 << 20)
    u64(1 << 20)
    push(1)
    i32(1)
  }

  fourcc('IwFl')
  header(dim, total)
  u64(centroids.length)
  u64(1)

  // The quantizer, holding the cluster centres.
  fourcc('IxF2')
  header(dim, centroids.length)
  u64(centroids.length * dim)
  for (const centroid of centroids) for (const value of centroid) f32(value)

  // No direct map.
  push(0)
  u64(0)

  fourcc('ilar')
  u64(centroids.length)
  u64(dim * 4)
  fourcc('full')
  u64(centroids.length)
  for (const list of lists) u64(list.length)

  let id = 0
  for (const list of lists) {
    for (let k = 0; k < list.length; k += 1) {
      u64(id)
      id += 1
    }
    for (const vector of list) for (const value of vector) f32(value)
  }

  return Uint8Array.from(parts)
}

/*
  Two clusters, far apart, with two vectors each. Far apart on purpose: the
  point of most of these tests is which cluster is chosen, and clusters that
  overlap would make a wrong choice look like a right one.
*/
const DIM = 4
const SAMPLE = buildIndex(
  DIM,
  [
    [0, 0, 0, 0],
    [10, 10, 10, 10]
  ],
  [
    [
      [0, 0, 0, 1],
      [0, 0, 0, 3]
    ],
    [
      [10, 10, 10, 11],
      [10, 10, 10, 13]
    ]
  ]
)

describe('parseIvfIndex', () => {
  const index = parseIvfIndex(SAMPLE)

  it('reads the shape of the index', () => {
    expect(index.dim).toBe(DIM)
    expect(index.total).toBe(4)
    expect(index.lists).toBe(2)
  })

  it('reads the cluster centres', () => {
    expect([...index.centroids]).toEqual([0, 0, 0, 0, 10, 10, 10, 10])
  })

  it('groups the vectors by list, with the ids skipped', () => {
    // The ids are interleaved with the vectors in the file and are not needed:
    // searching a list in place already has the vectors it would look up.
    expect(index.offsets[0]).toBe(0)
    expect(index.offsets[1]).toBe(2)
    expect(index.offsets[2]).toBe(4)
    expect([...index.vectors.slice(0, 4)]).toEqual([0, 0, 0, 1])
    expect([...index.vectors.slice(8, 12)]).toEqual([10, 10, 10, 11])
  })

  it('refuses a file that is not an inverted-file index', () => {
    const wrong = Uint8Array.from(SAMPLE)
    wrong[0] = 'X'.charCodeAt(0)
    expect(() => parseIvfIndex(wrong)).toThrow(/IndexIVFFlat/)
  })
})

describe('retrieveFrame', () => {
  const index = parseIvfIndex(SAMPLE)
  const frame = (query: number[]): number[] => {
    const out = new Float32Array(DIM)
    retrieveFrame(index, Float32Array.from(query), 0, out, 0)
    return [...out]
  }

  it('searches only the nearest cluster', () => {
    // A query beside the first centre must not come back with anything from the
    // second, however the weighting works out.
    const near = frame([0, 0, 0, 2])
    expect(near[0]).toBeLessThan(1)
    const far = frame([10, 10, 10, 12])
    expect(far[0]).toBeGreaterThan(9)
  })

  it('blends the neighbours rather than snapping to one', () => {
    // Equidistant from both vectors in the list, so their average.
    const blended = frame([0, 0, 0, 2])
    expect(blended[3]).toBeCloseTo(2, 4)
  })

  it('leans toward the closer neighbour', () => {
    const leaning = frame([0, 0, 0, 1.2])
    expect(leaning[3]).toBeGreaterThan(1)
    expect(leaning[3]).toBeLessThan(1.5)
  })

  it('survives an exact match without dividing by zero', () => {
    // Inverse-square weighting on a distance of zero is an infinity, and an
    // infinity in the features silences the sentence.
    const exact = frame([0, 0, 0, 1])
    for (const value of exact) expect(Number.isFinite(value)).toBe(true)
    expect(exact[3]).toBeCloseTo(1, 3)
  })
})

describe('retrieve', () => {
  const index = parseIvfIndex(SAMPLE)

  it('does nothing at a rate of zero', () => {
    const features = Float32Array.from([0, 0, 0, 2])
    expect(retrieve(index, features, 1, 0)).toBe(features)
  })

  it('mixes toward the retrieved features', () => {
    const features = Float32Array.from([0, 0, 0, 10])

    // What retrieval alone would give, computed rather than assumed: the
    // neighbours are weighted by distance, so it is not their plain average.
    const pure = new Float32Array(DIM)
    retrieveFrame(index, features, 0, pure, 0)

    const half = retrieve(index, features, 1, 0.5)
    expect(half[3]).toBeCloseTo(((pure[3] ?? 0) + 10) / 2, 4)

    // And the ends of the range are the two things being mixed.
    expect(retrieve(index, features, 1, 1)[3]).toBeCloseTo(pure[3] ?? 0, 4)
    expect(half[3]).toBeGreaterThan(pure[3] ?? 0)
    expect(half[3]).toBeLessThan(10)
  })

  it('handles every frame', () => {
    const features = Float32Array.from([0, 0, 0, 2, 10, 10, 10, 12])
    const out = retrieve(index, features, 2, 1)
    expect(out[3]).toBeCloseTo(2, 3)
    expect(out[7]).toBeCloseTo(12, 3)
  })
})

describe('protectUnvoiced', () => {
  const retrieved = Float32Array.from([1, 1, 2, 2])
  const original = Float32Array.from([5, 5, 6, 6])
  const f0 = Float32Array.from([100, 0])

  it('leaves voiced frames converted', () => {
    const out = protectUnvoiced(retrieved, original, f0, 2, 2, 0.33)
    expect(out[0]).toBeCloseTo(1, 5)
    expect(out[1]).toBeCloseTo(1, 5)
  })

  it('fades unvoiced frames back toward the base voice', () => {
    const out = protectUnvoiced(retrieved, original, f0, 2, 2, 0.33)
    // 2 * 0.33 + 6 * 0.67
    expect(out[2]).toBeCloseTo(2 * 0.33 + 6 * 0.67, 4)
  })

  it('is off at a half, which is how RVC spells off', () => {
    expect(protectUnvoiced(retrieved, original, f0, 2, 2, 0.5)).toBe(retrieved)
  })

  it('replaces unvoiced frames entirely at zero', () => {
    const out = protectUnvoiced(retrieved, original, f0, 2, 2, 0)
    expect(out[2]).toBeCloseTo(6, 5)
    expect(out[0]).toBeCloseTo(1, 5)
  })
})
