# Figures — the mechanics

Read this when you are actually drawing something. `SKILL.md` says *when* a
chapter needs a figure; this says how to make one.

## Inline SVG is the default

Write the `<svg>` directly into the Markdown. It needs no build step, nothing is
fetched at read time so it works offline, and being text it diffs, greps, and can
be produced by a script. The renderer passes raw HTML through deliberately; this
is the escape hatch it exists for.

```markdown
<figure class="fig">
<svg class="fig-hue-1" viewBox="0 0 150 150" width="150" height="150"
     role="img" aria-label="A cardioid with its cusp at the pole">
<path class="fig-gridline" d="…"/>
<path class="fig-axis" d="…"/>
<path class="fig-fill" d="…"/>
<path class="fig-curve" d="…"/>
</svg>
<figcaption>The cardioid $r = 1+\cos\theta$: area $3\pi/2$, length $8$.</figcaption>
</figure>
```

Leave a blank line either side so Markdown treats it as an HTML block.

## Geometry in the book, appearance in the stylesheet

**Never write `fill=`, `stroke=`, `style=`, or a font size on an element.** The
book carries path data and a class; the app's stylesheet decides what the class
looks like. That is the difference between a library whose figures stay coherent
and a collection of hand-coloured diagrams that drift apart.

| Class | For |
|---|---|
| `fig-gridline` | graph paper behind the curve |
| `fig-axis` | the axes and their ticks |
| `fig-curve` | the curve this figure is about |
| `fig-curve-alt` | a second curve it is compared against |
| `fig-guide` | dashed: asymptotes, construction lines, the part *not* traced |
| `fig-fill` / `fig-fill-alt` | a shaded region |
| `fig-point` | a marked point |
| `fig-arrow` | direction of travel |
| `fig-label` / `fig-label-em` | text inside the diagram |
| `fig-hue-1` … `fig-hue-6` | on the `<svg>`: which colour this figure uses |

`fig-hue-N` sets `--fig-ink`, which `fig-curve`, `fig-fill`, `fig-point`, and
`fig-arrow` all inherit. Vary it across a row of thumbnails; keep it constant
within one idea. If you need something the vocabulary lacks -- a gradient, an
arrowhead marker, a third curve weight -- **add it to the app's stylesheet and
use it**, do not inline a colour. The vocabulary is meant to grow.

## Generate curves, never draw them

Sample the actual equation and emit the path, so the picture cannot disagree
with the text beside it. A hand-drawn "roughly a cardioid" is worse than no
figure, because it teaches the wrong shape with authority. A polar-curve
generator can sample hundreds of points from $r=f(\theta)$ and map them to SVG
coordinates; anything similar is fine, but the numbers must come from the
formula.

Two things such a generator must handle:

- A curve that does not exist everywhere -- a lemniscate, anything with a square
  root -- must **break** its path rather than bridge the gap with a straight
  line. Emit a new `M` after each hole.
- A region bounded by a curve and a chord closes with `Z` on the curve's own
  endpoints. A region bounded by two rays closes through the pole. Using the
  wrong one shades the wrong area, and it looks plausible.

## The caption is the part that gets read aloud

`<svg>` is skipped by the speech pipeline -- its `<text>` nodes are axis ticks and
one-symbol labels, and reading "2 −2 x θ" into the middle of a sentence is worse
than silence. The `<figcaption>` is *not* skipped.

So the caption has to carry the point, not name the picture. "Figure 3" is
useless to a listener. "One leaf of $r=\cos3\theta$ runs between consecutive
zeros, $\theta=\pm\pi/6$ -- integrate over that and multiply" is the sentence they
need. Give every figure an `aria-label` too, for a screen reader.

The word count drops `<svg>` for the same reason. A figure adds its caption to a
chapter's length and nothing else.

## A row of small figures

Wrap thumbnails in `<div class="fig-grid">…</div>` -- it lays them out in a
responsive grid and tightens the captions. Use it for field guides and case
tables, where the point is comparison across several small pictures.

## Raster images and other media

Fenced blocks of box-drawing characters remain right for memory diagrams and
scene trees -- they are already legible, they diff, and readers are used to
them. Use SVG when geometry or proportion matters, ASCII when structure does,
and raster only when the thing being shown is genuinely a photograph or a
screenshot of software.

**Check what the app supports before writing an `<img>`.** This is the part most
likely to change: the routes below are the supported forms, and a reference to
something unreachable fails as a broken image rather than an error.

- **A file beside the chapter** -- works. `<img src="diagram.png">`, `<video>`,
  `<audio>`, and a local `<iframe src="widget.html">` all resolve inside
  `<library>/books/<slug>/`, rewritten to the app's local book route and served
  from that folder only. Relative to the chapter, as on a web page. What can be
  served is an allowlist: images, audio, video, and the HTML, JavaScript, CSS,
  and JSON a widget is built from; not Markdown, not dotfiles. A reference that
  climbs out of the book (`../other-book/x.png`) is refused and shows as a broken
  image.
- **A `data:` URI** -- works. Use it only for something small. Base64 is a third
  larger than the file, and it makes the chapter undiffable; a file beside the
  chapter is almost always better now that one works.
- **A remote URL in an `<iframe>`** -- works. The rule that governs it: **the
  text of a chapter is always local and always works offline; an embed may be
  online-only, and when it fails it must degrade without taking the rest of the
  chapter with it.** Never put anything a reader must have in order to follow
  the argument behind a network request. This exception covers embedded media
  and nothing else. Offline, the frame shows the browser's own failure page
  inside itself and the chapter reads on around it.

  What the application does, so a chapter does not have to:

  - **The sandbox is imposed.** Any `sandbox` attribute written in the chapter
    is replaced. A remote `https:` page gets `allow-scripts allow-same-origin
    allow-popups allow-presentation`; everything else, a book's own widget
    included, gets `allow-scripts` alone.
  - **Speech skips the frame**, and `<video>`, `<audio>`, and `<object>` with it,
    so their fallback markup is never read out. The `<figcaption>` is still
    the only thing a listener gets, and has to carry the point on its own.
  - **Frames load lazily**, so a chapter full of embeds costs nothing for the
    ones below where the reader stopped.

  A remote page may receive `allow-same-origin` because it keeps a different
  origin that cannot reach the application. A local widget must never receive
  it because scripts and same-origin together on a frame that shares the
  application's origin could let the frame remove its own sandbox.

## Mathematics inside raw HTML

A figure is raw HTML, and **nothing inside raw HTML is Markdown**. The
application handles one case for you: `$...$` inside a `<figcaption>` is
converted to typeset, speakable mathematics exactly as it would be in a
paragraph. Nowhere else in raw HTML is -- a dollar sign in a `<div>` is left
alone because ordinary prose may use it for money.

**Write `\lt` for a less-than inside mathematics in raw HTML.** The HTML parser
runs before anything else sees the chapter, and `$0<c<1$` reads to it as the
start of a tag named `c`: the rest of the caption vanishes into that tag,
silently, with no error anywhere. `>` is safe, and `<` followed by a digit or a
space is safe, but `\lt` is never wrong.

## Checking a figure

Open the chapter in Lectern and look at it. Two traps specific to figures:

- An unstyled SVG is not blank, it is **black**: with no `.fig-*` rule matching,
  `<path>` falls back to `fill: black; stroke: none` and every curve renders as a
  filled blob. If you see that, the stylesheet is not the one the app is loading.
- A curve produced from the wrong equation can still look polished. Compare its
  intercepts, zeros, direction, and shaded boundary with the mathematics before
  accepting it.
