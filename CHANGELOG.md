# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

There is no build number to auto-increment here — no `agvtool bump` as on
iOS and macOS, no Gradle `versionCode` finalizer as on Android — and the
Marketplace requires a three-part version, so the family's two-part `1.1`
is published as `1.1.0`. A republish that changes no behaviour is not
tracked here.

This is a new app rather than a continuation of the apps' 1.3 line. Every
md port has begun at its own 1.0 and joined the family's number at the
next family release, and this one does the same — arriving, because it
comes last, with everything the other three learned through 1.3 already
in it.

## [1.1] — 2026-08-06

### Fixed

- **Large PlantUML diagrams render.** The vendored browser build of
  PlantUML carries a hard limit of its own: a diagram whose finished
  layout exceeded 4096 pixels in either direction was discarded, and the
  block showed `Diagram too large for browser rendering: …` where the
  drawing should have been — a 48-participant sequence diagram was
  already past the line. That gate guards a raster budget, and no
  drawing here can overspend one: the preview, the diagram panel and the
  HTML, SVG and PDF exports take the SVG itself, whose dimensions are
  numbers in a text file; the LaTeX export keeps the source; and the
  EPUB export — the one path that does draw a diagram onto a canvas —
  draws it at the size the page laid it out, already capped at the
  page's own width. So the gate was defending a budget none of these
  paths can exceed, and the price was real diagrams. It is raised out of
  reach — to 10⁹ pixels, in the preview and in every export alike, since
  all of them draw through the same engine. Measured in a real browser
  rather than presumed: the
  sequence diagram that used to die at the gate now arrives at
  7656 × 1445 in about 70 ms, a 120-participant one at 19 397 × 3533 in
  about 130 ms, and a small diagram renders byte-identically to before.
  This is the one deliberate departure from the engine's vendored bytes;
  it is documented where the vendoring story is told, and a test now
  fails loudly if a future engine update quietly brings the limit back.

## [1.0] — 2026-08-01

### Added

- **Initial release.** md for Visual Studio Code: the same hand-written
  Markdown renderer the iPhone, iPad, Mac and Android apps draw with,
  brought into the editor you already write in. It renders inside **VS
  Code's own Markdown preview** rather than in a window of its own, and
  that is the first decision, the one everything else follows from. The
  preview opens on the command and the shortcut you already know, scrolls
  with the editor in both directions, and shows the same page however you
  opened it — a second window would have been ours to control and would
  have cost the reader every habit they had. The trade is worth stating
  plainly, because it is the one way this port differs in kind from its
  siblings: VS Code owns the page's shell, so byte-for-byte parity with
  the apps is enforced in the **export** path — a file md.vscode writes
  is the file the phone writes — while the preview aims at looking the
  same rather than at being the same bytes. And the renderer arrives with
  its omissions intact, because they are decisions three shipping apps
  already made: raw HTML is escaped rather than passed through, so
  `<b>hi</b>` renders as the eight characters you typed; there are no
  reference-style links; and a four-space indent continues a paragraph
  instead of opening a code block. Writer mode's books are not in this
  release — VS Code already has a file explorer, and the numbering-aware
  half of what makes a folder a book is a release of its own.
- **The typewriter theme.** The page is the apps' page: warm paper —
  "fresh paper" in a light editor, "carbon paper" in a dark one — with
  American Typewriter where the system has that face and Georgia where it
  does not, which is the substitution the Android app already made for
  the same reason, and Courier New for code. The palette is written into
  the stylesheet rather than drawn from VS Code's theme colours, so it is
  the same paper in every editor and, more to the point, an export from a
  dark editor still comes out as black ink on white paper: a document on
  its way to being printed has never been the place for a dark theme. If
  a page that ignores your colour theme is not what you want,
  `md.preview.theme` set to `editor` follows the theme instead, and the
  two font stacks are settings of their own for hosts where the Apple
  face does not exist.
