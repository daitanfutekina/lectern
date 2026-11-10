---
name: textbook
description: Write or extend a chapter of a hand-written textbook in this library. Use when asked to write, continue, expand, fix, or add to a chapter, an appendix, or a book index.
---

# Writing a textbook chapter

The books in this library are **Markdown**, read by Lectern. Do not write a
standalone HTML page with its own stylesheet, navigation, or mathematics loader.
Everything the page needs for presentation, navigation, solution controls, and
mathematics rendering is the application's job.

A chapter is content and nothing else.

## Where a book lives

Paths are relative to the library root:

```
books/<slug>/
  book.yml                  title, index, chapter order, macros
  <subject>_ch1_topic.md    one file per chapter
  <subject>_index.md        the contents page, itself a chapter
  cover.svg                 optional
```

`book.yml` is the manifest. Chapter order comes from it, not from the file
names, so **a new chapter must be added to it** or it will not appear:

```yaml
title: "Example Textbook"
index: "subject_index.md"
chapters:
  - subject_ch0_prerequisites.md
  - subject_ch1_first_topic.md
macros:
  R: "\\mathbb{R}"
  proj: "\\operatorname{proj}"
```

`macros` are book-wide LaTeX definitions. Use them for anything the book repeats
-- `\R`, `\Col`, `\rank` -- and add to them rather than spelling the operator out
in every equation.

## The file

Front matter first, then the body. No `<h1>`: the title comes from front matter.

```markdown
---
title: "A Clear Chapter Title"
crumb: "Example Textbook · Chapter 1"
source: "markdown"
meta:
  - "Est. study time: ~45 minutes"
---

## Overview

Prose. Headings are `##` for sections and `###` for subsections.
```

Mathematics is `$inline$` and `$$display$$`. It is typeset in the app; do not
add a script tag or a CDN link.

## Directives

A directive is a titled box. The name is the box's style and the bracketed part
is its heading:

```markdown
:::definition[Definition 1.1 — A useful object]
State the definition precisely here.
:::
```

**These are the only names that work.** Anything else renders as an untitled box
with a warning outline, which is deliberate -- a typo should be visible.

| Directive | For |
|---|---|
| `definition` | a formal definition |
| `theorem` | a named result |
| `lemma` | a supporting result |
| `corollary` | a direct consequence |
| `proof` | a proof; the app adds the tombstone |
| `example` | a worked example |
| `problem` | a practice problem |
| `solution` | the answer to one -- **collapsed until asked for** |
| `answer` | a short answer -- also collapsed |
| `summary` | the end-of-chapter recap |
| `callout-intuition` | why this exists, before the formalism |
| `callout-key` | the thing to remember |
| `callout-pitfall` | the mistake students actually make |
| `callout-warning` | a genuine trap or edge case |
| `callout-tip` | technique, shortcut, or exam advice |
| `callout-connect` | a link to another chapter, a video, or a real use |
| `note` | an aside |
| `annot` | an aside for annotating code |

A problem carries its difficulty:

```markdown
::::problem[Problem 1.4 — A useful calculation]{difficulty=challenge}
Find the requested value.

:::solution[Solution]
**Answer: $12$.** Here is how we get there ...
:::
::::
```

`difficulty` is `easy`, `standard`, or `challenge`. Aim for roughly 30/50/20.

## House conventions

- **A problem box holds only the problem.** Inside it is exactly one collapsed
  `::::solution[Solution]`. That solution starts with `**Answer:** ...`, then
  gives numbered steps with a short reason for each, and ends with a one-line
  check where one exists, such as plugging the answer back in. This applies to
  every problem, easy and mixed practice included; a solution under about 45
  words is a defect. A worked example has the same shape inside
  `::::answer[Answer]`.
- **Box titles are only `Solution` (problems) and `Answer` (examples).** Not
  "Hidden solution", "Answer first", "Yes", and so on.
- **Headings:** `## 4.1 Title` for a section, with no § and no dash. The other
  `##` headings are exactly `Overview`, `Chapter Summary`, and `Mixed Practice`.
  Use `###` subheadings so that no section runs as one unbroken block.
- **Labels:** `Example 4.1 — title`, `Problem 4.1 — title`, and
  `Problem M.1 — title`, numbered consecutively through the chapter. Write
  difficulty as `{difficulty=easy}`, without quotes.
- **No bookkeeping in the book:** no "(preserved)", "(corrected)", or "Extended
  handwritten steps", and no hidden `<!-- -->` notes, which render as stray
  characters.
- **Length budget:** about 2,500-2,800 words of prose per section. A solution
  is as long as its steps need, but the prose does not grow to match.

## How these books are written

These rules come from how the reader actually learns. A chapter that breaks them
is one they will not use.

1. **Intuition before formalism.** Every section opens with plain English about
   what problem this solves and why anyone invented it. Then the definition.
   Formalism first is the single commonest way a textbook becomes unreadable.

2. **No skipped steps.** Especially in algebra. If a derivation goes from
   $(x+1)^2 = 4$ to $x = 1$ or $x = -3$, the line $x + 1 = \pm 2$ must be
   written. Assume the reader is meeting this manipulation for the first time.

3. **Answer first, then the work.** A worked example states its result at the
   top -- "**Answer: $8r$.** Here is how we get there" -- so the reader can check
   a guess immediately and then study the derivation.

4. **Worked examples beat prose.** Four fully worked examples are worth more
   than four paragraphs of explanation. Range them from the obvious application
   to the case that catches people out. A chapter with no worked example is a
   common and serious defect.

