import { assetUrl, frameSandbox } from '@shared/assets'

/**
 * A chapter's markup, with its figures, media and embeds made to work.
 *
 * Parsed into a `<template>` rather than assigned to a live element. A live
 * element starts fetching every `<img>` the moment the parser creates it, so the
 * rewriting below would have raced a request to the wrong URL for each one --
 * harmless, but a failed load logged per figure on every chapter open. Template
 * content is inert until it is attached, so nothing loads until it is right.
 */
export function chapterFragment(html: string, bookId: string, chapterFile: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html
  const content = template.content

  // A relative reference is to a file in the book's folder.
  for (const element of content.querySelectorAll<HTMLElement>('[src], video[poster]')) {
    for (const name of ['src', 'poster']) {
      const value = element.getAttribute(name)
      if (value === null) continue
      const rewritten = assetUrl(bookId, chapterFile, value)
      if (rewritten) element.setAttribute(name, rewritten)
    }
  }

  // A picture offered at two resolutions names each file in a list.
  for (const element of content.querySelectorAll<HTMLElement>('[srcset]')) {
    const value = element.getAttribute('srcset') ?? ''
    const rewritten = value
      .split(',')
      .map((candidate) => {
        const [url = '', ...descriptor] = candidate.trim().split(/\s+/)
        const resolved = assetUrl(bookId, chapterFile, url) ?? url
        return [resolved, ...descriptor].join(' ')
      })
      .join(', ')
    element.setAttribute('srcset', rewritten)
  }

  for (const frame of content.querySelectorAll('iframe')) {
    /*
      The sandbox is imposed, never taken from the chapter. A chapter that could
      write its own `sandbox` attribute could write one that lets a frame reach
      the page, and the page holds the bridge to the filesystem.
    */
    frame.setAttribute('sandbox', frameSandbox(frame.getAttribute('src') ?? ''))
    // Below the fold is most of a chapter. A frame the reader never scrolls to
    // should not cost a network request, and offline it should not cost a
    // failed one either.
    if (!frame.hasAttribute('loading')) frame.setAttribute('loading', 'lazy')
  }

  return content
}