- **Math, and chemistry with it.** TeX and LaTeX mathematics — `$…$`
  inline, `$$…$$` display, and a fenced ` ```math ` block — is typeset
  the way the apps typeset it, and `\ce{…}` and `\pu{…}` set chemistry
  and physical units the way a textbook would. It draws **on your own
  machine** from `katex.min.js` (**KaTeX 0.17.0**, MIT-licensed) and
  `mhchem.min.js` (the `mhchem` extension from that same build, ~33 KB),
  both files on disk inside the extension, so a formula costs no network
  and nothing is fetched the first time you write one. Unlike the apps,
  which typeset in their preview, this port typesets in the extension
  host: KaTeX has a pure string API there, so a formula is set once and
  the same markup reaches the preview, an exported HTML page, a PDF and
  an EPUB alike — they agree by construction rather than by testing. One
  restraint is deliberate and easy to lose: KaTeX's own auto-render pass,
  which scans a finished page for delimiters, is **not** loaded. It would
  read `$5 and $10` as a formula, and prose about money staying prose is
  worth more than the convenience.
- **Diagrams: Mermaid, Graphviz and PlantUML.** A fenced block tagged
  `mermaid` draws a Mermaid diagram; one tagged `dot`, `graphviz` or `gv`
  is laid out by Graphviz, with each of its layout programs usable as the
  block's language instead — `neato`, `circo`, `fdp`, `sfdp`, `twopi`,
  `osage` and `patchwork` — so the same graph becomes a hierarchy, a
  spring model, a circle or a radial fan by changing one word; and one
  tagged `plantuml` draws the UML family and the good deal more PlantUML
  can draw beside it. All three run **on your own machine** from files
  the extension carries: **Mermaid 11.16.0** (MIT, ~3.4 MB),
  **Graphviz 14.1.1** through **Viz.js 3.24.0** (~1.4 MB; Graphviz is
  EPL-licensed, Viz.js MIT) and **PlantUML 1.2026.4beta4** (GPL, ~7 MB).
  Where each one runs is not an implementation detail but the reason the
  feature exists at all. VS Code's Markdown preview runs under
  `script-src 'nonce-…'` and nothing else, which forbids WebAssembly —
  and Graphviz is WebAssembly, so in the preview it would silently
  degrade to its own source text. The usual workaround is to ask the
  reader to set that workspace's Markdown security to allow all content,
  which downgrades the editor's own sandbox for every document in the
  folder to draw one graph, and that is not a trade this app is willing
  to ask for. So Graphviz is laid out in the extension host, where
  WebAssembly is ordinary Node, and arrives in the page as finished
  vector drawing. Mermaid and PlantUML go the other way and run in the
  preview, because both measure real text to place a label and a headless
  browser measures nothing: asked to lay out off-screen, Mermaid answers
  with a 30 998-pixel-wide drawing containing no text at all. Both are
  plain JavaScript, so the nonce policy admits them, and neither is
  loaded unless the document in front of you actually contains a block of
  that kind — a document with no diagrams loads no engine at all, which
  is what keeps 10 MB of engines off a preview of a README. A diagram
  whose source does not draw — a syntax error, a truncated paste — keeps
  its source visible in place of the drawing rather than leaving a hole
  in the page.
- **Syntax highlighting.** A fenced code block that names its language —
  ` ```ts `, ` ```rust `, ` ```python ` and the like — reads with its
  keywords, comments and strings set apart. The theme is md's own rather
  than a borrowed one: keywords take the warm accent, comments the muted
  ink in italic, strings a quieter shade of the ink, and everything else
  stays plain — three calm tones on the same paper as the prose, in the
  same Courier face, rather than a bright editor palette that would fight
  the page. It draws **on your own machine** from `highlight.min.js` (the
  "common"-languages build of **highlight.js 11.11.1**, ~124 KB,
  BSD-3-Clause) and covers the forty-odd languages that build carries; a
  fence whose language it does not know, or a fence with no language at
  all, is left as plain code rather than guessed at. Like KaTeX it runs
  in the extension host, so the colouring is in the markup before the
  preview ever sees it and shows in the preview, in an exported HTML page
  and in a PDF. An exported EPUB keeps its code plain, exactly as it does
  on the phone and on the Mac: that format is built from the document
  before any colouring is applied, and matching them is what keeps the
  four apps' e-books one file rather than four.
