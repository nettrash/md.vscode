//
//  css-text.ts
//  md.vscode — md's own stylesheet, byte for byte.
//
//  A port of `private static func css(dark:export:)` in
//  `md/md/MarkdownHTML.swift` (lines 782–899). The Swift is one multiline
//  literal with seven interpolations; this is the same literal with the same
//  seven interpolations, and the same 101 lines in every variant.
//
//  WHERE THIS SHEET IS USED — AND WHERE IT IS NOT
//  ----------------------------------------------
//  It goes into the export and standalone-HTML paths, which md.vscode
//  generates end to end and where byte-parity with the iOS, macOS and Android
//  apps is the product contract: the same Markdown must produce the same file
//  on all four platforms.
//
//  The live VS Code preview does **not** use this sheet. VS Code owns that
//  shell — its own `markdown.css` is already loaded, the body carries VS Code's
//  classes, and our markup sits inside VS Code's `<div class="markdown-body">`
//  — so byte-parity there is structurally impossible and only *visual* parity
//  is on offer. The preview is styled by `media/preview/md-preview.css`, which
//  is a different file on purpose: it may use custom properties, media queries
//  and `--vscode-*` colours, all of which are forbidden here. Never factor a
//  "shared" rule out of the two into one place. That is precisely how the
//  parity sheet acquires a declaration the apps do not have, and the diff
//  against the apps is the only thing that catches it.
//
//  WHY THIS IS A STRING IN TYPESCRIPT AND NOT A `.css` FILE ON DISK
//  ---------------------------------------------------------------
//  Two reasons, both load-bearing. First, the sheet is *computed*: three of its
//  lines and every colour depend on `(dark, export)`, so a static file would
//  have to be three files kept in sync by hand. Second, `src/render/**` is the
//  parity core: it may not import `vscode` and may not touch the filesystem,
//  because it is unit-tested with no editor and no extension root in the loop.
//  A `readFileSync` here would make the core untestable and would break the
//  moment an export ran from a bundled `dist/extension.js`.
//
//  TEMPLATE-LITERAL HAZARDS — read before editing the literal below
//  ---------------------------------------------------------------
//    * The CSS comments contain **backticks** (`pre code`, `bgcolor=transparent`,
//      `fontcolor`, `color`, `\newpage`). Each one is escaped as \` in the
//      source. An unescaped backtick ends the literal and the file stops
//      compiling — which is the good outcome; the bad outcome is escaping one
//      as \\` and shipping a stray backslash into a CSS comment.
//    * `\newpage` is written `\\newpage`. In a template literal a bare `\n` is
//      a newline, so the single backslash the apps emit must be escaped. The
//      Swift has the same problem and solves it the same way (`\\newpage`).
//    * The literal is **flush left**. Swift strips the 8-space indent of a
//      multiline literal against the closing delimiter, so the emitted sheet
//      has no leading indentation except the 4 spaces inside `body { … }` and
//      the 3 spaces continuing each comment. Re-indenting this literal to match
//      the surrounding TypeScript would change every line's bytes.
//    * There is no trailing newline: the Swift literal ends at the last rule,
//      and `document()` supplies the newline that follows `</style>`… except it
//      does not — see the note in the emitter about `</style>` butting straight
//      against the first conditional `<head>` include.
//
//  INVARIANTS THE SHIPPING TESTS PIN (mdTests.swift)
//  -------------------------------------------------
//    * 101 lines in every variant, including the genuinely blank line 32 left
//      behind when the `pre-wrap` interpolation yields "".
//    * Every `/*` has exactly one matching `*/`. `testGraphvizInkRulesSurvive
//      CSSCommentStripping` strips comments the way a parser does and re-asserts
//      the four `.graphviz svg …` rules, because a comment that closes early
//      turns the prose after it into the prelude of the next rule and the parser
//      swallows that rule whole — the diagram then draws in black on carbon
//      paper, while a test that merely greps for the rule text still passes.
//      Never write a bare `*/` inside comment prose, and keep the blank line
//      *inside* the Graphviz comment: it is intentional.
//    * An export contains no `#241E18` anywhere and is `color-scheme: light`.
//    * A preview contains `md-pagebreak` but not `break-after: page`.
//

