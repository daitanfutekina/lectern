/**
 * The arithmetic between the three models in the voice-conversion chain.
 * SPEC section 5.
 *
 * Voice conversion is three networks and a lot of glue. The networks are
 * opaque; the glue is not, and it is where this kind of pipeline actually goes
 * wrong -- a pitch track quantised into the wrong bins, or features aligned one
 * frame off, produce audio that plays fine and sounds broken.
 *
 * So the glue lives here, pure and tested, and `src/main/rvc.ts` only moves
 * tensors in and out of the runtime.
 *
 * The chain:
 *
 *   speech at 16 kHz  ->  ContentVec  ->  what was said, 50 frames/s, 768-dim
 *                     ->  RMVPE       ->  the pitch it was said at, 100 frames/s
 *   both, plus a speaker id           ->  RVC  ->  the same words in another voice
 */

/* -- The spectrogram RMVPE expects ---------------------------------------- */

/**
 * RMVPE's input representation, fixed by its training.
 *
 * A pitch tracker is not resampling-tolerant the way a classifier is: it
 * learned that a particular filterbank row means a particular frequency. These
 * numbers come from RVC's own mel extractor and are not tunable.
 */
export const RMVPE_MEL = {
  sampleRate: 16000,
  fftSize: 1024,
  hop: 160,
  mels: 128,
  fMin: 30,
  fMax: 8000,
  /** The floor before the logarithm, so silence is a large negative, not -Inf. */
  clamp: 1e-5
} as const

/** 100 frames a second at 16 kHz, which is also the rate the RVC model wants. */
export const FRAME_RATE = RMVPE_MEL.sampleRate / RMVPE_MEL.hop

/**
 * Multiply a spectrogram by a filterbank and take the logarithm.
 *
 * `magnitude` is `[bin][frame]` and `filters` is `[filter][bin]`, so this is an
 * ordinary matrix product with the frame axis carried along -- laid out to keep
 * the inner loop walking contiguous memory in both operands.
 */
export function logMel(
  magnitude: Float32Array,
  bins: number,
  frames: number,
  filters: Float32Array,
  mels: number,
  clamp: number
): Float32Array {
  const out = new Float32Array(mels * frames)
  const floor = Math.log(clamp)

  for (let mel = 0; mel < mels; mel += 1) {
    const row = mel * bins
    const target = mel * frames
    for (let bin = 0; bin < bins; bin += 1) {
      const weight = filters[row + bin]!
      if (weight === 0) continue
      const source = bin * frames
      for (let frame = 0; frame < frames; frame += 1) {
        out[target + frame] = out[target + frame]! + weight * magnitude[source + frame]!
      }
    }
    for (let frame = 0; frame < frames; frame += 1) {
      const value = out[target + frame]!
      out[target + frame] = value > clamp ? Math.log(value) : floor
    }
  }

  return out
}

/**
 * Pad the frame axis out to a multiple of `block`.
 *
 * RMVPE downsamples by 32 internally and rejects anything that does not divide.
 * The padding is zeros rather than a repeat of the last frame, matching RVC,
 * and the extra frames are discarded again after inference.
 */
export function padFrames(
  mel: Float32Array,
  mels: number,
  frames: number,
  block: number
): { mel: Float32Array; frames: number } {
  const padded = block * Math.floor((frames - 1) / block + 1)
  if (padded === frames) return { mel, frames }

  const out = new Float32Array(mels * padded)
  for (let row = 0; row < mels; row += 1) {
    out.set(mel.subarray(row * frames, (row + 1) * frames), row * padded)
  }
  return { mel: out, frames: padded }
}

/* -- Reading RMVPE's answer ----------------------------------------------- */

/** Bin 0 is 10 Hz; each bin is 20 cents above the last. */
const CENTS_BASE = 1997.3794084376191
const CENTS_PER_BIN = 20
const PITCH_BINS = 360

