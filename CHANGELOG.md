# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

There is no build number to auto-increment here — no `agvtool bump` as on
iOS and macOS, no Gradle `versionCode` finalizer as on Android — and the
Marketplace requires a three-part version, so the family's two-part `1.5`
is published as `1.5.0`. A republish that changes no behaviour is not
tracked here, which is why `1.2.1` — a relisting that corrected the
Marketplace description and replaced the screenshots — has no section of
its own.

This extension began at its own 1.0 rather than as a continuation of the
apps' 1.3 line, and this file has said since that release that it would
join the family's number at the next family one. It has. The section
below is **1.5**, the number the iPhone, iPad, Mac, Windows and Android
apps all carry from this date, and it follows 1.2 directly: nothing is
missing between the two, because the number is the family's rather than
this extension's own count, and this extension has simply stepped into
it.

## [1.5] — 2026-09-23

### Added

- **The exports are on the right-click menu, and a selection of files
  exports as one job.** Until now every export lived in the Command
  Palette alone, which is the one place where "the document" is never in
  doubt. There is now an **md: Export** submenu — HTML, PDF, EPUB, LaTeX
  — on a Markdown file in the Explorer, in the editor and on the editor
  tab, with *Export Diagram as SVG…* and *Preview Diagram* beside it on
  a `.puml` or `.gv` file. Contributing them meant fixing the
  registration first: every command was registered as
  `registerCommand(id, () => runOnDocument(id, run))`, an arrow taking
  no arguments where VS Code passes two — the resource that was clicked
  and, in the Explorer, the whole selection. Dropping them was harmless
  while the palette was the only way in and would have been a silent
  wrong answer the moment a menu row existed: right-click `notes.md`,
  choose *Export as EPUB*, and get an EPUB of whichever document
  happened to be focused, under that other document's name, with no
  error anywhere. The arguments are read now, and the rule that reads
  them is a function with tests rather than a shape agreement between a
  callback and its caller. A resolved file is opened with
  `workspace.openTextDocument` and never shown, which also settles what
  an author would ask next: exporting a file that is open exports the
  **unsaved** text, because that is what is on the screen. Selecting
  several Markdown files and choosing HTML, EPUB or LaTeX now exports
  all of them: one question — which folder — then one cancellable
  progress notification counting through the files, and one summary
  naming what failed and what was skipped for not being Markdown (a
  `when` clause speaks only for the file that was clicked, so a mixed
  selection arrives with folders and images in it). **What counts as
  Markdown there is the editor's answer, not a list kept here**: the
  menu row is contributed under `resourceLangId == markdown`, and the
  editor's own language claims more spellings than the family's ten and
  lengthens its list with every release — `.ronn` and `.workbook` among
  them, and the Cursor rule files by name rather than by extension at
  all. Filtering a selection by extension threw those out with a message
  the editor disagrees with, while the same files exported perfectly one
  at a time; the family's ten are now a cheap yes, asked first so that a
  folder of `.md` need not be opened file by file, and anything they
  cannot settle is opened and asked its `languageId`. A uri that will
  not open at all — a folder, most often — is a skip rather than a
  failure. Each file is named after its own source, `notes.md` to
  `notes.html`, and a name already taken in the destination takes a `-2`
  instead of overwriting — two `README.md` from two folders land side by
  side, compared case-insensitively because the file systems this runs
  on are. **PDF is the one export with no batch**: it writes no bytes of
  its own, it hands a print-ready page to the host's print dialogue one
  document at a time, so it is hidden for a multi-selection
  (`!listMultiSelection`) and said so in the README rather than failing
  halfway through a folder.
