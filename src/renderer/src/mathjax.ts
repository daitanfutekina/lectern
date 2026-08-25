/**
 * MathJax, loaded from the vendored copy under public/.
 *
 * SPEC invariant 2: no CDN. The seven existing books between them carry 422
 * references to jsdelivr and cdnjs, which is why none of them render on a
 * plane. That defect does not come across with the content.
 *
 * SPEC section 5: mathematics is typeset in the page rather than pre-rendered,
 * because M4's speech path reads the MathML MathJax produces. Pre-rendering to
 * static HTML would leave nothing to speak.
 */

/**
 * `startup` is written as configuration (`{ typeset: false }`) and read back
 * after load as a live object carrying `promise`. It is the same property with
 * two shapes at two moments, so both are optional here.
 */
interface MathJaxLike {
  typesetPromise?: (elements: HTMLElement[]) => Promise<void>
  typesetClear?: (elements: HTMLElement[]) => void
  startup?: { promise?: Promise<void>; typeset?: boolean }
}

declare global {
  interface Window {
    MathJax?: MathJaxLike & Record<string, unknown>
  }
}

let loading: Promise<void> | null = null

/**
 * Macros are book-scoped, so they are set before the script loads and replaced
 * per book afterwards. Held here because MathJax reads its config object at
 * load time and keeps a reference to it.
 */
const macros: Record<string, string> = {}

export function configureMacros(next: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(macros)) delete macros[key]
  Object.assign(macros, next)
}

function load(): Promise<void> {
  if (loading) return loading

  window.MathJax = {
    tex: {
      inlineMath: [['\\(', '\\)']],
      displayMath: [['\\[', '\\]']],
      macros,
      tags: 'ams'
    },
    options: {
      // Never typeset inside code: a fenced block showing LaTeX source should
      // stay source.
      skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
      enableMenu: false
    },
    startup: { typeset: false }
  } as MathJaxLike & Record<string, unknown>

  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = './mathjax/tex-mml-chtml.js'
    script.async = true
    script.addEventListener('load', () => resolve())
    script.addEventListener('error', () => reject(new Error('MathJax failed to load')))
    document.head.append(script)
  }).then(() => window.MathJax?.startup?.promise ?? Promise.resolve())

  return loading
}

/**
 * Typeset one element. Failure is reported in place rather than thrown: a
 * chapter with one bad equation must still be readable, and a silent failure
 * would leave raw LaTeX on screen with no explanation.
 */
export async function typeset(element: HTMLElement): Promise<void> {
  try {
    await load()
    window.MathJax?.typesetClear?.([element])
    await window.MathJax?.typesetPromise?.([element])
  } catch {
    element.dataset['mathjax'] = 'failed'
  }
}
