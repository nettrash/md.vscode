# md for VS Code

[![build](https://github.com/nettrash/md.vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/nettrash/md.vscode/actions/workflows/ci.yml)

The simplest Markdown preview for Visual Studio Code. Write Markdown in
the editor, see it rendered beside it — in **VS Code's own preview**, on
the ⇧⌘V / Ctrl+Shift+V you already use, not in a second window of ours.
Built in TypeScript on top of the built-in Markdown preview, with a
**hand-written Markdown renderer**. **No runtime npm packages, no
accounts, no servers** — your files stay wherever you keep them, and
nothing about them is sent anywhere. The only vendored code is the
offline math / diagram engines under `media/rich/` (KaTeX with the mhchem
chemistry extension, Mermaid, Graphviz, PlantUML, and highlight.js for
code).

> This is the VS Code port of [**md**](https://github.com/nettrash/md),
> the iPhone / iPad editor, and of its native
> [macOS](https://github.com/nettrash/md.macOS),
> [Windows](https://github.com/nettrash/md.win) and
> [Android](https://github.com/nettrash/md.Android) siblings. All five
> share the same hand-written block parser, renderer and themed HTML
> export; this port reimplements them in TypeScript. The difference worth
> knowing is that the other four own their whole preview window and this
> one is a guest in VS Code's: so the byte-for-byte parity contract lives
> in the **export** path, which md.vscode writes end to end, while the
> preview aims at looking the same rather than at being the same bytes.
> That is also why there is no second preview window — VS Code already
> has one, and a rendered document should not depend on which button you
> pressed to see it.

## Features

- **In the preview you already use.** The extension extends VS Code's
  built-in Markdown preview rather than opening one of its own, so
  *Open Preview*, *Open Preview to the Side*, the two-way scroll sync and
  every keybinding you have already learned keep working, and a document
  is rendered the same way whether you opened the preview from the
  command palette, the editor title bar or the keyboard. Nothing asks you
  to lower `markdown.preview.security`: the preview runs under its strict
  default policy, which is the constraint the whole design is built
  around (see **Where each engine runs** below).
- **Live preview.** A hand-written renderer covers the everyday Markdown
  you actually write:
  - Headings (`#`–`######`)
  - **Bold**, *italic*, `inline code`, [links](https://nettrash.me) and
    ~~strikethrough~~
  - Bullet, numbered and **task lists** (`- [ ]` / `- [x]`), with nesting
  - Fenced code blocks (```` ``` ```` and `~~~`), with horizontal scroll —
    **syntax-highlighted** in md's own quiet paper palette when the fence
    names a language (`ts`, `rust`, `python`, …); a bare fence stays plain
  - Block quotes (including nested)
  - GitHub-style tables, with column alignment
  - **CSV / TSV blocks** (` ```csv `, ` ```tsv `) — data pasted straight
    out of a spreadsheet drawn as a table, quoted fields and all, with
    all-number columns lined up on the right; the source stays the data,
    so it can be replaced wholesale when the numbers change
  - Thematic breaks (`---`) and page breaks (`\newpage`)
  - YAML / TOML **front matter** (`---` … `---` or `+++` … `+++`) at the
    very top of a file — recognised as metadata and hidden from the page
    and from every export, instead of showing up as a rule and stray text
  - **Footnotes** (`[^id]` in the text, `[^id]: the note` on a line of its
    own) — gathered under a rule at the foot of the rendered page and
    numbered in the order a reader meets them, each reference linking down
    to its note and each cited note linking back
  - `<!-- note: … -->` author notes, which stay in the file and never
    reach the page — as long as the comment is on a line of its own
- **A deliberate subset, not a CommonMark engine.** The renderer is the
  apps' renderer, so it inherits their omissions on purpose: raw HTML is
  escaped rather than passed through (`<b>hi</b>` renders as the five
  characters you typed), there are no reference-style links, and a
  four-space indent is a paragraph continuation rather than a code block.
  Each of those is a decision three shipping apps already made, and
  changing one here would make four documents out of one.
- **Math and diagrams.** TeX/LaTeX math (`$…$`, `$$…$$` and ` ```math `)
  with **chemistry** notation (`\ce{…}` / `\pu{…}`) through the bundled
  mhchem extension, plus **Mermaid** (` ```mermaid `), **Graphviz**
  (` ```dot `, ` ```graphviz ` or ` ```gv `, and every layout program —
  `neato`, `circo`, `fdp`, `sfdp`, `twopi`, `osage`, `patchwork` — usable
  as the block language) and **PlantUML** (` ```plantuml `). A single `$`
  in prose is left alone: `$5 and $10` is a sentence about money, not a
  formula, which is why the auto-render pass every other Markdown
  extension uses is deliberately not loaded.
- **Charts from a fence.** A ` ```plot ` block is a chart:
  `sin(x) * exp(-abs(x)/5)` draws the curve, `x: -10..10` sets the
  window, `y: auto` fits it to the function, and `title:`, `xlabel:`,
  `ylabel:`, `legend:`, `grid:`, `axes:`, `width:`, `height:` and
  `samples:` set the rest. One block may hold several series
  (`envelope = exp(-abs(x)/5)` names one for the legend), parametric
  curves (`(cos(t), sin(t)) for t in 0..2*pi`) and measured points
  (`points: 0,0 1,2 2,1`). The expression language is the one the
  plotter on [nettrash.me](https://nettrash.me) speaks — `pi` and `e`,
  the trigonometric, hyperbolic, logarithmic and rounding functions,
  `atan2`, `pow`, `hypot`, comparisons and the Boolean operators, so
  `(x > 0) * sqrt(x)` is a half-domain curve. **It is not an engine**:
  the renderer is a hand-written pure function, nothing is vendored for
  it and nothing is fetched, so a chart is already an `<svg>` in the page
  — which is why it travels intact into the self-contained HTML, print,
  PDF, EPUB and *Export Diagram as SVG…* without a rasterisation step,
  and why a document of nothing but charts loads no engine at all. Its
  ink is `currentColor`, so one figure is right on light paper, on dark
  paper and in print; only the curves carry a colour. A block that
  cannot be read keeps its source under one `plot: …` line.
- **Diagram files preview as diagrams.** A `.puml` / `.plantuml` /
  `.iuml` / `.pu` file, or a `.gv` / `.dot` one, opens as its own
  language with *Preview Diagram* in the editor title bar, and renders as
  the diagram it describes while the source stays fully editable. The
  apps leave `.dot` unclaimed because macOS already declares it a Word
  template; a language association inside VS Code is not a system-wide
  file type, so here it costs nothing and is claimed.
- **Every spelling of Markdown opens as Markdown.** The family's list is
  `.md`, `.markdown`, `.mdown`, `.markdn`, `.mdtext`, `.mdtxt`, `.mkd`,
  `.mkdn`, `.mdwn` and `.mkdown`, and VS Code's own `markdown` language
  already knows all but `.mkdn` and `.mkdown` — so the extension
  contributes exactly those two, as a second `languages` entry in
  `package.json` that names the **built-in** id and carries nothing but
  `extensions`. VS Code merges such an entry into the language it
  already has rather than replacing it; that is the whole trick, and
  also the rule: the entry must never grow `aliases`, a `configuration`
  or a grammar of its own, because any of those would shadow the
  built-in's and turn every `.md` file into ours. `package.json` cannot
  carry a comment, so the reason lives here and in
  `test/package.test.ts`, which pins all three extension lists. Newer
  editors have lengthened their own list — 1.138 already carries
  `.mkdn` — and a repeated extension is harmless there; the entry is for
  the oldest editor `engines.vscode` admits, where it is what makes the
  file open as Markdown at all.
- **Where each engine runs.** Not an implementation detail — it is the
  reason the preview works at all. VS Code's Markdown preview runs under
  `script-src 'nonce-…'` and nothing else, which forbids WebAssembly, so
  **Graphviz** is laid out in the extension host, where WASM is ordinary
  Node, and arrives in the page as finished SVG. **KaTeX** and
  **highlight.js** are there too — both have pure string APIs, so
  typesetting them once in the host keeps some 400 KB out of every
  preview and makes the preview and every export agree by construction.
  **Mermaid** and **PlantUML** run in the preview instead, because both
  measure real text to lay a diagram out and a headless DOM gets that
  wrong (Mermaid produces a 30 998-pixel-wide drawing with no text in
  it). Both are pure JavaScript, so the nonce policy allows them, and
  neither is loaded at all unless the document in front of you contains a
  block of that kind, with the engine switched on.
- **The diagrams the built-in preview cannot draw, and where to draw
  them.** PlantUML lays some of its diagrams out itself and hands the rest
  to Graphviz, and Graphviz is the WebAssembly the preview's policy
  forbids. So in the **preview**, sequence diagrams, the modern activity
  syntax (`start` / `if` / `stop`), mind maps, Gantt charts, WBS, JSON,
  YAML, salt wireframes and timing diagrams all draw; class, state,
  component, object, use-case, deployment and ER diagrams — and the
  legacy `(*) -->` activity syntax — show their source instead, after a
  pause. Everywhere else in this extension they draw normally: the
  **diagram panel** (*md: Preview Diagram*) and every **export** render
  in a webview of md's own that permits WebAssembly and loads Graphviz.
  This is measured rather than believed — `test/plantuml-csp.test.ts`
  runs each of those diagrams in a real browser under the preview's real
  policy on every test run — and it is not a setting anyone can change:
  the built-in preview's Content Security Policy is VS Code's, and a
  `!pragma layout smetana` does not move PlantUML off Graphviz in this
  build.
- **Everything renders on your machine.** The engines are files on disk
  inside the extension — KaTeX 0.17.0 with mhchem, Mermaid 11.16.0,
  Graphviz 14.1.1 through Viz.js 3.24.0, PlantUML 1.2026.4beta4 and
  highlight.js 11.11.1 — and nothing is fetched, phoned home or checked
  for. The one thing that can still reach the network is an image **your
  own document names** by URL, which the preview loads exactly as a
  browser would.
- **Typewriter feel.** The apps' paper palette — light "fresh paper",
  dark "carbon paper" — following the editor's own light or dark theme,
  American Typewriter where the system has it and Georgia where it does
  not, with Courier New for code. `md.preview.theme` switches the page to
  your VS Code colour theme instead, and the two font stacks are settings
  as well, for hosts where the Apple face does not exist.
- **Export.** *Export as HTML…* writes one self-contained `.html` file
  that opens anywhere with nothing beside it — diagrams as drawings,
  formulas as selectable text — where "self-contained" means engines and
  fonts, not assets: an image you linked yourself travels as the link you
  wrote. *Export as PDF…* prints the same page at A4, A5, US Letter or
  Legal, or a print-on-demand trim size (6 × 9″, 5 × 8″, 5.5 × 8.5″).
  *Export as EPUB…* makes an e-book whose contents are the document's own
  headings, with an identifier derived from the title so re-exporting
  updates the reader's copy instead of stacking up beside it — the same
  way, and to the same bytes, as the phone does. *Export as LaTeX…*
  writes `.tex` in which your mathematics is still the `$…$` you typed
  rather than a picture of it. *Export Diagram as SVG…* saves one
  diagram as a real vector file; math is not on that list, because KaTeX
  sets a formula as HTML and text and there is no vector to hand over.
- **The exports are where the files are.** Every one of them is on the
  right-click menu now as well as in the Command Palette: **md: Export**
  opens as a submenu with *HTML*, *PDF*, *EPUB* and *LaTeX* under it —
  on a Markdown file in the Explorer, in the editor itself, and on the
  editor tab — with *Export Diagram as SVG…* and *Preview Diagram*
  beside it on a `.puml` or `.gv` file. A menu hands the command the
  file that was clicked, so the export is of **that** file rather than
  of whatever editor happened to be focused, and of the unsaved text
  when the file is open, which is what you are looking at.
- **A folder of Markdown, exported in one go.** Select several Markdown
  files in the Explorer, right-click, and *HTML*, *EPUB* or *LaTeX*
  exports all of them: one question — which folder — then one
  cancellable progress notification counting through the files, and one
  line at the end saying how many landed, naming any that did not and
  any non-Markdown file that was skipped. Each export is named after its
  own source file, so `notes.md` becomes `notes.html`, and a name
  already taken in the destination — two `README.md` from two folders,
  or a previous export sitting there — takes a `-2` instead of
  overwriting it. **PDF is the one export a batch does not offer**,
  because it writes no bytes itself: it hands a print-ready page to the
  host's print dialogue, where you choose *Save as PDF* and a
  destination, and twenty print dialogues in a row is not an export. It
  stays one file at a time, from the same menu.
- **Every engine has an off switch.** `md.math.enabled`,
  `md.diagrams.mermaid`, `md.diagrams.graphviz`, `md.diagrams.plantuml`
  and `md.highlight.enabled` each turn one of them off for a workspace or
  a folder, and a block whose engine is off stays readable as the source
  you wrote — never blank, and never an error box. Switching one off also
  means its engine is never fetched: a document full of Mermaid with
  `md.diagrams.mermaid` off costs the preview nothing at all, which for
  PlantUML is 7.4 MB not loaded. `md.diagrams.plot` joins them and is the
  odd one out: there is no engine behind a chart, so turning it off loads
  nothing less — it is there for when the numbers behind a figure are
  what you want to read.
- **It tells you where md's Markdown differs from GitHub's.** md renders
  a deliberate subset — that is the line at the top of this README, and
  it is a decision three shipping apps made — so a document written for
  GitHub can render differently here with nothing to say it has. The
  extension now says it, as a faint underline and a row in the Problems
  pane, at **Information** level and never higher: the Markdown is not
  wrong, it will simply look different. Five rules, each naming what md
  does instead:

  | Rule | What md does instead |
  | --- | --- |
  | `rawHtml` | Escapes the tag. `<b>bold</b>` appears as those characters; there is no raw-HTML passthrough anywhere in the renderer. |
  | `referenceLink` | Has neither half of the syntax. `[text][label]` prints as written, and the `[label]: url` line prints too instead of disappearing. |
  | `indentedCode` | Has no indented code block. Four spaces start a **paragraph**, so the indentation and the monospaced type are lost. *Quick fix: wrap it in a fence.* |
  | `tableAfterParagraph` | Needs a blank line above a table. Written straight under a paragraph, the rows stay part of it and render as text. *Quick fix: insert the blank line.* |
  | `footnote` | Prints a definition nothing cites at the foot of the document anyway, with no number in the text and no link back to it, where a CommonMark engine swallows the line and prints nothing at all. |

  Two of the five carry a quick fix, and only those two: fencing an
  indented block and adding a blank line are rearrangements with no
  judgement in them, whereas which URL a reference link meant is a
  question only the author can answer. The lint decides through the same
  parser and the same inline pass the preview renders with — never a
  second parser, which is how a lint comes to report a difference that is
  not there — so a `<` in prose is not a tag, a tag inside backticks is
  not a tag, an indented paragraph under a list item is not code, a
  footnote defined at the foot of the file is cited, and `[^a-z]` in a
  sentence about regular expressions is a character class rather than a
  citation of a note that is missing. Switch the whole
  thing off with `md.lint.dialect`, or one rule at a time with
  `md.lint.rules`. It reads the document in the editor and nothing else;
  nothing is sent anywhere, as ever.

## Platform

- Visual Studio Code **1.95** or later
- Desktop only. The math, highlighting and Graphviz engines run in the
  extension host and read their files from disk, which the browser
  extension host cannot do — so there is no `vscode.dev` build rather
  than a `vscode.dev` build that silently renders half a document.
- **No view-mode memory, on purpose.** The iPhone, iPad, Mac, Windows
  and Android apps remember whether each file was last open in the
  editor, the preview or a split, because those apps own their whole
  window and something there has to decide. Here VS Code decides, and
  has since before this extension existed: *Open Preview*
  (`markdown.showPreview`) and *Open Preview to the Side*
  (`markdown.showPreviewToSide`) put the preview where you want it,
  **View: Toggle Editor Group Layout** rearranges the columns, and the
  editor restores the groups and tabs you left open when the window
  comes back. So this port keeps no memory of its own, adds no setting
  for one and auto-opens nothing — not a gap in the port but the same
  decision the preview itself rests on: a document should render the
  same however you opened it, and where you opened it is yours.
- **PDF is the one export without byte parity**, and deliberately so: the
  apps paginate through WebKit and this port cannot, and American
  Typewriter does not exist away from Apple, so the glyphs themselves
  differ. Same page sizes, same margins, same content — a different
  rasterizer.

## Build

Nothing to resolve at run time: the extension has no `dependencies`, only
the toolchain below.

```bash
# Install the toolchain
npm ci

# Type-check (strict, with unused locals and parameters as errors)
npm run typecheck

# Run the unit tests — vitest over the parity core, no editor in the loop
npm test

# Bundle the extension host and the preview script
npm run compile

# Build the installable .vsix, and list what it will contain. Packaging
# goes through the script, never through `vsce package` directly — the
# script stands the Marketplace listing in as the packaged README.md for
# the length of the run, and `vscode:prepublish` refuses a direct call.
node scripts/package.mjs --list
```

Requires Node 20, the major VS Code runs extensions on. Press F5 in this
repository to launch an Extension Development Host with the extension
loaded. There is no build number to increment as there is on iOS, macOS
and Android; the Marketplace takes a three-part version, so the family's
`1.5` is published as `1.5.0`.

Publishing goes to **two** registries from one built file —
`npm run publish:vsix`, which is `vsce publish --packagePath` and
`ovsx publish --packagePath` over the `.vsix` the packaging step
produced, never the bare verbs. The second registry is
[Open VSX](https://open-vsx.org), which is what Cursor, Windsurf,
VSCodium, Gitpod and Theia install from. The `nettrash` namespace there
was claimed on 2026-09-23 and is still empty; what is left is the two
repository secrets and a tagged release. `marketplace/README.md` has the
detail. The `publish` job in CI runs
only on a `v*.*.*` tag and only once **both** `VSCE_PAT` and `OVSX_PAT`
exist, so until then a tag builds, tests and packages and publishes
nothing.

## License

MIT — see [LICENSE](LICENSE). © 2026 nettrash.