- **A quiet note where md's Markdown is not GitHub's.** The README has
  said it since 1.0 — "a deliberate subset, not a CommonMark engine" —
  and a reader only ever found out which parts by looking at the preview
  and wondering. There is now an **Information**-level diagnostic, and
  it is Information in the one place a `Diagnostic` is built, with no
  setting to raise it: these constructs are perfectly good Markdown,
  they will simply look different here, and a warning squiggle under
  valid prose is how a lint gets switched off within the hour. Five
  rules, each saying what md does instead: **raw HTML** (escaped, so a
  tag shows as the characters you typed), **reference links** (neither
  half exists — the `[text][label]` and the `[label]: url` line both
  print as written), **four-space indented code** (a paragraph here, so
  the indentation and the monospaced type are lost), **a table written
  straight under a paragraph** (md's paragraph loop carries no table
  lookahead, so the rows are swallowed into it) and **a footnote nothing
  cites** (md prints the note at the foot of the document anyway, with
  no number in the text and no link back to it, where a CommonMark
  engine swallows the line as a link reference definition and prints
  nothing at all). Two carry a quick fix and only two, because fencing a
  block and inserting a blank line are rearrangements with no judgement
  in them while *which URL a reference link meant* is a question only
  the author can answer. The whole thing rests on one rule: **no second
  parser.** Block structure comes from `parseWithLines()`, "would this
  really be a table?" is answered by handing the lines back to
  `parse()`, and "did the author write this inside backticks?" is
  answered by running `inline()` over the text with the candidate
  replaced by a private-use sentinel and looking at whether it came out
  inside a `<code>` or a maths span — the same passes that render the
  preview, so the lint cannot come to disagree with what is on screen.
  That is what keeps `1 < 2` out of it, and `` `<b>` ``, and
  `arr[0][1]`, and an indented paragraph under a list item, and a
  footnote defined at the foot of the file; a document the parser drops
  wholesale — a comment on its own line — is not linted at all. A
  reference *use* is reported only when the document actually defines
  that label, because without the definition GitHub prints it as written
  too and there is no difference to report. A footnote *reference* is
  not reported at all, for exactly that reason: `[^id]` with nothing
  behind it is literal text in md, in markdown-it and on GitHub alike,
  so there is nothing to tell anyone — and the candidate is shaped like
  a negated character class, so one sentence of prose about `[^a-z]`
  would have carried a permanent underline and an offer to define a
  footnote called `a-z`. Sixty tests in `test/dialect.test.ts` hold it
  there, including the whole of the shipped example set asserted to be
  clean — except *09-Writer Tools*, which demonstrates an uncited note
  in so many words, and where the lint finds exactly that one and
  nothing else: nothing for the citation with no note beside it, and
  nothing for the `[^id]` written inside backticks four lines above.
  `md.lint.dialect` turns it off; `md.lint.rules` turns off one rule at
  a time.
- **Every spelling of a Markdown file opens as one.** The family's list
  of Markdown extensions is `.md`, `.markdown`, `.mdown`, `.markdn`,
  `.mdtext`, `.mdtxt`, `.mkd`, `.mkdn`, `.mdwn` and `.mkdown`, and VS
  Code's own `markdown` language already knows all but the last two — so
  in the oldest editor this extension admits, 1.95, a `.mkdn` or
  `.mkdown` file opened as plain text, with no preview, no *md* commands
  and no highlighting. Both are now contributed to the **built-in**
  language id rather than to a language of ours: a second `languages`
  entry that names `markdown` and carries nothing but the two
  extensions, which VS Code merges into the language it already has.
  Nothing else is touched, on purpose — no alias, no language
  configuration, no grammar — because any of those would shadow the
  built-in's, and a `.md` file would stop being VS Code's Markdown to
  become ours. Newer editors have lengthened their own list (1.138
  carries `.mkdn`), and a repeated extension is harmless there. A test
  now pins the three languages' extension lists and the activation
  events beside them, so this decision and the `.dot` one recorded in
  the README — claimed here, left alone by the apps — cannot drift from
  their reasons.
