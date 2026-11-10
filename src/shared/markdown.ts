import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkDirective from 'remark-directive'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeStringify from 'rehype-stringify'
import { visit } from 'unist-util-visit'

/**
 * Markdown to HTML. SPEC section 3: there is no build step -- this runs at read
 * time, and at a few hundred kilobytes per book that is instant.
 *
 * The pipeline lives in `shared` and is pure, so it is testable without a
 * window. It is imported by the renderer only: main does the filesystem, the
 * renderer does the rendering.
 */

/**
 * Directives that become a titled box. The name doubles as the CSS class, so
 * adding a callout type to the textbooks needs no change here -- only a rule in
 * the stylesheet.
 */
export const BOX_DIRECTIVES = new Set([
  'theorem', 'definition', 'lemma', 'corollary', 'proof',
  'example', 'answer', 'problem', 'solution', 'summary',
  'callout-key', 'callout-intuition', 'callout-warning',
  'callout-pitfall', 'callout-tip', 'callout-connect',
  'annot', 'note'
])

/** Directives whose body is hidden until the reader asks for it. */
const COLLAPSIBLE = new Set(['solution', 'answer'])

/**
 * Turn container directives into HTML elements.
 *
 * remark-directive parses the syntax and does nothing else by design: what a
 * directive *means* is the application's business. An unknown directive renders
 * as a plain section rather than disappearing, because silently dropping content
 * is the one behaviour a reader can never diagnose.
 */
function directives() {
  return (tree: unknown): void => {
    visit(tree as never, (node: Record<string, unknown>) => {
      if (node['type'] !== 'containerDirective' && node['type'] !== 'leafDirective') return

      const name = String(node['name'] ?? '')
      const attributes = (node['attributes'] ?? {}) as Record<string, string>
      const known = BOX_DIRECTIVES.has(name)
      const collapsible = COLLAPSIBLE.has(name)

      // The label is the directive's first child when that child is marked as a
      // label; remark-directive flags it rather than separating it out.
      const children = (node['children'] ?? []) as Record<string, unknown>[]
      const labelNode = children.find(
        (child) => (child['data'] as Record<string, unknown> | undefined)?.['directiveLabel']
      )
      const body = children.filter((child) => child !== labelNode)

      const classes = ['box', name]
      if (!known) classes.push('box-unknown')
      if (attributes['difficulty']) classes.push(`difficulty-${attributes['difficulty']}`)

      const heading = labelNode
        ? [{
            type: 'paragraph',
            children: (labelNode['children'] ?? []) as unknown[],
            data: { hName: collapsible ? 'summary' : 'p', hProperties: { className: ['box-label'] } }
          }]
        : []

      node['children'] = collapsible ? [...heading, ...body] : [...heading, ...body]
      node['data'] = {
        hName: collapsible ? 'details' : 'section',
        hProperties: {
          className: classes,
          ...(attributes['difficulty'] ? { 'data-difficulty': attributes['difficulty'] } : {})
        }
      }
    })
  }
}

/**
 * Mathematics is emitted as raw delimiters rather than typeset here.
 *
 * MathJax typesets in the page, which is what keeps book-scoped macros working
 * and what M4's speech path needs: the Speech Rule Engine reads the MathML that
 * MathJax produces, so pre-rendering to static HTML here would leave nothing to
 * speak.
 */
