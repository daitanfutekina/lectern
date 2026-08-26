import { describe, expect, it } from 'vitest'
import {
  fft,
  floatToPcm,
  hann,
  hzToMel,
  melFilterbank,
  melToHz,
  pcmToFloat,
  reflectPad,
  resample,
  stftMagnitude
} from './dsp'

/**
 * The signal processing under voice conversion.
 *
 * These are worth testing precisely because the failure mode is not an
 * exception: a filterbank with the wrong normalisation, or a reflection that
 * includes the edge sample, produces a spectrogram that looks entirely
 * reasonable and that the pitch tracker reads wrongly. The symptom is a voice
 * that sounds slightly off, which is nearly impossible to debug backwards.
 */

const peakBin = (magnitude: Float32Array, bins: number, frames: number, frame: number): number => {
  let best = -1
  let at = 0
  for (let bin = 0; bin < bins; bin += 1) {
    const value = magnitude[bin * frames + frame] ?? 0
    if (value > best) {
      best = value
      at = bin
    }
  }
  return at
}

describe('fft', () => {
  it('turns an impulse into a flat spectrum', () => {
    const real = new Float64Array(8)
    const imag = new Float64Array(8)
    real[0] = 1
    fft(real, imag)

    for (let bin = 0; bin < 8; bin += 1) {
      expect(Math.hypot(real[bin]!, imag[bin]!)).toBeCloseTo(1, 10)
    }
  })

  it('puts a sine entirely in its own bin', () => {
    const n = 64
    const k = 5
    const real = new Float64Array(n)
    const imag = new Float64Array(n)
    for (let at = 0; at < n; at += 1) real[at] = Math.sin((2 * Math.PI * k * at) / n)
    fft(real, imag)

    // Energy at k and its mirror, and nothing anywhere else.
    for (let bin = 0; bin <= n / 2; bin += 1) {
      const magnitude = Math.hypot(real[bin]!, imag[bin]!)
      if (bin === k) expect(magnitude).toBeCloseTo(n / 2, 6)
      else expect(magnitude).toBeLessThan(1e-9)
    }
  })

  it('leaves a constant signal entirely at DC', () => {
    const real = new Float64Array(16).fill(2)
    const imag = new Float64Array(16)
    fft(real, imag)

    expect(real[0]).toBeCloseTo(32, 10)
    for (let bin = 1; bin < 16; bin += 1) {
      expect(Math.hypot(real[bin]!, imag[bin]!)).toBeLessThan(1e-9)
    }
  })
})

describe('hann', () => {
  it('is periodic rather than symmetric', () => {
    const window = hann(8)
    // The periodic window starts at zero and does *not* return to it: the
    // symmetric variant would have window[7] === 0, and using it in an STFT
    // costs a little resolution and a lot of agreement with librosa.
    expect(window[0]).toBeCloseTo(0, 12)
    expect(window[4]).toBeCloseTo(1, 12)
    expect(window[7]).toBeGreaterThan(0)
    expect(window[1]).toBeCloseTo(window[7]!, 12)
  })
})

describe('reflectPad', () => {
  it('reflects without repeating the edge sample', () => {
    const padded = reflectPad(Float32Array.from([1, 2, 3]), 2)
    expect([...padded]).toEqual([3, 2, 1, 2, 3, 2, 1])
  })

  it('folds again when the padding is wider than the signal', () => {
    const padded = reflectPad(Float32Array.from([1, 2, 3]), 5)
    expect(padded).toHaveLength(13)
    // Every value still comes from the original, and the pattern repeats with
    // period 2*(n-1).
    for (const value of padded) expect([1, 2, 3]).toContain(value)
    expect(padded[0]).toBe(padded[4])
  })

  it('survives a one-sample signal', () => {
    expect([...reflectPad(Float32Array.from([7]), 2)]).toEqual([7, 7, 7, 7, 7])
  })
})

describe('stftMagnitude', () => {
  it('produces one frame per hop, plus the centred one', () => {
    const { frames, bins } = stftMagnitude(new Float32Array(1600), 1024, 160)
    expect(frames).toBe(11)
    expect(bins).toBe(513)
  })

  it('finds a tone in the bin it belongs to', () => {
    const rate = 16000
    const hz = 1000
    const signal = new Float32Array(rate)
    for (let at = 0; at < signal.length; at += 1) {
      signal[at] = Math.sin((2 * Math.PI * hz * at) / rate)
    }

    const { magnitude, bins, frames } = stftMagnitude(signal, 1024, 160)
    // Bin width is rate / fftSize = 15.625 Hz, so 1000 Hz is bin 64.
    expect(peakBin(magnitude, bins, frames, 20)).toBe(64)
  })
})