/**
 * Turn RMVPE's 360 per-frame confidences into a pitch in hertz.
 *
 * The peak bin alone would quantise the pitch to 20-cent steps, which is
 * audible as a stepped, robotic contour. Averaging the nine bins around the
 * peak, weighted by confidence, recovers a smooth value between the steps.
 *
 * A frame whose best bin is below `threshold` is unvoiced and returns 0 --
 * silence and consonants have no pitch, and inventing one for them makes the
 * converted voice hum through its own breaths.
 */
export function decodePitch(
  salience: Float32Array,
  frames: number,
  threshold: number
): Float32Array {
  const f0 = new Float32Array(frames)

  for (let frame = 0; frame < frames; frame += 1) {
    const row = frame * PITCH_BINS

    let peak = 0
    let best = 0
    for (let bin = 0; bin < PITCH_BINS; bin += 1) {
      const value = salience[row + bin]!
      if (value > best) {
        best = value
        peak = bin
      }
    }

    if (best <= threshold) continue

    let weighted = 0
    let total = 0
    for (let bin = Math.max(0, peak - 4); bin <= Math.min(PITCH_BINS - 1, peak + 4); bin += 1) {
      const value = salience[row + bin]!
      weighted += value * (CENTS_PER_BIN * bin + CENTS_BASE)
      total += value
    }

    if (total === 0) continue
    f0[frame] = 10 * Math.pow(2, weighted / total / 1200)
  }

  return f0
}

/* -- What the RVC model wants --------------------------------------------- */

const F0_MIN = 50
const F0_MAX = 1100
const melOf = (hz: number): number => 1127 * Math.log(1 + hz / 700)
const F0_MEL_MIN = melOf(F0_MIN)
const F0_MEL_MAX = melOf(F0_MAX)

/** Shift a pitch track by whole semitones. */
export function transpose(f0: Float32Array, semitones: number): Float32Array {
  if (semitones === 0) return f0
  const factor = Math.pow(2, semitones / 12)
  const out = new Float32Array(f0.length)
  for (let at = 0; at < f0.length; at += 1) out[at] = f0[at]! * factor
  return out
}

/**
 * Quantise a pitch track into the 1..255 bins the RVC model was trained on.
 *
 * The bins are spaced on the mel scale rather than linearly, so a semitone near
 * the bottom of the range gets about as many bins as a semitone near the top --
 * which is what makes a single embedding table cover a bass and a soprano.
 *
 * Bin 1 doubles as "unvoiced": the continuous track in `nsff0` carries the
 * actual zero, and the model reads both.
 */
export function coarsePitch(f0: Float32Array): BigInt64Array {
  const out = new BigInt64Array(f0.length)
  const span = (F0_MEL_MAX - F0_MEL_MIN) / 254

  for (let at = 0; at < f0.length; at += 1) {
    const hz = f0[at]!
    let bin = 1
    if (hz > 0) {
      bin = Math.round((melOf(hz) - F0_MEL_MIN) / span + 1)
      if (bin < 1) bin = 1
      else if (bin > 255) bin = 255
    }
    out[at] = BigInt(bin)
  }

  return out
}

/**
 * Double the frame rate of the content features by repeating each frame.
 *
 * ContentVec runs at 50 frames a second and the RVC model at 100. RVC's own
 * pipeline uses nearest-neighbour interpolation for this, which is exactly a
 * repeat, so this matches rather than improving on it: a smoother
 * interpolation here would be a different input than the model was trained on.
 */
export function upsampleFeatures(
  features: Float32Array,
  frames: number,
  dim: number
): Float32Array {
  const out = new Float32Array(frames * 2 * dim)
  for (let frame = 0; frame < frames; frame += 1) {
    const source = features.subarray(frame * dim, (frame + 1) * dim)
    out.set(source, frame * 2 * dim)
    out.set(source, (frame * 2 + 1) * dim)
  }
  return out
}

/**
 * The number of frames every input agrees on.
 *
 * The three paths through the chain round differently -- the encoder drops a
 * frame at the end, the spectrogram gains one from centring -- so they arrive
 * at slightly different lengths. The model needs one length, and the shortest
 * is the only one every input actually has data for.
 */
export function commonLength(...lengths: number[]): number {
  return Math.max(0, Math.min(...lengths))
}
