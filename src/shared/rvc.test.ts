import { describe, expect, it } from 'vitest'
import {
  FRAME_RATE,
  RMVPE_MEL,
  coarsePitch,
  commonLength,
  decodePitch,
  logMel,
  padFrames,
  transpose,
  upsampleFeatures
} from './rvc'

/**
 * The glue between the three models in the conversion chain.
 *
 * Every function here sits between two neural networks, which means a mistake
 * in one is invisible: the tensors still have the right shape, the models still
 * run, and the audio still plays. Only the voice is wrong.
 */

/** A salience row with a single confident bin, which is the easy case to reason about. */
function spike(frames: number, bins: number[], confidence = 1): Float32Array {
  const salience = new Float32Array(frames * 360)
  for (let frame = 0; frame < frames; frame += 1) {
    salience[frame * 360 + (bins[frame] ?? 0)] = confidence
  }
  return salience
}

describe('the spectrogram RMVPE expects', () => {
  it('runs at the rate the voice model wants', () => {
    // Both sides of this have to agree or the pitch drifts against the words.
    expect(FRAME_RATE).toBe(100)
    expect(RMVPE_MEL.sampleRate / RMVPE_MEL.hop).toBe(FRAME_RATE)
  })
})

describe('logMel', () => {
  it('floors silence instead of returning negative infinity', () => {
    const mel = logMel(new Float32Array(4 * 3), 4, 3, new Float32Array(2 * 4).fill(1), 2, 1e-5)
    // Five places: the accumulator is float32, and log(1e-5) is -11.5.
    for (const value of mel) expect(value).toBeCloseTo(Math.log(1e-5), 5)
  })

  it('applies the filterbank as a matrix product', () => {
    // Two bins, two frames, one filter that takes bin 0 doubled plus bin 1.
    const magnitude = Float32Array.from([1, 2, 10, 20])
    const filters = Float32Array.from([2, 1])
    const mel = logMel(magnitude, 2, 2, filters, 1, 1e-5)

    expect(Math.exp(mel[0]!)).toBeCloseTo(2 * 1 + 1 * 10, 4)
    expect(Math.exp(mel[1]!)).toBeCloseTo(2 * 2 + 1 * 20, 4)
  })
})

describe('padFrames', () => {
  it('leaves an exact multiple alone', () => {
    const mel = new Float32Array(2 * 64)
    const padded = padFrames(mel, 2, 64, 32)
    expect(padded.frames).toBe(64)
    expect(padded.mel).toBe(mel)
  })

  it('rounds up to the next multiple and keeps the data in place', () => {
    const mel = Float32Array.from([1, 2, 3, 4, 5, 6])
    const padded = padFrames(mel, 2, 3, 4)

    expect(padded.frames).toBe(4)
    // Row-major with a longer stride: the rows must move, not merely the tail.
    expect([...padded.mel]).toEqual([1, 2, 3, 0, 4, 5, 6, 0])
  })
})

describe('decodePitch', () => {
  it('reads silence as unvoiced', () => {
    expect([...decodePitch(new Float32Array(3 * 360), 3, 0.03)]).toEqual([0, 0, 0])
  })

  it('ignores a peak below the threshold', () => {
    expect(decodePitch(spike(1, [100], 0.02), 1, 0.03)[0]).toBe(0)
  })

  it('treats sixty bins as exactly one octave', () => {
    // Twenty cents a bin, twelve hundred cents an octave. This is the property
    // that makes the whole mapping meaningful, and it is independent of where
    // the scale happens to start.
    const low = decodePitch(spike(1, [100]), 1, 0.03)[0]!
    const high = decodePitch(spike(1, [160]), 1, 0.03)[0]!
    expect(high / low).toBeCloseTo(2, 6)
  })

  it('reads a symmetric peak as its own centre', () => {
    const salience = new Float32Array(360)
    salience[99] = 0.5
    salience[100] = 1
    salience[101] = 0.5

    const centre = decodePitch(salience, 1, 0.03)[0]!
    const alone = decodePitch(spike(1, [100]), 1, 0.03)[0]!
    expect(centre).toBeCloseTo(alone, 6)
  })

  it('reads an asymmetric peak as somewhere between two bins', () => {
    // The reason for averaging at all: without it the pitch would be quantised
    // to twenty-cent steps, which is audible as a stepped contour.
    const salience = new Float32Array(360)
    salience[100] = 1
    salience[101] = 1

    const between = decodePitch(salience, 1, 0.03)[0]!
    expect(between).toBeGreaterThan(decodePitch(spike(1, [100]), 1, 0.03)[0]!)
    expect(between).toBeLessThan(decodePitch(spike(1, [101]), 1, 0.03)[0]!)
  })

  it('handles a peak at either end without reading past the array', () => {
    expect(Number.isFinite(decodePitch(spike(1, [0]), 1, 0.03)[0]!)).toBe(true)
    expect(Number.isFinite(decodePitch(spike(1, [359]), 1, 0.03)[0]!)).toBe(true)
  })
})