describe('the mel scale', () => {
  it('is linear below a kilohertz', () => {
    // 200/3 hertz per mel, exactly, which is the Slaney definition.
    expect(hzToMel(500)).toBeCloseTo(7.5, 10)
    expect(hzToMel(1000)).toBeCloseTo(15, 10)
  })

  it('is continuous where it changes to a logarithm', () => {
    expect(hzToMel(999.999)).toBeCloseTo(hzToMel(1000), 4)
  })

  it('round-trips', () => {
    for (const hz of [30, 250, 999, 1000, 1001, 4000, 8000]) {
      expect(melToHz(hzToMel(hz))).toBeCloseTo(hz, 6)
    }
  })
})

describe('melFilterbank', () => {
  const bins = 513
  const filters = melFilterbank(16000, 1024, 128, 30, 8000)

  it('gives every filter some weight', () => {
    for (let filter = 0; filter < 128; filter += 1) {
      let sum = 0
      for (let bin = 0; bin < bins; bin += 1) sum += filters[filter * bins + bin]!
      expect(sum).toBeGreaterThan(0)
    }
  })

  it('never goes negative', () => {
    for (const weight of filters) expect(weight).toBeGreaterThanOrEqual(0)
  })

  it('moves each filter up in frequency', () => {
    const centre = (filter: number): number => {
      let weighted = 0
      let total = 0
      for (let bin = 0; bin < bins; bin += 1) {
        const weight = filters[filter * bins + bin]!
        weighted += weight * bin
        total += weight
      }
      return weighted / total
    }

    for (let filter = 1; filter < 128; filter += 1) {
      expect(centre(filter)).toBeGreaterThan(centre(filter - 1))
    }
  })

  it('normalises by area, so a wide filter does not out-shout a narrow one', () => {
    /*
      Slaney normalisation makes each triangle unit *area*. A high filter is
      several times wider than a low one, so with peak normalisation its sum
      would grow with frequency; with area normalisation the sums stay
      comparable while the peaks shrink.
    */
    const peak = (filter: number): number => {
      let best = 0
      for (let bin = 0; bin < bins; bin += 1) {
        best = Math.max(best, filters[filter * bins + bin]!)
      }
      return best
    }

    expect(peak(120)).toBeLessThan(peak(10))
  })
})

describe('resample', () => {
  it('returns the input untouched when nothing changes', () => {
    const input = Float32Array.from([1, 2, 3])
    expect(resample(input, 16000, 16000)).toBe(input)
  })

  it('scales the length by the rate ratio', () => {
    expect(resample(new Float32Array(22050), 22050, 16000)).toHaveLength(16000)
    expect(resample(new Float32Array(16000), 16000, 32000)).toHaveLength(32000)
  })

  it('leaves a constant signal constant, including at the edges', () => {
    const output = resample(new Float32Array(2205).fill(0.5), 22050, 16000)
    for (const value of output) expect(value).toBeCloseTo(0.5, 4)
  })

  it('keeps a tone at its own frequency', () => {
    const from = 22050
    const to = 16000
    const hz = 440
    const input = new Float32Array(from)
    for (let at = 0; at < input.length; at += 1) {
      input[at] = Math.sin((2 * Math.PI * hz * at) / from)
    }

    const output = resample(input, from, to)
    const { magnitude, bins, frames } = stftMagnitude(output, 1024, 160)
    // 440 Hz at a 15.625 Hz bin width is bin 28.
    expect(peakBin(magnitude, bins, frames, 20)).toBe(28)
  })

  it('does not blow past full scale when downsampling', () => {
    const input = new Float32Array(4410)
    for (let at = 0; at < input.length; at += 1) input[at] = Math.sin(at / 3)
    for (const value of resample(input, 22050, 16000)) {
      expect(Math.abs(value)).toBeLessThanOrEqual(1.05)
    }
  })
})

describe('pcm conversion', () => {
  it('round-trips within a bit', () => {
    const pcm = Int16Array.from([0, 1000, -1000, 32767, -32768])
    const back = floatToPcm(pcmToFloat(pcm))
    for (let at = 0; at < pcm.length; at += 1) {
      expect(Math.abs(back[at]! - pcm[at]!)).toBeLessThanOrEqual(1)
    }
  })

  it('clips rather than wrapping', () => {
    // Wrapping is the failure that turns a loud passage into a burst of noise.
    expect([...floatToPcm(Float32Array.from([2, -2]))]).toEqual([32767, -32767])
  })
})