5. **Name the pitfalls.** Every section gets a `callout-pitfall` with the two or
   three mistakes students really make -- not hypothetical ones.

6. **Problems with hidden solutions.** Five to eight per section, in a
   `problem` directive each, followed by a `solution`. The app collapses
   solutions, so the reader attempts first without being asked to look away.

7. **Draw the thing.** If a passage makes a claim about a shape, a layout, or a
   position, it needs a figure -- see the section below. Prose describing a
   picture is the reader doing your job.

## Figures

**Put figures in, and go looking for the places that want one.** A list of curve
families, geometric regions, or spatial arrangements without a picture makes the
reader memorise vocabulary instead of recognising shapes.

**Required**, wherever the subject itself is spatial: a curve whose shape is the
point; a region being integrated over, with the region shaded; a data
structure's layout, and before-and-after for a rotation or a rehash; a scene
tree or an object's placement; any claim about direction, orientation, or which
of two things is larger.

**Worth it even when not required**, if a reader who did not already understand
would get there faster. A figure showing *why* a formula is what it is usually
earns its place. A figure that decorates does not.

**Inline SVG is the default**, and the one rule that must not bend: the book
carries path data and a class, and every colour, weight, and size lives in the
app's stylesheet. Never write `fill=`, `stroke=`, or `style=` on an element.
That is the difference between a library that stays coherent and diagrams that
drift apart.

**Curves are sampled from their equation, never drawn by hand**, and the
`<figcaption>` carries the point in a sentence -- it is the only part of a figure
that is read aloud.

See `references/figures.md` for the class vocabulary, the generator, how raster
and remote media are handled, and how to check a figure renders.

## Write it to be listened to

These books are read aloud. That changes what good looks like, and it changes it
in the opposite direction from most writing advice.

A reader who is *looking* at a page can re-read a sentence, skip a paragraph,
and take in a table at a glance. A reader who is *listening* can do none of
that. Density is a cost rather than a virtue, and length is nearly free -- a
paragraph that takes thirty seconds to say is thirty seconds well spent if it
carries the reader. **Prefer the longer explanation.**

What that means concretely:

- **Say it in full sentences.** "Hence, by the above, $f$ is continuous" is
  unfollowable aloud. "Because $f$ is a polynomial, and every polynomial is
  continuous everywhere, $f$ is continuous at this point too" is the same claim
  and can be followed with the eyes shut.
- **Name things before using them.** Do not write "the second condition" three
  paragraphs after stating it; say what the condition was.
- **Talk through the algebra.** Not only the steps, but why each one. "Multiply
  both sides by $x - 1$ -- we can do that because we already excluded $x = 1$."
- **Say the shape of what is coming.** "There are three cases; the third is the
  only interesting one" tells a listener how to allocate attention, which they
  cannot get by glancing ahead.
- **Restate the result after a long derivation.** A listener has lost the thread
  by the end of a page of algebra. A reader can look up.
- **Let a table be prose too.** A comparison table is invisible when spoken, so
  the point it makes must also appear in a sentence near it. Keep the table --
  it is good on screen -- but do not let it carry the only copy of the idea.

None of this is licence to pad. The test for a sentence is whether a listener
who did not already understand would be helped by hearing it. Repetition that
lands the idea is worth it; repetition that fills space is not. Never write "as
we have seen", "it is important to note", "in this section we will discuss", or
a paragraph that only announces the next paragraph.

Aim for **two to three times the prose** the same chapter would carry if it were
written to be skimmed, and none of the extra in adjectives.

## Shape of a chapter

```
front matter
## Overview                    what this is for, what you'll be able to do
:::callout-key[Prerequisites]  what to have read first

## 1.1 First concept
  :::callout-intuition         why this exists
  :::definition                the formal statement
  :::theorem / :::proof        if there is one
  :::example                   two to four, answer-first
  :::callout-pitfall           what goes wrong
  :::problem / :::solution     five to eight

## 1.2 Second concept ...

## Chapter Summary
  :::summary                   the formulas, compactly
## Mixed Practice              ten to fifteen, difficulty mixed, order mixed
```

Do **not** write a table of contents into a chapter, and do **not** write
previous/next links. The application draws both.

## Subjects

- **Proof-based mathematics** -- full `definition` / `theorem` / `proof`
  machinery. Every named theorem gets a directive.
- **Programming and data structures** -- code in fenced blocks with a language
  tag. Complexity claims get a `theorem` or a `callout-key`; loop invariants are
  worth stating. Memory diagrams may use fenced blocks of box-drawing
  characters.
- **Procedural software and game engines** -- procedural explanations, not
  theorems. Code goes in fenced blocks. Scene or object trees use fenced
  diagrams. Name the actual types and components.
- **Argument analysis and test preparation** -- argument structure over
  formalism. Use `example` for a stimulus, `callout-pitfall` for the trap answer,
  and say *why* each wrong choice is wrong rather than only which is right.

## Working on an existing book

Read the neighbouring chapters before writing. These books have a voice and a
level, and a chapter that sits at a different one is worse than a missing
chapter. Match the numbering, the crumb format, and the density of the book you
are adding to.

When editing rather than adding, change what was asked for and leave the rest.
These files are long, and a wholesale rewrite loses work that was fine.

## After writing

1. Add the file to `chapters:` in `book.yml`, in reading order.
2. Run `references/chapter-lint.py` on the chapter from the library root.
3. Open the chapter in Lectern and read it.

A chapter that has not been opened in Lectern has not been checked. Unbalanced
`:::` fences and a mistyped directive name both produce a page that looks
plausible in the file and wrong on the screen.
