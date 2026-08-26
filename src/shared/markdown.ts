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
const BOX_DIRECTIVES = new Set([
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
      const attr = value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
      node['value'] = display
        ? `<div class="math-display" data-latex="${attr}">\\[${value}\\]</div>`
        : `<span class="math-inline" data-latex="${attr}">\\(${value}\\)</span>`
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
  .use(rehypeStringify, { allowDangerousHtml: true })

export function renderMarkdown(source: string): string {
  return String(processor.processSync(source))
}