/**
 * md's stylesheet, exactly as `MarkdownHTML.css(dark:export:)` emits it.
 *
 * @param dark        the screen theme. Killed by `exportMode` — see below.
 * @param exportMode  style for paper (PDF, print, EPUB, HTML export) rather
 *                    than for a screen.
 *
 * There are **three** reachable stylesheets, not four. `document()` in the
 * Swift opens with `let dark = dark && !export`, so an export is always the
 * light palette:
 *
 *   > the page is plain white in the light palette regardless of `dark`: the
 *   > tinted paper and cream-on-carbon ink are screen themes, not something to
 *   > fix into a printout … dark cream-on-carbon is unreadable as cream-on-white.
 *
 * That kill is repeated here rather than trusted to every caller. In Swift
 * `css` is `private`, so it cannot be reached without going through
 * `document()`; here it is exported, and a caller that forgot would produce a
 * fourth, never-shipped variant — dark ink on a white page — which no golden
 * file covers. Applying it in both places is idempotent and costs nothing.
 */
export function stylesheet(dark: boolean, exportMode: boolean): string {
  const isDark = dark && !exportMode;

  // The four colours below come from the app's asset catalog, so they are the
  // same numbers the native UI is drawn with; the three after them exist only
  // in CSS and have no colorset.

  /** `PaperBackground` — "fresh paper" / "carbon paper". Overridden to #FFFFFF on export. */
  const paper = isDark ? '#241E18' : '#F4EFE2';
  /** `PaperInk` — body text, and the ink the Graphviz rules recolour to. */
  const ink = isDark ? '#E7DBC2' : '#2B2620';
  /** `PaperBackgroundSecondary` — the code-block and `<th>` chrome. */
  const secondary = isDark ? '#2F2820' : '#EAE2CF';
  /** `AccentColor` — links, the quote rule, hljs keywords, both footnote links. */
  const accent = isDark ? '#C99A55' : '#9C6B2E';
  /** CSS-only. h6, list markers, done items, comments, the footnote section. */
  const muted = isDark ? '#B3A98E' : '#6B635A';
  /**
   * CSS-only, and literally `ink` at 16 % alpha — #2B2620 is rgb(43,38,32),
   * #E7DBC2 is rgb(231,219,194). Emitted as the literal `rgba(…)` string and
   * never computed: these exact strings are what the tests grep for and what
   * the HTML export's page-break swap substitutes.
   */
  const border = isDark ? 'rgba(231,219,194,0.16)' : 'rgba(43,38,32,0.16)';
  /**
   * CSS-only. A code-string tone for the hand-written highlight.js theme below:
   * a shade drawn from the ink itself — quieter than the plain ink text but
   * warmer and darker than the grey `muted` used for comments, so the two stay
   * distinct without adding a new hue to the warm-paper palette.
   *
   * Android ships different numbers here (#6A5433 / #B79A67). Apple is the
   * reference for this port: it is what two of the three platforms emit.
   */
  const codeString = isDark ? '#CDBF9E' : '#4A4034';

  /**
   * Preview leaves this **empty**, and the empty line stays. The sheet then
   * carries a comment describing a rule that is not there, which looks like a
   * mistake and is not: a byte diff against the apps fails without it.
   */
  const preWrap = exportMode ? 'pre { white-space: pre-wrap; overflow-wrap: anywhere; }' : '';

  /** On screen the author's `\newpage` is a dashed rule; on paper it is a real page boundary. */
  const pageBreak = exportMode
    ? '.md-pagebreak { height: 0; margin: 0; break-after: page; }'
    : `.md-pagebreak { border-top: 2px dashed ${border}; margin: 1.6em 0; }`;

  return `/* Force backgrounds to render in print / PDF so the content chrome
   (code blocks, table headers) survives, rather than being dropped. */
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
:root { color-scheme: ${isDark ? 'dark' : 'light'}; }
/* On paper the page keeps its own single color: the paper tint is a
   screen theme, and a content-height background would end mid-page
   next to the white A4 margins. */
html, body { background: ${exportMode ? '#FFFFFF' : paper}; }
body {
    color: ${ink};
    font-family: "American Typewriter", "Courier New", serif;
    font-size: ${exportMode ? 11 : 13}pt;
    line-height: 1.55;
    margin: 0;
    padding: 48px 56px;
    -webkit-text-size-adjust: 100%;
}
h1, h2, h3, h4, h5, h6 { font-weight: bold; line-height: 1.25; margin: 1.2em 0 0.5em; }
h1 { font-size: 2em; }
h2 { font-size: 1.6em; }
h3 { font-size: 1.3em; }
h4 { font-size: 1.1em; }
h5 { font-size: 1em; }
h6 { font-size: 0.9em; color: ${muted}; }
p { margin: 0 0 0.9em; }
a { color: ${accent}; }
code, pre { font-family: "Courier New", monospace; }
code { background: ${secondary}; padding: 0.1em 0.3em; border-radius: 4px; font-size: 0.92em; }
pre { background: ${secondary}; padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
/* In export, code wraps: paper can't scroll a too-wide block, so a
   long line would otherwise be clipped at the block's edge. */
${preWrap}
pre code { background: none; padding: 0; font-size: 0.92em; }
/* Syntax highlighting (highlight.js). Deliberately NOT a stock hljs
   theme — github / monokai and the rest are bright rainbows that fight
   the warm-paper, American-Typewriter look. Instead three quiet tones
   taken from the page's own palette: language keywords and the
   structural names in the warm accent, comments in muted italic,
   strings a softer shade of the ink; numbers and everything else stay
   plain ink. The code face is still Courier New (inherited from \`pre
   code\`). Applied by md-init.js over the live DOM, so it reaches
   preview, print, PDF and HTML export — not EPUB, which snapshots this
   HTML before any script runs, so its code blocks stay plain. */
.hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-literal,
.hljs-type, .hljs-title, .hljs-section, .hljs-name, .hljs-doctag { color: ${accent}; }
.hljs-comment, .hljs-quote, .hljs-meta { color: ${muted}; font-style: italic; }
.hljs-string, .hljs-regexp, .hljs-symbol, .hljs-char,
.hljs-attr, .hljs-attribute, .hljs-addition { color: ${codeString}; }
.hljs-deletion { color: ${muted}; text-decoration: line-through; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: bold; }
blockquote { margin: 0 0 0.9em; padding-left: 14px; border-left: 4px solid ${accent}; color: ${muted}; }
hr { border: none; border-top: 1px solid ${border}; margin: 1.4em 0; }
/* The author's \`\\newpage\`: a dashed rule on screen; in export / print
   it collapses to an invisible marker where a new page starts (the
   PDF capture splits pages at it, and paginated printing breaks). */
${pageBreak}
table { border-collapse: collapse; margin: 0 0 0.9em; }
th, td { border: 1px solid ${border}; padding: 6px 12px; }
th { background: ${secondary}; }
.md-list { margin: 0 0 0.9em; }
.md-item { display: flex; gap: 0.5em; margin: 0.22em 0; }
.md-marker { color: ${muted}; min-width: 1.5em; text-align: right; }
.md-item.done { color: ${muted}; text-decoration: line-through; }
/* Rich blocks: diagrams and display formulas render as SVG/markup, not
   code — drop the code-block chrome, centre them, allow horizontal
   scroll. Inline math (.md-mathi) flows with the text. */
.mermaid, .plantuml, .graphviz, .plot, .md-mathd {
    background: none; padding: 6px 0; margin: 0 0 0.9em;
    overflow-x: auto; text-align: center;
}
.mermaid svg, .plantuml svg, .graphviz svg, .plot svg { max-width: 100%; height: auto; }
/* Graphviz draws in plain black on a transparent ground (md-init.js
   asks for \`bgcolor=transparent\`). Recolor it to the page's ink here,
   in CSS, rather than passing colors to the engine: these are
   presentation attributes, which any CSS rule outranks, and leaving
   the engine's own attributes alone keeps the layout metrics — and so
   the label positions it computed — exactly as Graphviz intended.

   An author's own \`fontcolor\` / \`color\` survives: Graphviz writes
   those out as attributes too, so each rule is scoped to the value the
   engine emits when nothing was asked for — text with no fill of its
   own, and explicit black. */
.graphviz svg text:not([fill]) { fill: ${ink}; }
.graphviz svg text[fill="black"] { fill: ${ink}; }
.graphviz svg [stroke="black"] { stroke: ${ink}; }
.graphviz svg [fill="black"]:not(text) { fill: ${ink}; }
/* Footnotes. The references are superscript numerals in the running
   text; the notes themselves sit under a rule at the foot of the
   document, a size down, with a back-link to where they were cited. */
.md-fnref a { text-decoration: none; color: ${accent}; }
.md-footnotes { margin-top: 2em; font-size: 0.9em; color: ${muted}; }
.md-footnotes hr { margin: 0 0 0.8em; }
.md-footnotes ol { margin: 0; padding-left: 1.6em; }
.md-footnotes li { margin: 0.35em 0; }
.md-fnback { text-decoration: none; color: ${accent}; }
/* Images render at their natural size, only capped to the page width;
   height follows so the aspect ratio never distorts. */
img { max-width: 100%; height: auto; }
.md-mathd .katex-display { margin: 0; }
.katex-display { overflow-x: auto; overflow-y: hidden; padding: 2px 0; }`;
}
