import { describe, expect, it, vi } from 'vitest'
import {
  answerPdfPasswordChallenge,
  pdfDestinationPage,
  pdfLinkAction,
  type PdfPasswordAttempt
} from './pdf-interaction'

describe('pdfLinkAction', () => {
  it('keeps internal destinations in the PDF viewer', () => {
    expect(pdfLinkAction({ dest: 'chapter.2' })).toEqual({
      kind: 'internal',
      destination: 'chapter.2'
    })
    expect(pdfLinkAction({ dest: [{ num: 8, gen: 0 }, { name: 'Fit' }] }).kind).toBe(
      'internal'
    )
  })

  it('allows only http and https URLs through the external-open path', () => {
    expect(pdfLinkAction({ url: 'https://example.com/reference' })).toEqual({
      kind: 'external',
      url: 'https://example.com/reference'
    })
    expect(pdfLinkAction({ url: 'http://example.com/' }).kind).toBe('external')
    expect(pdfLinkAction({ url: 'mailto:reader@example.com' }).kind).toBe('ignore')
    expect(pdfLinkAction({ url: 'javascript:alert(1)' }).kind).toBe('ignore')
    expect(pdfLinkAction({ url: 'not a URL' }).kind).toBe('ignore')
  })
})

describe('pdfDestinationPage', () => {
  it('resolves named, referenced, and direct page destinations', async () => {
    const reference = { num: 4, gen: 0 }
    const getDestination = vi.fn(async () => [reference])
    const getPageIndex = vi.fn(async () => 6)

    await expect(pdfDestinationPage('section.3', getDestination, getPageIndex)).resolves.toBe(7)
    expect(getDestination).toHaveBeenCalledWith('section.3')
    expect(getPageIndex).toHaveBeenCalledWith(reference)
    await expect(pdfDestinationPage([3], getDestination, getPageIndex)).resolves.toBe(4)
  })
})

describe('answerPdfPasswordChallenge', () => {
  it('passes a wrong then right password back for consecutive challenges', async () => {
    const attempts: PdfPasswordAttempt[] = []
    const answers = ['wrong', 'right']
    const update = vi.fn()
    const cancel = vi.fn()
    const ask = async (attempt: PdfPasswordAttempt): Promise<string> => {
      attempts.push(attempt)
      return answers.shift() ?? ''
    }

    await answerPdfPasswordChallenge(1, ask, update, cancel)
    await answerPdfPasswordChallenge(2, ask, update, cancel)

    expect(attempts).toEqual(['required', 'incorrect'])
    expect(update.mock.calls).toEqual([['wrong'], ['right']])
    expect(cancel).not.toHaveBeenCalled()
  })

  it('cancels without supplying a password', async () => {
    const update = vi.fn()
    const cancel = vi.fn()
    await answerPdfPasswordChallenge(1, async () => null, update, cancel)
    expect(update).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
