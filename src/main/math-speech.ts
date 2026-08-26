import { createRequire } from 'node:module'

/**
 * LaTeX to spoken English, in the main process.
 *
 * SPEC section 5. Pipeline: LaTeX -> MathML (Temml) -> speech (Speech Rule
 * Engine). Both free, local, offline, and neither needs a network or an
 * account.
 *
 * Two findings shaped this, and both are in docs/FINDINGS.md.
 *
 * It runs in main rather than the renderer because SRE loads its rule files at
 * runtime and hangs doing so under `file://`.
 *
 * It uses Temml rather than MathJax to reach MathML because MathJax's loader
 * never resolves in Electron's main process -- it finds enough of a browser to
 * take the browser path and then waits for a DOM that will never arrive. Temml
 * is a pure function over a string with no environment detection at all, which
 * is exactly what a converter in a headless process should be.
 *
 * `clearspeak` rather than `mathspeak`: the difference is
 * "one over n the sum from i equals 1 to n" against
 * "StartFraction 1 Over n EndFraction sigma summation Underscript", and only
 * the first is listenable.
 */

const require = createRequire(import.meta.url)

type Temml = {
  renderToString: (tex: string, options: Record<string, unknown>) => string
}

type Sre = {
  setupEngine: (config: Record<string, unknown>) => Promise<void>
  toSpeech: (mathml: string) => string
}

interface Engines {
  readonly temml: Temml
  readonly sre: Sre
  readonly macros: Record<string, string>
}

let ready: Promise<Engines | null> | null = null

/**
 * Loading is raced against a deadline.
 *
 * An earlier version awaited a loader that never resolved, and because the
 * renderer awaited that in turn, mathematics speech simply never appeared --
 * no error, no timeout, nothing to see. A converter that cannot start must
 * fail, not hang.
 */
const LOAD_TIMEOUT_MS = 15_000

function init(macros: Readonly<Record<string, string>>): Promise<Engines | null> {
  const load = (async (): Promise<Engines | null> => {
    try {
      const temml = require('temml') as Temml
      const sre = require('speech-rule-engine') as Sre

      await sre.setupEngine({
        domain: 'clearspeak',
        style: 'default',
        locale: 'en',
        modality: 'speech'
      })

      // book.yml stores macro names bare (`Nul`); Temml wants the control
      // sequence (`\Nul`). Registering them matters: an unknown command reaches
      // SRE as its letters and `\Nul` is spoken "N u l".
      const prefixed: Record<string, string> = {}
      for (const [name, body] of Object.entries(macros)) prefixed[`\\${name}`] = body

      return { temml, sre, macros: prefixed }
    } catch (error) {
      process.stderr.write(`math speech unavailable: ${String(error)}\n`)
      return null
    }
  })()

  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => {
      process.stderr.write('math speech unavailable: engines did not load in time\n')
      resolve(null)
    }, LOAD_TIMEOUT_MS)
  })

  return Promise.race([load, timeout])
}

/**
 * Macros are book-scoped, so switching books rebuilds the engines. Rare enough
 * that the cost does not matter, and sharing one across books would let one
 * book's `\Nul` leak into another's.
 */
let loadedMacros = ''

export function configureMath(macros: Readonly<Record<string, string>>): void {
  const key = JSON.stringify(macros)
  if (key === loadedMacros && ready) return
  loadedMacros = key
  ready = init(macros)
  cache.clear()
}

/**
 * Conversion is not free and chapters repeat equations, so results are held for
 * the session. Keyed by the LaTeX and whether it is displayed, because the same
 * source reads differently in the two positions.
 */
const cache = new Map<string, string | null>()

let reportedFailure = false

export async function speakMath(
  items: ReadonlyArray<{ latex: string; display: boolean }>
): Promise<(string | null)[]> {
  const engines = await (ready ??= init({}))
  if (!engines) return items.map(() => null)

  return items.map((item) => {
    const key = `${item.display ? 'D' : 'I'}:${item.latex}`
    const hit = cache.get(key)
    if (hit !== undefined) return hit

    let speech: string | null = null
    try {
      const mathml = engines.temml.renderToString(item.latex, {
        macros: engines.macros,
        displayMode: item.display,
        // A malformed equation should produce no speech, not stop the batch.
        throwOnError: false
      })
      const spoken = engines.sre.toSpeech(mathml)
      speech = spoken && spoken.trim() ? spoken.trim() : null
    } catch (error) {
      // One equation failing is not a reason to lose the rest of the chapter,
      // but the first failure is reported: silence from every equation and
      // silence from a gate that rejected them all look exactly the same.
      if (!reportedFailure) {
        reportedFailure = true
        process.stderr.write(`math speech failed on ${item.latex.slice(0, 60)}: ${String(error)}\n`)
      }
      speech = null
    }

    cache.set(key, speech)
    return speech
  })
}
