/**
 * Signal processing for voice conversion. SPEC section 5.
 *
 * Everything here is pure arithmetic over typed arrays, which is why it lives
 * in `shared` and is covered by tests: an FFT that is subtly wrong produces a
 * voice that is subtly wrong, and that is the hardest kind of bug to hear.
 *
 * The constants are not free choices. RMVPE was trained on a mel spectrogram
 * produced by librosa with a specific window, hop, filterbank normalisation and
 * frequency range, and it only recognises pitch in the representation it was
 * trained on. Where a value looks arbitrary, it is matching librosa.
 */

/* -- Fourier transform ---------------------------------------------------- */

/**
 * In-place radix-2 Cooley-Tukey FFT.
 *
 * `real` and `imag` are the same length, a power of two. A real-input
 * optimisation would halve the work, but at n = 1024 the transform is not what
 * costs time here -- the neural networks are -- and the naive version is the
 * one that can be read against a textbook.
 */
export function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = real[i]!
      real[i] = real[j]!
      real[j] = tr
      const ti = imag[i]!
      imag[i] = imag[j]!
      imag[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    const half = len / 2
    for (let start = 0; start < n; start += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k += 1) {
        const a = start + k
        const b = a + half
        const xr = real[b]! * cr - imag[b]! * ci
        const xi = real[b]! * ci + imag[b]! * cr
        real[b] = real[a]! - xr
        imag[b] = imag[a]! - xi
        real[a] = real[a]! + xr
        imag[a] = imag[a]! + xi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

/** A periodic Hann window, which is what torch.stft and librosa both use. */
export function hann(size: number): Float64Array {
  const window = new Float64Array(size)
  for (let at = 0; at < size; at += 1) {
    window[at] = 0.5 - 0.5 * Math.cos((2 * Math.PI * at) / size)
  }
  return window
}

/**
 * Reflect-pad, the mode `center=True` uses.
 *
 * Reflection excludes the edge sample itself: [1,2,3] padded by 2 gives
 * [3,2,1,2,3,2,1], not [2,1,1,2,3,3,2]. Getting this wrong shifts every frame
 * and moves the pitch track off the audio by half a window.
 */
export function reflectPad(signal: Float32Array, pad: number): Float32Array {
  const out = new Float32Array(signal.length + pad * 2)
  const span = signal.length - 1

  if (span <= 0) {
    out.fill(signal[0] ?? 0)
    return out
  }

  const period = span * 2
  for (let at = 0; at < out.length; at += 1) {
    // Fold repeatedly: a pad wider than the signal reflects more than once.
    let source = ((((at - pad) % period) + period) % period)
    if (source > span) source = period - source
    out[at] = signal[source]!
  }
  return out
}

/**
 * Short-time Fourier transform magnitudes, laid out as `[bin][frame]`.
 *
 * The transpose is deliberate: the mel filterbank multiplies from the left, so
 * frequency-major is the layout that keeps that loop contiguous.
 */
export interface Spectrogram {
  readonly magnitude: Float32Array
  readonly bins: number
  readonly frames: number
}

export function stftMagnitude(
  signal: Float32Array,
  fftSize: number,
  hop: number
): Spectrogram {
  const padded = reflectPad(signal, fftSize / 2)
  const frames = 1 + Math.floor(signal.length / hop)
  const bins = fftSize / 2 + 1
  const window = hann(fftSize)

  const magnitude = new Float32Array(bins * frames)
  const real = new Float64Array(fftSize)
  const imag = new Float64Array(fftSize)

  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * hop
    for (let at = 0; at < fftSize; at += 1) {
      real[at] = (padded[offset + at] ?? 0) * window[at]!
      imag[at] = 0
    }
    fft(real, imag)
    for (let bin = 0; bin < bins; bin += 1) {
      magnitude[bin * frames + frame] = Math.hypot(real[bin]!, imag[bin]!)
    }
  }

  return { magnitude, bins, frames }
}

/* -- Mel scale ------------------------------------------------------------ */

/*
  The Slaney mel scale, not the HTK one.

  It is linear below 1 kHz and logarithmic above, with the two pieces joined so
  the curve is continuous. librosa defaults to it; HTK's single-formula version
  gives visibly different filter centres, and RMVPE would then be reading a
  spectrogram it has never seen.
*/
const F_SP = 200 / 3
const MIN_LOG_HZ = 1000
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP
const LOG_STEP = Math.log(6.4) / 27

export function hzToMel(hz: number): number {
  return hz >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP : hz / F_SP
}

export function melToHz(mel: number): number {
  return mel >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL)) : mel * F_SP
}