function mathAsText() {
  return (tree: unknown): void => {
    visit(tree as never, (node: Record<string, unknown>) => {
      if (node['type'] !== 'math' && node['type'] !== 'inlineMath') return
      const display = node['type'] === 'math'
      const value = String(node['value'] ?? '')
      // remark-math sets `data.hName` at parse time, and mdast-util-to-hast
      // consults that before it looks at `type`. Changing the type alone leaves
      // the node rendering as <code class="language-math"> with the delimiters
      // stripped -- which is silently unspeakable as well as unrenderable.
      delete node['data']
      node['type'] = 'html'
      // The LaTeX is carried on the wrapper as well as inside it. MathJax
      // replaces the delimiters with its own element tree when it typesets and
      // the source is then unrecoverable -- but generating speech needs it.
      //
      // This string becomes an `html` node, which `rehypeRaw` parses as markup,
      // so the LaTeX must be escaped in the body as well as in the attribute: a
      // bare `<` in `$0<a/c<\infty$` opened an <a> element that swallowed the
      // rest of the chapter. Both places get the same escape, `&` first so the
      // entities it adds are not themselves re-encoded; the parser decodes each
      // back to the exact source, which is what MathJax and speech then read.
      const escaped = value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      const attr = escaped.replace(/"/g, '&quot;')
      node['value'] = display
        ? `<div class="math-display" data-latex="${attr}">\\[${escaped}\\]</div>`
        : `<span class="math-inline" data-latex="${attr}">\\(${escaped}\\)</span>`
    })
  }
}

/**
 * One run of `$...$` inside a caption, by Pandoc's rule for inline maths: the
 * opening dollar is not followed by a space, the closing one is not preceded by
 * one and not followed by a digit. That is what keeps "$5 and $10" prose.
 */
export const CAPTION_MATH = /(?<!\\)\$(?!\s)((?:[^$\\]|\\.)+?)(?<!\s)\$(?!\d)/g

type HastNode = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/**
 * Mathematics inside a figure's caption, given the treatment a paragraph's gets.
 *
 * A figure is raw HTML in the chapter, and raw HTML is not Markdown: nothing
 * inside it passes through `remark-math`. So `$r = 1+\cos\theta$` in a
 * `<figcaption>` arrived in the page as those literal characters -- and MathJax
 * is configured for `\(...\)` only, so it was never typeset either. The caption
 * showed its LaTeX source, and a listener got nothing from it at all.
 *
 * Converted to the same `.math-inline` wrapper with the source on `data-latex`,
 * a caption's equation renders like any other and reaches the speech path the
 * same way. Scoped to captions deliberately: elsewhere in raw HTML a dollar sign
 * is as likely to be money, and the LSAT book is full of money.
 */
function captionMath() {
  const convert = (node: HastNode): void => {
    if (!node.children) return
    const next: HastNode[] = []
    for (const child of node.children) {
      if (child.type === 'element') {
        // Code in a caption is shown, not typeset.
        if (child.tagName !== 'code') convert(child)
        next.push(child)
        continue
      }
      if (child.type !== 'text' || !child.value?.includes('$')) {
        next.push(child)
        continue
      }

      const text = child.value
      let last = 0
      for (const match of text.matchAll(CAPTION_MATH)) {
        const at = match.index ?? 0
        const latex = match[1] ?? ''
        if (at > last) next.push({ type: 'text', value: text.slice(last, at) })
        next.push({
          type: 'element',
          tagName: 'span',
          properties: { className: ['math-inline'], dataLatex: latex },
          children: [{ type: 'text', value: `\\(${latex}\\)` }]
        })
        last = at + match[0].length
      }
      if (last < text.length) next.push({ type: 'text', value: text.slice(last) })
    }
    node.children = next
  }

  return (tree: unknown): void => {
    visit(tree as never, 'element', (node: HastNode) => {
      if (node.tagName === 'figcaption') convert(node)
    })
  }
}

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkDirective)
  .use(directives)
  .use(mathAsText)
  // `allowDangerousHtml` is deliberate: Markdown permits raw HTML, and the
  // books rely on it as an escape hatch. The content is the user's own, written
  // by them or for them, and never fetched from a network.
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  // After `rehypeRaw`, which is what turns a figure's raw HTML into elements
  // there is a caption to find in.
  .use(captionMath)
  .use(rehypeStringify, { allowDangerousHtml: true })

export function renderMarkdown(source: string): string {
  return String(processor.processSync(source))
}