- **CSV and TSV blocks draw as tables.** A table of figures usually
  begins life in a spreadsheet, and turning it into Markdown's pipes and
  dashes by hand is the sort of work nobody wants to do twice. Paste the
  data as it comes instead — into a fenced block tagged `csv`, or `tsv`
  for the tab-separated text a spreadsheet puts on the clipboard — and it
  is drawn as an ordinary table in the preview and in every export, while
  the source stays the data it always was. That is the point of it: when
  next month's numbers arrive, the block is replaced wholesale rather
  than edited cell by cell. The first row is the header. Quoting works
  the way a spreadsheet writes it — a field wrapped in quotes may hold a
  comma or even a line break, a doubled quote inside such a field is one
  literal quote, and a quote that opens nothing, the inch mark in
  `5" pipe`, is simply a character. A column whose values are all numbers
  is lined up on the right so the decimal points sit under one another; a
  single piece of text in the column and it stays left-aligned, as text
  should be. This is a fenced block and nothing more — md neither opens
  nor saves `.csv` files.
- **YAML and TOML front matter.** A file written for a blog, a site
  generator or a notes app almost always opens with a block of metadata —
  title, author, date — fenced off above the text, and a Markdown
  renderer that has not been told about it shows that opening `---` as a
  horizontal rule and the metadata under it as stray prose, so the file
  looks broken the moment it is opened. Both conventions are understood
  here — YAML between `---` lines, closed by `---` or `...`, and TOML
  between `+++` lines — and the block is recognised as metadata and
  hidden, so the page begins at the first heading in the preview and in
  every export alike. The block stays in the file untouched, so whatever
  else you hand the file to still finds it. Three guards keep the feature
  from eating your writing, and all three are needed because a YAML
  opener is spelled exactly like a thematic break: the fence must close,
  the line after the opener must not be blank, and at least one line
  inside must read as a `key: value` pair. So `---`, three bullets and
  `---` stay a rule, a list and a rule; a document that merely opens with
  a horizontal rule keeps its rule; and a `---` further down the page is
  the thematic break it always was.
- **Footnotes.** An aside that would interrupt a sentence can be sent to
  the foot of the page instead, in the spelling GitHub and Pandoc already
  use: mark the spot with `[^id]` and write the note itself on a line of
  its own as `[^id]: the note`, wrapped over as many lines as it needs
  and placed wherever in the file suits you, since it never renders where
  it is written. The notes are gathered under a rule at the foot of the
  rendered page — in the preview, in an exported HTML page, in a PDF and
  in an EPUB alike — and numbered in the order a reader meets the
  references rather than the order the notes happen to be written in, so
  moving a note around the file changes nothing on the page. Each
  reference becomes a small numbered link down to its note, and each
  cited note ends in an arrow back to where it was first cited. Two
  kindnesses are deliberate: a reference with no note behind it stays
  exactly the text you typed rather than becoming a link that leads
  nowhere, and a note you wrote but never cited is still printed, after
  the cited ones — nothing you wrote is dropped in silence.
- **PlantUML and Graphviz files preview as the diagram they describe.** A
  `.puml`, `.plantuml`, `.iuml` or `.pu` file, and a `.gv` or `.dot` one,
  opens as its own language with syntax colouring and a *Preview Diagram*
  button in the editor title bar, and renders as the diagram while the
  source stays fully editable. The apps deliberately leave `.dot`
  unclaimed, because macOS already declares that extension a Word
  template and a document should not open in the wrong app; a language
  association inside VS Code is not a system-wide file type, so here the
  reason does not apply and the extension is claimed. A file that is
  Markdown remains Markdown: the diagram languages are recognised by
  their own grammar — `@startuml`, or DOT's `[strict] graph|digraph`
  header — not by a hopeful prefix match, so prose beginning "graph
  theory is a branch of…" is prose.
- **Export as HTML.** *Export as HTML…* saves the rendered document to a
  location you choose as **one self-contained `.html` file**: a single
  file that opens anywhere — a browser, a phone, a machine that has never
  heard of md — with nothing beside it. No engines, no folder of assets,
  and no engine left in the page to run. What is saved is the finished
  page rather than the recipe for one: every Mermaid, Graphviz and
  PlantUML diagram has already been drawn and travels as a drawing, and
  every formula has already been typeset and travels as real text, so a
  reader can copy a formula out of the page and it stays sharp at any
  zoom. A document with formulas carries the typesetting fonts it needs
  inside the file, and those fonts are most of what it weighs; a document
  without formulas carries none of them and is a few kilobytes.
  "Self-contained" means engine- and font-self-contained, not
  asset-self-contained: an image you linked yourself is written out as
  the link you wrote rather than fetched and embedded, which is the same
  gap the preview has and is a deliberate one — the export never reaches
  the network on your behalf.