/**
 * A triangular mel filterbank with Slaney normalisation, laid out `[filter][bin]`.
 *
 * Slaney normalisation scales each triangle to unit *area* rather than unit
 * peak, so a wide high-frequency filter does not simply out-shout a narrow low
 * one. librosa calls this `norm='slaney'` and applies it by default.
 */
export function melFilterbank(
  sampleRate: number,
  fftSize: number,
  count: number,
  fMin: number,
  fMax: number
): Float32Array {
  const bins = fftSize / 2 + 1
  const weights = new Float32Array(count * bins)

  const points = new Float64Array(count + 2)
  const melMin = hzToMel(fMin)
  const melMax = hzToMel(fMax)
  for (let at = 0; at < points.length; at += 1) {
    points[at] = melToHz(melMin + ((melMax - melMin) * at) / (count + 1))
  }

  for (let filter = 0; filter < count; filter += 1) {
    const left = points[filter]!
    const centre = points[filter + 1]!
    const right = points[filter + 2]!
    const area = 2 / (right - left)

    for (let bin = 0; bin < bins; bin += 1) {
      const hz = (bin * sampleRate) / fftSize
      const rising = (hz - left) / (centre - left)
      const falling = (right - hz) / (right - centre)
      const value = Math.min(rising, falling)
      weights[filter * bins + bin] = value > 0 ? value * area : 0
    }
  }

  return weights
}

/* -- Resampling ----------------------------------------------------------- */

/**
 * Resample with a windowed-sinc kernel.
 *
 * Piper speaks at 22.05 kHz and both the content encoder and the pitch tracker
 * want 16 kHz, a ratio with no shortcut. Dropping samples aliases audibly, and
 * aliasing in the input becomes wrong phonemes and wrong pitch downstream, so
 * this does the real thing: a Blackman-windowed sinc with the cutoff pulled to
 * the lower of the two Nyquist limits.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input

  const ratio = to / from
  const outLength = Math.max(1, Math.round(input.length * ratio))
  const output = new Float32Array(outLength)

  // Downsampling has to band-limit to the *new* Nyquist; upsampling only has to
  // reconstruct up to the old one. The 0.95 leaves a transition band.
  const cutoff = 0.95 * Math.min(1, ratio)
  const lobes = 6
  const half = Math.ceil(lobes / cutoff)

  for (let at = 0; at < outLength; at += 1) {
    const centre = at / ratio
    const first = Math.ceil(centre) - half
    let sum = 0
    let weight = 0

    for (let k = 0; k < half * 2; k += 1) {
      const index = first + k
      const t = (index - centre) / half
      if (t <= -1 || t >= 1) continue

      const x = (index - centre) * cutoff
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const phase = Math.PI * (t + 1)
      const window = 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase)
      const tap = sinc * window

      // Taps that fall outside the signal still count towards the normaliser
      // being wrong, so they are skipped from both sums rather than treated as
      // zero samples -- which is what keeps the first and last few output
      // samples at the right level instead of fading in.
      if (index < 0 || index >= input.length) continue
      sum += input[index]! * tap
      weight += tap
    }

    output[at] = weight === 0 ? 0 : sum / weight
  }

  return output
}

/** 16-bit PCM to the [-1, 1) floats every model here expects. */
export function pcmToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let at = 0; at < pcm.length; at += 1) out[at] = pcm[at]! / 32768
  return out
}

/** The reverse, clipped rather than wrapped. */
export function floatToPcm(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let at = 0; at < samples.length; at += 1) {
    out[at] = Math.round(Math.max(-1, Math.min(1, samples[at]!)) * 32767)
  }
  return out
}
