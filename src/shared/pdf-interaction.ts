export type PdfLinkAction =
  | { readonly kind: 'internal'; readonly destination: unknown }
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'ignore' }

interface PdfLinkAnnotation {
  readonly url?: unknown
  readonly dest?: unknown
}

/** Only PDF destinations and ordinary web URLs are actions in the reader. */
export function pdfLinkAction(annotation: PdfLinkAnnotation): PdfLinkAction {
  if (typeof annotation.url === 'string') {
    try {
      const url = new URL(annotation.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return { kind: 'external', url: url.toString() }
      }
    } catch {
      // A malformed URL is no safer or more useful than an unsupported scheme.
    }
    return { kind: 'ignore' }
  }

  if (typeof annotation.dest === 'string' || Array.isArray(annotation.dest)) {
    return { kind: 'internal', destination: annotation.dest }
  }
  return { kind: 'ignore' }
}

/** Resolve pdf.js's named, referenced, and direct page destinations to a 1-based page. */
export async function pdfDestinationPage(
  destination: unknown,
  getDestination: (name: string) => Promise<unknown[] | null>,
  getPageIndex: (reference: unknown) => Promise<number>
): Promise<number | null> {
  try {
    const resolved =
      typeof destination === 'string' ? await getDestination(destination) : destination
    if (!Array.isArray(resolved)) return null

    const reference = resolved[0]
    if (typeof reference === 'number' && Number.isInteger(reference) && reference >= 0) {
      return reference + 1
    }
    if (reference === null || reference === undefined) return null
    return (await getPageIndex(reference)) + 1
  } catch {
    return null
  }
}

export type PdfPasswordAttempt = 'required' | 'incorrect'

/**
 * Answer one password challenge from pdf.js.
 *
 * Kept independent of Electron and pdf.js so the retry and cancel contract can
 * be proven without putting a real password in a fixture or a log.
 */
export async function answerPdfPasswordChallenge(
  reason: number,
  ask: (attempt: PdfPasswordAttempt) => Promise<string | null>,
  updatePassword: (password: string) => void,
  cancel: () => void
): Promise<void> {
  const password = await ask(reason === 2 ? 'incorrect' : 'required')
  if (password === null) cancel()
  else updatePassword(password)
}
