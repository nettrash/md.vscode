# md for Visual Studio Code

[![Marketplace](https://vsmarketplacebadges.dev/version-short/nettrash.md-vscode.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=nettrash.md-vscode)
[![Installs](https://vsmarketplacebadges.dev/installs-short/nettrash.md-vscode.svg?label=Installs)](https://marketplace.visualstudio.com/items?itemName=nettrash.md-vscode)
[![Build](https://github.com/nettrash/md.vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/nettrash/md.vscode/actions/workflows/ci.yml)
[![License MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Markdown with mathematics, chemistry, charts and diagrams — drawn entirely on
your own machine, inside the preview you already use.

## What this is

md is a Markdown preview for people who write documents and not only
READMEs. Formulas and chemical equations, charts drawn from the function
you write, Mermaid flowcharts, Graphviz graphs, PlantUML drawings, data
pasted straight out of a spreadsheet, footnotes, front matter and
highlighted code all render as you type, and the finished document exports
to HTML, PDF, EPUB, LaTeX or SVG.

The first thing worth knowing: it **extends VS Code's built-in Markdown
preview** rather than opening a window of its own. *Open Preview*
(⇧⌘V, Ctrl+Shift+V), *Open Preview to the Side*, the two-way scroll sync
and every keybinding you have already learned keep working exactly as
before, and one document renders the same way however you opened it.
Nothing asks you to lower `markdown.preview.security` either — the
extension is built around that strict default rather than around an
exception to it.

Everything is drawn on your own machine: by engine files carried inside the
extension, and, in the case of the charts, by the extension's own renderer.
There is no account, no server of ours and no network round trip.

## Screenshots

![md rendering mathematics, a diagram and highlighted code in a dark colour theme](media/marketplace/preview-dark.png)

*The preview pane in a dark colour theme — mathematics set by KaTeX, Mermaid,
Graphviz and PlantUML drawings, and a fenced code block coloured by
highlight.js.*

![The same document in a light colour theme](media/marketplace/preview-light.png)

*The same document in a light theme. The page follows your colour theme and
your Markdown preview fonts by default.*

![The diagram panel showing a PlantUML sequence diagram in a dark colour theme](media/marketplace/diagram-panel.png)

*A `.puml` file previewing as the diagram it describes, source still fully
editable, through **Preview Diagram** in the editor title bar.*

## Features

### Mathematics, and chemistry with it

TeX and LaTeX mathematics inline as `$…$`, displayed as `$$…$$`, or in a
fenced ` ```math ` block, typeset by KaTeX. Chemical equations and physical
units come with it through the bundled mhchem extension: `\ce{…}` and
`\pu{…}` set the way a textbook would. A lone `$` in prose is left alone,
so "$5 and $10" stays a sentence about money rather than becoming a
formula.

### Charts, from a fence

A fenced ` ```plot ` block is a chart. Write `sin(x)` and you get the curve.
`x: -10..10` sets the window and `y: auto`, which is the default, fits the
vertical axis to what the function actually does; `title:`, `xlabel:`,
`ylabel:`, `legend:`, `grid:`, `axes:`, `width:`, `height:` and `samples:`
set the rest. One figure holds as many series as you like, each drawn in its
own colour and named in the legend — `envelope = exp(-abs(x)/5)` — and a
series can equally be a parametric curve, `(cos(t), sin(t)) for t in
0..2*pi`, or measured numbers, `points: 0,0 1,2 2,1`. The expressions are
ordinary arithmetic and comparisons, the trigonometric, hyperbolic and
inverse functions, `sqrt`, `cbrt`, `abs`, `exp`, `exp2`, `ln`, `log2`,
`log10`, `floor`, `ceil`, `round`, `atan2`, `pow` and `hypot`, and the
constants `pi` and `e`.

Nothing is bundled to draw them. The diagram engines carried inside the
extension are megabytes of JavaScript apiece; a chart uses none of them. It
is drawn by the extension's own renderer, in the same pass that renders the
Markdown, so the engine files shipped here are exactly the files that were
there before charts existed. That is also what settles where a chart runs.
Graphviz is WebAssembly and has to be laid out in the extension host, where
it takes a moment to compile before the first graph appears; Mermaid and
PlantUML are scripts that run in the page itself. A chart is neither, so the
preview is handed a finished drawing rather than something that has to draw
one — nothing to fetch, nothing to warm up, nothing to fall back to, and no
script in the page for the preview's default security to allow or refuse.

Being a drawing from the outset is also why a chart survives the trip out of
the document. It is vector in the preview, in the self-contained HTML, in
the PDF and in an exported EPUB — the first vector figure md has put into a
book on any of its platforms, where every other rich block is a picture —
and *Export Diagram as SVG…* offers it beside the diagrams. LaTeX is the
exception: a `.tex` file cannot take a vector drawing without a conversion
step it has no way to carry, so a chart travels there as the source you
wrote, under a comment, exactly as a Mermaid, Graphviz or PlantUML block
does.

A block that cannot be read keeps its own source on the page under a single
`plot: …` line saying what is wrong — an unknown function, a range that does
not increase, a bracket that was never closed. Never a hole, never an error
box.

### Mermaid

A fenced ` ```mermaid ` block draws a Mermaid diagram — flowcharts,
sequence and class diagrams, state machines, Gantt charts and the rest of
what Mermaid 11 can draw — and follows the light or dark theme of the page
it sits on.

### Graphviz

A fenced ` ```dot `, ` ```graphviz ` or ` ```gv ` block is laid out by
Graphviz. Every layout program can be named as the block's language
instead — `neato`, `circo`, `fdp`, `sfdp`, `twopi`, `osage` and
`patchwork` — so the same graph becomes a hierarchy, a spring model, a
circle or a radial fan by changing one word.

### PlantUML

A fenced ` ```plantuml ` or ` ```puml ` block draws the UML family and the
good deal more PlantUML can draw beside it: sequence, class, component,
activity, state, mind maps, work breakdowns and Gantt charts.

### CSV and TSV blocks

A fenced ` ```csv ` or ` ```tsv ` block is drawn as a table, quoted fields
and all, with all-number columns lined up on the right. The source stays
the data you pasted, so next month's numbers replace it wholesale instead
of being re-typed into pipes and dashes.

### Front matter

YAML or TOML front matter at the very top of a file — `---` … `---` or
`+++` … `+++` — is recognised as metadata and hidden from the page and
from every export, instead of surfacing as a horizontal rule followed by
stray text.

### Footnotes

Write `[^id]` in the text and `[^id]: the note` on a line of its own. The
notes gather under a rule at the foot of the page, numbered in the order a
reader meets them, each reference linking down to its note and each cited
note linking back.

### Task lists, tables and the everyday rest

Headings, bold, italic, inline code, links, strikethrough, block quotes
including nested ones, bullet and numbered lists with nesting, task lists
(`- [ ]` and `- [x]`), GitHub-style tables with column alignment, fenced
code blocks that scroll sideways rather than wrap, thematic breaks and
`\newpage` page breaks for the exports. Author notes — an HTML comment
whose text begins with `note:`, written on a line of its own — stay in the
file and never reach the page.

### Syntax highlighting

A fenced block that names its language reads with its keywords, comments
and strings set apart, in md's own quiet three-tone palette rather than a
bright editor one that would fight the page. Forty-odd languages are
covered. A fence with no language, or one whose language is unknown, stays
plain rather than being guessed at.

### Diagram files preview as diagrams

A `.puml`, `.plantuml`, `.iuml` or `.pu` file, and a `.gv` or `.dot` one,
opens as its own language with syntax highlighting and a **Preview
Diagram** button in the editor title bar. The panel beside it shows the
diagram the file describes and follows every edit, while the source stays
fully editable.

### Exports

*Export as HTML…* writes one self-contained file that opens anywhere with
nothing beside it — diagrams as drawings, formulas as selectable text.
*Export as PDF…* prints that same page at A4, A5, US Letter or Legal, or
at a print-on-demand trim size (6 × 9″, 5 × 8″, 5.5 × 8.5″).
*Export as EPUB…* builds an e-book whose table of contents is the
document's own headings, with an identifier derived from the title, so
re-exporting updates the reader's copy instead of stacking up beside it —
and a chart travels into that book as vector, while a diagram arrives as a
picture. *Export as LaTeX…* writes `.tex` in which your mathematics is still
the `$…$` you typed rather than a picture of it; a diagram or a chart
travels as the source you wrote, under a comment naming its language.
*Export Diagram as SVG…* saves one diagram, or one chart, as a real vector
file.

## Commands

All six appear in the Command Palette under the **md** category.

| Command | What it does | Offered when |
| --- | --- | --- |
| **md: Export as HTML…** | One self-contained `.html` file, engines and fonts included | a Markdown editor is active |
| **md: Export as PDF…** | The rendered document as a PDF, at the size in `md.export.pageSize` | a Markdown editor is active |
| **md: Export as EPUB…** | An e-book with the document's headings as its contents | a Markdown editor is active |
| **md: Export as LaTeX…** | `.tex` source, mathematics kept as mathematics | a Markdown editor is active |
| **md: Export Diagram as SVG…** | One Mermaid, Graphviz or PlantUML diagram, or one chart, as a vector file | a Markdown, PlantUML or Graphviz editor is active |
| **md: Preview Diagram** | Opens the diagram panel beside a diagram file | a PlantUML or Graphviz editor is active |

Mathematics is not on the SVG list, because KaTeX sets a formula as HTML
and text and there is no vector drawing to hand over.

## Settings

Every setting is resource-scoped, so it can be set for the user, for a
workspace or for one folder.

| Setting | Default | What it does |
| --- | --- | --- |
| `md.preview.theme` | `editor` | Which colours and fonts the preview draws in: `editor` follows your VS Code theme, `paper` is md's own typewriter look |
| `md.preview.bodyFont` | *(empty)* | Font stack for preview prose. Empty means follow the chosen theme |
| `md.preview.codeFont` | *(empty)* | Font stack for code blocks and inline code. Empty means follow the chosen theme |
| `md.math.enabled` | `true` | Typeset `$…$`, `$$…$$` and ` ```math ` with KaTeX, chemistry included |
| `md.diagrams.mermaid` | `true` | Render ` ```mermaid ` blocks |
| `md.diagrams.graphviz` | `true` | Render ` ```dot `, ` ```graphviz `, ` ```gv ` and the layout-named fences |
| `md.diagrams.plantuml` | `true` | Render ` ```plantuml ` and ` ```puml ` blocks |
| `md.diagrams.plot` | `true` | Draw ` ```plot ` blocks as charts |
| `md.highlight.enabled` | `true` | Syntax-highlight fenced code blocks that name a language |
| `md.export.pageSize` | `A4` | Page size for PDF export: `A4`, `A5`, `Letter`, `Legal`, `6x9`, `5x8`, `5.5x8.5` |

Turning an engine off leaves the block readable as the source you wrote.
It is never blank and never an error box. Charts are the odd one out among
those switches: there is no engine behind them, so turning
`md.diagrams.plot` off loads nothing less — it is there for when the numbers
behind a figure are what you would rather read.

## Themeing

By default the preview looks like the rest of your editor. It takes the
colours of your current colour theme and the typography of the built-in
Markdown preview — your `markdown.preview.fontFamily`,
`markdown.preview.fontSize` and `markdown.preview.lineHeight` — with your
`editor.fontFamily` for code. Change your theme and the page changes with
it, diagrams included.

Set `md.preview.theme` to `paper` and the page becomes md's own instead:
warm "fresh paper" in a light theme, "carbon paper" in a dark one, set in
American Typewriter with Courier New for code, matching the iPhone, iPad,
Mac and Android apps. `md.preview.bodyFont` and `md.preview.codeFont`
override either theme's faces where a machine lacks them.

## Privacy

Everything renders on your machine, from engine files that live inside the
extension. md has no account, no telemetry and no servers of ours to send
anything to. It reads the document you are previewing and writes only the
file you name when you ask for an export. The single thing that can reach
the network is an image **your own document names** by URL, which the
preview fetches so it can show it, exactly as a browser would. Visual
Studio Code's own telemetry is the editor's, governed by your
`telemetry.telemetryLevel` and by Microsoft's privacy statement. This
extension adds nothing to it and reads nothing from it. The full policy is
in [PRIVACY.md](PRIVACY.md).

## Requirements

- Visual Studio Code **1.95** or later.
- Desktop VS Code. The mathematics, highlighting and Graphviz engines run
  in the extension host and read their files from disk, which the browser
  extension host cannot do, so there is no `vscode.dev` build rather than
  one that silently renders half a document.
- A trusted workspace. The extension declares no support for untrusted
  ones and leaves that restricted default alone.

## Known limitations

Said plainly, because each one is a decision rather than an oversight.

- **A deliberate subset, not a CommonMark engine.** The renderer is the
  apps' renderer and inherits their omissions on purpose: raw HTML is
  escaped rather than passed through, so tags render as the characters you
  typed, there are no reference-style links, and a four-space indent
  continues a paragraph rather than starting a code block.
- **PDF output is not byte-identical to the apps'.** Same page sizes, same
  margins, same content, a different rasterizer — and American Typewriter
  does not exist away from Apple, so the glyphs themselves differ.
- **An exported EPUB keeps its code plain.** The e-book is built from the
  document before any colouring is applied, on every platform md ships on.
- **An author note is hidden only on a line of its own.** Written inline,
  it renders.
- **View modes belong to VS Code, not to md.** The iPhone, iPad, Mac and
  Android apps remember whether each file was last open in the editor,
  the preview or a split, because they own their whole window. Here the
  editor owns it: *Open Preview* and *Open Preview to the Side* place the
  preview, **View: Toggle Editor Group Layout** rearranges the columns,
  and VS Code restores your groups and tabs itself. md keeps no memory of
  its own, adds no setting for one and opens no preview uninvited.

## What changed

Every release is listed in the **Changelog** tab of this page, and in
[CHANGELOG.md](CHANGELOG.md) on GitHub.

## The rest of the family

md is also a native app elsewhere, sharing this renderer and these export
formats:

- [md for iPhone and iPad](https://github.com/nettrash/md)
- [md for macOS](https://github.com/nettrash/md.macOS)
- [md for Android](https://github.com/nettrash/md.Android)

Questions and bug reports are welcome at
[github.com/nettrash/md.vscode/issues](https://github.com/nettrash/md.vscode/issues).

## Licence

MIT — see [LICENSE](LICENSE). © 2026 nettrash.

The mathematics, diagram and highlighting engines are open-source projects
carried inside the extension, under their own licences:

| Engine | Version | Licence |
| --- | --- | --- |
| KaTeX, with the mhchem extension | 0.17.0 | MIT |
| Mermaid | 11.16.0 | MIT |
| Viz.js, carrying Graphviz | 3.24.0 / 14.1.1 | Viz.js MIT, Graphviz EPL-1.0, Expat MIT |
| PlantUML | 1.2026.4beta4 | GPL |
| highlight.js, the common-languages build | 11.11.1 | BSD-3-Clause |

Mermaid's own bundle carries DOMPurify under the Apache License 2.0 and
the Mozilla Public License 2.0, and js-yaml, Lodash and parts of Cytoscape
under MIT.
