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
> [macOS](https://github.com/nettrash/md.macOS) and
> [Android](https://github.com/nettrash/md.Android) siblings. All four
> share the same hand-written block parser, renderer and themed HTML
> export; this port reimplements them in TypeScript. The difference worth
> knowing is that the other three own their whole preview window and this
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
- **Diagram files preview as diagrams.** A `.puml` / `.plantuml` /
  `.iuml` / `.pu` file, or a `.gv` / `.dot` one, opens as its own
  language with *Preview Diagram* in the editor title bar, and renders as
  the diagram it describes while the source stays fully editable. The
  apps leave `.dot` unclaimed because macOS already declares it a Word
  template; a language association inside VS Code is not a system-wide
  file type, so here it costs nothing and is claimed.
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
  block of that kind.
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
- **Every engine has an off switch.** `md.math.enabled`,
  `md.diagrams.mermaid`, `md.diagrams.graphviz`, `md.diagrams.plantuml`
  and `md.highlight.enabled` each turn one of them off for a workspace or
  a folder, and a block whose engine is off stays readable as the source
  you wrote — never blank, and never an error box.

## Platform

- Visual Studio Code **1.95** or later
- Desktop only. The math, highlighting and Graphviz engines run in the
  extension host and read their files from disk, which the browser
  extension host cannot do — so there is no `vscode.dev` build rather
  than a `vscode.dev` build that silently renders half a document.
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

# Build the installable .vsix, and list what it will contain
npx vsce ls
npx vsce package
```

Requires Node 20, the major VS Code runs extensions on. Press F5 in this
repository to launch an Extension Development Host with the extension
loaded. There is no build number to increment as there is on iOS, macOS
and Android; the Marketplace takes a three-part version, so the family's
`1.0` is published as `1.0.0`.

## License

MIT — see [LICENSE](LICENSE). © 2026 nettrash.