describe('transpose', () => {
  it('does nothing at zero', () => {
    const f0 = Float32Array.from([100, 200])
    expect(transpose(f0, 0)).toBe(f0)
  })

  it('doubles across an octave', () => {
    const shifted = transpose(Float32Array.from([100, 220]), 12)
    expect(shifted[0]).toBeCloseTo(200, 4)
    expect(shifted[1]).toBeCloseTo(440, 4)
  })

  it('leaves unvoiced frames unvoiced', () => {
    expect(transpose(Float32Array.from([0]), 7)[0]).toBe(0)
  })
})

describe('coarsePitch', () => {
  it('puts silence in the first bin', () => {
    expect(coarsePitch(Float32Array.from([0]))[0]).toBe(1n)
  })

  it('spans the trained range end to end', () => {
    // 50 Hz and 1100 Hz are the bottom and top of what the model was trained on.
    expect(coarsePitch(Float32Array.from([50]))[0]).toBe(1n)
    expect(coarsePitch(Float32Array.from([1100]))[0]).toBe(255n)
  })

  it('clamps rather than running off either end', () => {
    expect(coarsePitch(Float32Array.from([20]))[0]).toBe(1n)
    expect(coarsePitch(Float32Array.from([4000]))[0]).toBe(255n)
  })

  it('rises with pitch', () => {
    const bins = [...coarsePitch(Float32Array.from([60, 120, 240, 480]))]
    for (let at = 1; at < bins.length; at += 1) {
      expect(bins[at]!).toBeGreaterThan(bins[at - 1]!)
    }
  })

  it('spaces bins on the mel scale, not linearly', () => {
    /*
      What this buys is resolution at the bottom of the range.

      The mel curve is nearly linear below about 700 Hz and logarithmic above,
      so an octave down at the bottom of a speaking range covers a small span of
      hertz but a disproportionate share of the bins -- twenty-eight of them
      rather than the nineteen an evenly spaced table would give it. That is
      what lets one embedding table serve a bass and a soprano.
    */
    const span = (low: number, high: number): number =>
      Number(coarsePitch(Float32Array.from([high]))[0]! - coarsePitch(Float32Array.from([low]))[0]!)

    // Evenly spaced over 50 to 1100 Hz, the octave from 80 to 160 would get
    // about nineteen of the 254 bins. The mel table gives it half again more.
    const evenly = ((160 - 80) / (1100 - 50)) * 254
    expect(span(80, 160)).toBeGreaterThan(evenly * 1.3)
  })
})

describe('upsampleFeatures', () => {
  it('repeats each frame, matching the model rather than improving on it', () => {
    const features = Float32Array.from([1, 2, 3, 4])
    expect([...upsampleFeatures(features, 2, 2)]).toEqual([1, 2, 1, 2, 3, 4, 3, 4])
  })

  it('doubles the frame count', () => {
    expect(upsampleFeatures(new Float32Array(50 * 768), 50, 768)).toHaveLength(100 * 768)
  })
})

describe('commonLength', () => {
  it('takes the shortest', () => {
    expect(commonLength(600, 598, 601)).toBe(598)
  })

  it('never goes negative', () => {
    expect(commonLength(0, 5)).toBe(0)
    expect(commonLength(-3, 5)).toBe(0)
  })
})