- **Export as PDF.** *Export as PDF…* writes the same rendered page as
  real pages, at A4, A5, US Letter or US Legal, or one of the
  print-on-demand trim sizes a paperback is actually printed at — 6 × 9″,
  5 × 8″ and 5.5 × 8.5″ — chosen with `md.export.pageSize`. The page's
  margins scale with the paper, so a 6 × 9 page is not left wearing the
  wide margins A4 was cut for, and there are no headers, no footers and
  no page numbers, because the document is the page. This is the one
  export that is **not** byte-identical with the apps, and it cannot be:
  the phone and the Mac paginate through WebKit and this port cannot,
  and American Typewriter does not exist away from Apple, so even the
  glyphs differ. Same content, same page sizes, same margins, a different
  rasterizer — said here rather than discovered later.
- **Export as EPUB.** *Export as EPUB…* packages the document as a
  standard EPUB 3 e-book, laid out with the document's own headings as
  its table of contents — the same outline, in the same order — so every
  section is somewhere a reader can jump to. The title is taken from the
  front matter's `title:` field when there is one and from the file's own
  name when there is not. Every formula and every diagram is drawn once
  and travels as a picture, so the file displays in any reader. The
  identifier is derived from the title rather than invented afresh, so
  exporting the same document twice updates the copy a reader already has
  instead of settling in beside it as a second publication — **md's four
  apps derive it identically**, so the same document exported from the
  editor and from the phone is one book rather than two. Rename the
  document and it becomes a new one, which is what a new name ought to
  mean.
- **Export as LaTeX.** *Export as LaTeX…* writes the document as a `.tex`
  file, and this is the one export where your mathematics comes out as
  mathematics: everything else turns a formula into a picture or into the
  markup a browser typesets, while a `.tex` file hands it back as the
  `$…$` you typed, ready to paste into a paper and go on editing. The
  rest of the document travels with it — headings become `\section` and
  its deeper relatives, emphasis becomes `\textbf` and `\emph`, lists
  become `itemize` and `enumerate` nested the way you nested them, a
  table (and a `csv` or `tsv` block alike) becomes a `longtable` that
  keeps your column alignment and repeats its header row across pages,
  code becomes `verbatim`, a quote becomes `quote`, and front matter
  becomes the title block. The preamble asks for exactly the packages the
  document actually uses and no others, down to the T2A font encoding
  only when the text has Cyrillic in it, which the default encoding would
  otherwise drop without a word. Two limits are worth stating. LaTeX has
  no renderer for a Mermaid, Graphviz or PlantUML diagram, so a diagram's
  source travels as a `verbatim` block under a comment naming its
  language — kept for you to decide what to do with rather than quietly
  dropped. And whatever the preamble asks for is what your TeX
  installation has to be able to find.
- **Export a diagram as SVG.** *Export Diagram as SVG…* lists the
  document's diagrams — one row apiece, named by engine and a line of the
  source so two of them are told apart — and saves the one you choose as
  a standalone `.svg`: a real vector drawing that opens in any browser or
  vector editor and stays sharp at any size. Only the three drawing
  engines are offered, since those are the blocks that render to vector;
  math is not among them, because KaTeX sets a formula as HTML and text
  rather than as a drawing, so a formula has no vector to hand over and
  is left off the list. A diagram whose source never drew has no vector
  to export, so md says as much rather than leaving an empty file behind.
- **Nothing is sent anywhere.** The extension has no account, no server
  and no telemetry of its own: it registers no reporting channel and
  sends nothing, and every engine it uses is a file inside the extension
  rather than something fetched on first use. Visual Studio Code collects
  its own telemetry about the editor, governed by your own
  `telemetry.telemetryLevel` setting — that is Microsoft's collection
  under Microsoft's terms, and this extension adds nothing to it. The one
  thing that still touches the network is an image **your own document
  names** by URL, which the preview loads exactly as a browser would,
  from the host your document names, and only for documents that contain
  such a link. The whole policy is in [PRIVACY.md](PRIVACY.md), versioned
  beside the code so the history is auditable.