- **Ready for Open VSX, and inert until there is a token.** The
  Marketplace is Microsoft's and its terms allow only Microsoft's
  products to install from it, so Cursor, Windsurf, VSCodium, Gitpod and
  Theia read [open-vsx.org](https://open-vsx.org) instead, where
  `nettrash` holds nothing. **This release publishes nothing there and
  changes nothing for anyone installing from the Marketplace**: what
  landed is the plumbing, ready for the day a token exists. `ovsx` joins
  the toolchain, pinned to the **0.10** line because its 1.x releases
  want Node 22 and this repository pins Node 20, the major the oldest
  supported extension host runs; it adds 27 packages and no new audit
  finding. `npm run publish:vsix` sends **one built `.vsix`, by path**,
  to both registries — `vsce publish --packagePath` and
  `ovsx publish --packagePath`, never the bare verbs, for the same
  reason `vscode:prepublish` refuses a direct `vsce package`: either
  tool, handed no file, packages the working tree and ships the
  developer README as the listing page. One script for both, so two
  registries cannot come to hold two different builds of one version
  number — and **every check is made before the first upload**, which is
  the other half of that promise. `ovsx verify-pat` answers whether the
  namespace has been claimed and whether the token may publish into it,
  both one-time steps nobody remembers skipping; asked between the two
  uploads, as it was, a first tagged release would have put the build on
  the Marketplace, failed with "Unknown namespace: nettrash", left Open
  VSX empty, and burned a version number `vsce` will never accept again.
  It is the last thing that happens before either upload now, and a dry
  run makes it too. CI gains a `publish` job that runs only on a
  `v*.*.*` tag, only after the tests, only if the tag matches
  `package.json`, and only if **both** `VSCE_PAT` and `OVSX_PAT` exist —
  read into a step's environment and turned into a flag, because
  `secrets` is not a context GitHub offers a job-level `if:` and the
  obvious spelling silently runs the job every time. Until the secrets
  are there it prints one notice and stops. The one-time steps only
  nettrash can take — an Eclipse account, the publisher agreement, a
  token, the namespace itself, the two repository secrets — are written
  out in `marketplace/README.md`, with the warning that Open VSX renders
  the README and CHANGELOG out of the `.vsix` just as the Marketplace
  does, so the first listing has to be read on the live page.

### Fixed

- **The two diagram off switches now switch something off.**
  `md.diagrams.mermaid` and `md.diagrams.plantuml` are read in the
  extension host; the engines they name run in the built-in preview's
  page, which belongs to another extension and which the host can reach
  only through the HTML it returns. The wanted engines were written into
  that HTML from the first version — `data-md-render="mermaid plantuml"`
  on the wrapper — and nothing ever read them back, so the client
  rendered every diagram it could find and both settings did precisely
  nothing in the preview while the README promised they did. The client
  reads the attribute now, through one small pure module both ends share
  (`src/preview/engines.ts`), so a rename cannot leave the writer and the
  reader looking at different spellings. The check happens before the
  engine is fetched rather than after: a document full of PlantUML with
  the setting off now costs the preview nothing, where it used to cost
  7.4 MB. The four host-side switches — `md.math.enabled`,
  `md.diagrams.graphviz`, `md.diagrams.plot` and `md.highlight.enabled` —
  were honoured all along, and are now pinned by tests in both directions
  so that none of them can quietly join the other two.
- **Which PlantUML diagrams the built-in preview can draw, settled by
  measurement rather than by comment.** Three files in this repository
  told two stories: one said PlantUML's Graphviz-backed layouts call a
  global `Viz` that cannot exist under the preview's security policy, two
  said the engine carries its own Smetana layout and never reaches for
  Viz. Both were plausible from the bytes, and the second was wrong. Run
  in a real browser under the preview's real policy — which is what
  `test/plantuml-csp.test.ts` now does on every test run — sequence
  diagrams, the modern `start` / `if` / `stop` activity syntax, mind
  maps, Gantt charts, WBS, JSON, YAML, salt and timing all draw in about
  a fifth of a second and never touch `Viz`; class, state, component,
  object, use-case, deployment and ER diagrams, and the legacy `(*) -->`
  activity syntax, read `Viz` exactly once and stop there, so the block
  shows its source after the twenty-second wait. **That is a limit, not
  a bug on its way out**: the built-in preview's Content Security Policy
  is VS Code's own, it forbids the WebAssembly Graphviz is, and nothing
  in this extension can lift it — `!pragma layout smetana` does not
  change it either, and neither do its three other spellings, the
  Smetana classes being in the engine with nothing that reaches them, so
  no pragma is prepended to anything and exported bytes are untouched.
  Those diagrams are not lost, only misplaced: the diagram panel
  (*md: Preview Diagram*) and every export render in a webview of md's
  own, which allows WebAssembly and draws all of them. The README and
  the Marketplace page now say so, diagram kind by diagram kind, instead
  of promising the preview can draw everything.

### Not in this release, and not planned

- **The editor features the apps gain in this same family release belong
  to VS Code here, and are better in its hands.** *Find and replace* is
  the editor's own and has been since long before this extension:
  regular expressions, whole-word matching, multi-file search and a
  preview of every hit, which is rather more than a find bar of ours
  would ever have offered. **Hardware-keyboard chords** are the same
  story from the other end: every command this extension contributes is
  already in *Keyboard Shortcuts*, bindable to whatever the reader
  prefers, and a chord hard-coded here would be a chord taken away from
  them. **Smart typing** — Return continuing a list or a table row, the
  first letter of a sentence capitalized — would mean intercepting
  keystrokes in an editor this extension does not own and does not want
  to own; it is a Markdown editor's job, and in VS Code the Markdown
  editor is VS Code. And the **webview recovery** the apps needed has no
  counterpart here, because the preview is not ours: the built-in
  Markdown preview is VS Code's webview, and its lifecycle, its crashes
  and its reloads are the editor's to handle.

## [1.2] — 2026-08-29

### Added

- **Charts, from a fence.** A ` ```plot ` block is a chart. Write
  `sin(x)` and you get the curve; `x: -10..10` sets the window, `y: auto`
  fits it to what the function actually does, and `title:`, `xlabel:`,
  `ylabel:`, `grid:`, `axes:`, `legend:`, `width:`, `height:` and
  `samples:` set the rest. A block may hold as many series as you like —
  `envelope = exp(-abs(x)/5)` names one for the legend — alongside
  parametric curves, `(cos(t), sin(t)) for t in 0..2*pi`, and plain
  measured data, `points: 0,0 1,2 2,1`. The expression language is the
  one the plotter on [nettrash.me](https://nettrash.me) already speaks —
  `pi` and `e`, the trigonometric, hyperbolic, logarithmic and rounding
  functions, `atan2`, `pow` and `hypot`, comparisons and the Boolean
  operators — so a figure worked out in the browser draws here too, and
  in the four cases named below it draws where the browser draws
  nothing.
  **It is written by hand and it is not an engine.** There is no plotting
  library, nothing vendored, nothing to fetch and nothing to wait for:
  the renderer is a pure function in the same layer as the Markdown
  renderer itself, and a fence becomes an `<svg>` element in the page
  before it ever reaches a browser. Nothing was added to `media/rich`,
  the extension's asset payload is unchanged, and a document of nothing
  but charts loads no engine at all — not KaTeX, not Mermaid, not
  Graphviz, not PlantUML, not highlight.js. That is also why a chart
  needs no special handling anywhere downstream: it is already a drawing
  in the *self-contained HTML*, in *print* and *PDF*, in *EPUB* — as real
  vector, not a photograph of one — and it is offered by *Export Diagram
  as SVG…* like any other figure. The one export that cannot take it is
  LaTeX, which reads no SVG without a conversion step a `.tex` file
  cannot carry, so a plot travels there as its own source under a
  comment, exactly as a Mermaid diagram does.
  The ink is the page's ink: the grid, the axes, the labels and the frame
  are drawn in `currentColor`, so one figure is right in a light preview,
  in a dark preview, in a printed page and in a file saved out of the
  document, and only the curves themselves carry a colour. A block that
  cannot be read keeps its source visible under one `plot: …` line — an
  unknown function, a range that does not increase, a missing
  parenthesis — because a chart with a typo in it should say what is
  wrong, and never be a hole in the page.
  Four things it does that the site's own plotter does not, all four
  deliberate: `floor`, `ceil` and `round` draw (on the site they bind to
  nothing and every sample fails, so the chart comes out empty);
  a comparison is a number, so `(x > 0) * sqrt(x)` is a half-domain curve
  rather than a blank figure; `^` groups to the right, so `2^3^2` is 512;
  and every value is a double, so `5/2` is 2.5 rather than 2. Two more
  fixes are in the axes, where the site's own figures show the bug: a
  tick label is rounded rather than truncated, so a tick at −4 no longer
  reads `-3` in the middle of an axis, and tick positions are computed by
  index rather than accumulated, so the tick at the origin reads `0`
  rather than `-5.6e-17`. The whole of it is pinned against 403 vectors
  generated by running the site's own Rust, including the number
  formatting — which is the part that silently differs on every platform,
  and is therefore written by hand and rounded ties-to-even on the exact
  binary value in all four ports.
- **`md.diagrams.plot`**, alongside the four engine switches, turns
  charts back into the source you wrote. It is the odd one out and says
  so in its own description: there is no engine behind it, so switching
  it off loads nothing less — it is there because a reader should be able
  to see the numbers behind a figure.

### Fixed

- **An EPUB that contains a drawing now says so.** EPUB 3 requires the
  reserved manifest property `svg` on any content document that holds an
  `<svg>` element, and no book this family has ever produced held one —
  every rich block was rasterised on its way in — so the property was
  never written and never missed. A chart is inline vector, so the
  package document now carries `properties="svg"` on a content document
  that has one, which is what keeps EPUBCheck quiet (OPF-014) and the
  book valid.

### Not in this release, and not planned

- **Per-file view-mode memory**, which the iPhone, iPad, Mac and Android
  apps gain in this same family release, ships nothing here, because
  there is nothing here to remember: those apps own their whole window
  and must decide whether a document opens in the editor, the preview or
  a split, and VS Code has owned that decision since before this
  extension existed — *Open Preview* and *Open Preview to the Side* place
  the preview, **View: Toggle Editor Group Layout** rearranges the
  columns, and the editor restores the groups you left open. An extension
  that second-guessed any of it would be moving a reader's panes without
  being asked.

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
