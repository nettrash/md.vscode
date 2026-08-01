//
//  html.ts
//  md.vscode — the block serializer and the document skeleton.
//
//  A port of `md/md/MarkdownHTML.swift` (byte-identical to md.macOS's copy).
//  It turns the parsed block model into the self-contained, themed document
//  that every surface in this family renders: the live preview, print, PDF,
//  the HTML export and — snapshotted before any script runs — EPUB.
//
//  THE PARITY CONTRACT
//  -------------------
//  With `opts.engines` absent, `renderDocument` produces byte-identical output
//  to `MarkdownHTML.document(_:title:dark:export:)`. That is what the golden
//  corpus asserts, and it is the whole reason this file does not use a Markdown
//  library: the renderer is a hand-written, test-pinned *subset* of CommonMark
//  with deliberate divergences (no raw HTML, no reference links, no autolinks,
//  no indented code, flat lists, a currency guard on inline math, a table that
//  cannot interrupt a paragraph). A CommonMark engine produces different bytes
//  on the first real document.
//
//  Two VS Code-only affordances are layered on top, both strictly additive and
//  both off unless asked for:
//
//    * `opts.engines` — host-side KaTeX, highlight.js and Graphviz pre-fill the
//      *same containers* this file already emits. A hook returning `null` must
//      leave the container exactly as the no-hook path wrote it. Containers are
//      never replaced, only filled, which is what keeps the engine gate below
//      honest.
//    * `opts.sourceLines` — `class="code-line" data-line="N"` on top-level
//      blocks, which is how VS Code's built-in preview syncs scrolling.
//
//  Neither may leak into the default output. Byte-diff tests run with both off.
//

import type { Block, ColumnAlignment, ListItem, PlacedBlock } from './types';
import { parse, parseWithLines, slug } from './parser';
import { escapeHTML, inline } from './inline';
import { stylesheet } from './css-text';
import { trimWS, trimWSNL } from './text';

// MARK: - Options

export interface EngineHooks {
  /** KaTeX. Return HTML for the formula, or null to leave md's container untouched. */
  math?(tex: string, displayMode: boolean): string | null;
  /** highlight.js. Return highlighted HTML for the code, or null to leave it plain. */
  highlight?(code: string, language: string): string | null;
  /** Graphviz. Return an `<svg>…</svg>` string, or null to leave the source visible. */
  graphviz?(source: string, engine: string): string | null;
}

export interface RenderOptions {
  title: string;
  dark: boolean;
  /** Style for paper/PDF rather than the live preview. Forces the light palette. */
  export?: boolean;
  /** Emit `class="code-line" data-line="N"` on top-level blocks. VS Code preview only. */
  sourceLines?: boolean;
  /** When omitted, every container is emitted exactly as MarkdownHTML.swift emits it. */
  engines?: EngineHooks;
  /** Override the `<head>` asset URLs (VS Code rewrites these to webview URIs). No trailing slash. */
  assetBase?: string;
}

export interface EngineNeeds {
  math: boolean;
  mermaid: boolean;
  plantuml: boolean;
  graphviz: boolean;
  highlight: boolean;
}

/**
 * Fenced-block info strings that select the bundled Graphviz engine, mapped to
 * the Graphviz layout program that lays the graph out.
 *
 * ```dot is the everyday one; the rest name a layout directly, which is how
 * Graphviz itself is invoked (`neato -Tsvg`, `circo -Tsvg`, …). Ten keys, eight
 * distinct engines. Every value must be one of `Viz.engines` — an unknown name
 * makes the render throw and the block falls back to its source text.
 *
 * The *value* is what reaches `data-engine`, never the author's info word, so
 * the attribute needs no escaping. Never widen this table with anything the
 * author controls.
 *
 * `DocumentExport.DiagramSVG.classify` and the LaTeX writer read the same
 * table; they must stay in lockstep with it.
 */
export const graphvizEngines: Readonly<Record<string, string>> = Object.freeze({
  dot: 'dot',
  graphviz: 'dot',
  gv: 'dot',
  neato: 'neato',
  circo: 'circo',
  fdp: 'fdp',
  sfdp: 'sfdp',
  twopi: 'twopi',
  osage: 'osage',
  patchwork: 'patchwork',
});

// MARK: - The document

/**
 * A full HTML document for `source`, themed light or dark.
 *
 * `opts.title` becomes the document `<title>` (and the print / PDF job name).
 * It is always the caller's string: nothing is sniffed from an H1 or from front
 * matter, which is parsed but never rendered and never feeds the title.
 *
 * `opts.export` styles the document for paper rather than the live preview: a
 * smaller, print-typical body size (everything else is em-based and scales with
 * it), code blocks wrap long lines — paper cannot scroll, so an overflowing
 * line would be clipped at the block's edge — and the page is plain white in
 * the light palette regardless of `dark`, because the tinted paper and
 * cream-on-carbon ink are screen themes, not something to fix into a printout.
 */
export function renderDocument(source: string, opts: RenderOptions): string {
  // The first line of the Swift, and it shadows the parameter for the rest of
  // the function: `export` forces light. The shadowed value feeds both the CSS
  // palette *and* the `data-md-dark` body attribute, so an exported document
  // always says `data-md-dark="0"` and Mermaid renders with its light theme.
  const exportMode = opts.export === true;
  const dark = opts.dark && !exportMode;

  const { html: body, needs } = renderBody(source, opts);

  // Rich renderers load from bundled assets under `rich/` — no network, ever.
  // Each heavy engine is pulled in only when the document uses it, so a plain
  // document stays light (PlantUML alone is 7 MB). `md-init.js` itself is tiny
  // and always runs; when it finishes it flags `data-md-render-complete`, which
  // every capture path waits on.
  //
  // The host must load this with a base URL whose origin serves the asset
  // directory, so that the ES-module import inside `md-init.js` resolves — a
  // WKURLSchemeHandler on Apple, WebViewAssetLoader on Android, a webview URI
  // here. Never a `<base href>`: it would turn `href="#slug"` into a
  // cross-document navigation and break the one link kind the host allows.
  const base = opts.assetBase ?? 'rich';

  // `<head>` ORDER IS LOAD-BEARING; see each note below.
  let head = '';
  if (needs.math) {
    // mhchem (KaTeX's chemistry extension: `\ce{…}`, `\pu{…}`) rides the same
    // `needs.math` gate — `\ce{}` only ever appears inside the math delimiters
    // that produce `.md-mathi` / `.md-mathd`, so it needs no signal of its own.
    // It must load right after KaTeX and share its `defer`: deferred classic
    // scripts run in document order, so KaTeX defines the global `katex`, then
    // mhchem registers its macros onto it, before md-init.js (a deferred
    // module, last) calls katex.render(). Both are the same KaTeX 0.17.0 build
    // — mhchem silently no-ops against a mismatched KaTeX, so the two files
    // must always be replaced together.
    //
    // Appended with NO leading newline. That is what glues the first line
    // flush against `</style>` below.
    head += [
      `<link rel="stylesheet" href="${base}/katex.min.css">`,
      `<script defer src="${base}/katex.min.js"></script>`,
      `<script defer src="${base}/mhchem.min.js"></script>`,
    ].join('\n');
  }
  if (needs.mermaid) head += `\n<script src="${base}/mermaid.min.js"></script>`;
  // Viz.js is Graphviz, and a ```dot block is that engine addressed directly.
  //
  // The `needs.plantuml` half of this condition is inherited from md, whose
  // comment explains it as "PlantUML needs Viz for its own Graphviz-backed
  // layouts (class, activity, …)". **That explanation does not survive
  // testing.** Loading plantuml.js in Node with no `Viz` global in scope at
  // all still renders sequence, class and activity diagrams correctly — this
  // TeaVM build carries PlantUML's own pure-Java *Smetana* layout engine
  // (14 references to it in the bundle) and never reaches for Viz.
  //
  // The include is kept anyway, deliberately, on two grounds: it is what the
  // three shipping apps emit, and this function's no-hook output is
  // byte-compared against `MarkdownHTML.document`, so dropping it would fail
  // the parity gate for a saving that only shows up in a standalone HTML
  // export that also contains PlantUML. Revisit it in all four ports together
  // or not at all.
  //
  // PlantUML itself is never included here: the preview `import()`s it lazily
  // when a `.plantuml` element exists.
  if (needs.plantuml || needs.graphviz) head += `\n<script src="${base}/viz-global.js"></script>`;
  // highlight.js shares no global with KaTeX, so it only has to have defined
  // `hljs` before the deferred md-init.js module runs: `defer` puts it in the
  // same run-after-parse, in-document-order queue as that module, and it sits
  // ahead of it in the document. (Android omits the `defer` here; Swift's bytes
  // are canonical for this port.)
  if (needs.highlight) head += `\n<script defer src="${base}/highlight.min.js"></script>`;

  // The skeleton, assembled by joining rather than as one template literal so
  // that the file's own indentation cannot leak into the output. It matters
  // that `head` is glued **directly onto `</style>`** with no separator: a math
  // document reads `…</style><link rel="stylesheet" …>` on one line, and an
  // empty head yields `</style>\n</head>`.
  //
  // The returned string deliberately has **no trailing newline** — it ends
  // `</html>`. An empty source leaves a blank line between `<body …>` and the
  // script tag; that too is part of the bytes.
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHTML(opts.title)}</title>`,
    `<style>${css(dark, exportMode)}</style>${head}`,
    '</head>',
    // Read by md-init.js as `document.body.dataset.mdDark === '1'` and used for
    // Mermaid's theme and PlantUML's `{ dark }` flag. The theme is chosen by
    // this attribute, never by CSS.
    `<body data-md-dark="${dark ? '1' : '0'}">`,
    body,
    `<script type="module" src="${base}/md-init.js"></script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * The document body, and which engines it turned out to need.
 *
 * Three mutually exclusive paths: a raw PlantUML file, a raw Graphviz file, or
 * Markdown.
 */
export function renderBody(source: string, opts: RenderOptions): { html: string; needs: EngineNeeds } {
  // A raw diagram document — an opened `.puml` or `.gv`: bare diagram source
  // with no fence. Render the whole file as one diagram rather than parsing it
  // as Markdown, which would only show the `@startuml…` / `digraph…` text.
  //
  // Both escape the entire file *including its trailing newline*, so the
  // closing tag lands on its own line. The `needs` flags are hard-coded rather
  // than sniffed, because there is no Markdown here and therefore no math,
  // Mermaid or highlightable code possible.
  if (isRawPlantUML(source)) {
    // md-init.js turns the `.plantuml` container into an SVG offline; on
    // failure it restores the source, so an invalid diagram still shows its
    // text. PlantUML is not a host-side engine — it needs a real canvas's
    // `measureText` — so there is no hook to consult here.
    return {
      html: `<div class="plantuml">${escapeHTML(source)}</div>`,
      needs: { math: false, mermaid: false, plantuml: true, graphviz: false, highlight: false },
    };
  }
  if (isRawGraphviz(source)) {
    const svg = opts.engines?.graphviz?.(source, 'dot') ?? null;
    return {
      html: `<div class="graphviz" data-engine="dot">${svg ?? escapeHTML(source)}</div>`,
      needs: { math: false, mermaid: false, plantuml: false, graphviz: true, highlight: false },
    };
  }

  // `parse` and `parseWithLines` walk identically; the second merely records
  // where each top-level block started. Asking for lines we will not use would
  // be wasted work, so the cheap call is the default.
  const placed: PlacedBlock[] = opts.sourceLines
    ? parseWithLines(source)
    : parse(source).map((block) => ({ block, line: 0 }));

  // Top-level headings carry a GitHub-style anchor id, so `[…](#slug)` links
  // navigate and the table of contents can scroll the preview. The slugs come
  // from the same `slug()` the outline uses, walked in the same document order,
  // so the two always agree — if they ever disagreed about whether a line is a
  // heading, every later anchor would drift and a contents link would scroll to
  // nothing.
  //
  // A heading nested inside a block quote goes through `renderBlock` instead
  // and gets no id, and does not consume a slug counter.
  const slugs = new Map<string, number>();
  const plain: string[] = [];
  const decorated: string[] = [];
  for (const entry of placed) {
    const block = entry.block;
    const html =
      block.kind === 'heading'
        ? `<h${block.level} id="${slug(block.text, slugs)}">${inline(block.text)}</h${block.level}>`
        : renderBlock(block, opts);
    plain.push(html);
    if (opts.sourceLines) decorated.push(withSourceLine(html, entry.line));
  }

  const definitions: { id: string; text: string }[] = [];
  for (const entry of placed) {
    if (entry.block.kind === 'footnoteDefinition') {
      definitions.push({ id: entry.block.id, text: entry.block.text });
    }
  }

  // Blocks are joined with a single "\n". Blocks that render to "" — notes,
  // front matter, footnote definitions — still take part in the join, so they
  // leave blank lines in the output. That is observable and must be reproduced.
  //
  // Footnotes are a whole-document affair: the references are numbered by where
  // the reader meets them, and the notes are gathered at the foot of the page
  // rather than left where they were written. Both need the finished body.
  const bodyPlain = withFootnotes(plain.join('\n'), definitions);

  // THE ENGINE GATE RUNS ON THE UNDECORATED MARKUP, ALWAYS.
  //
  // Every engine is needed iff the render actually emitted its container.
  // Keying off the produced markup — rather than scanning the block list for
  // fence languages — is what makes this correct for a diagram nested inside a
  // block quote: `renderBlock` recurses into quoted blocks, so a scan of the
  // top-level blocks alone would emit the container and then never include the
  // engine, leaving the diagram stuck as its own source text. It is also what
  // has always kept KaTeX out of prose with stray dollar signs in it:
  // `inline()` emits a math span only for a real formula, never for "$5".
  //
  // The probes are exact strings, and `class="mermaid"` becomes
  // `class="mermaid code-line"` under `sourceLines` — which would silently stop
  // matching and ship a Mermaid document with no Mermaid. Hence the gate reads
  // `bodyPlain`, which is also exactly what MarkdownHTML.swift would have
  // produced.
  const needs = engineNeeds(bodyPlain);

  let html = opts.sourceLines ? withFootnotes(decorated.join('\n'), definitions) : bodyPlain;

  // Inline math is produced by `inline()`, which has no access to the hooks, so
  // KaTeX is applied here as a post-pass over the finished body — the same
  // scan-the-emitted-containers technique `DocumentExport.richElementRanges`
  // uses, and safe for the same reason: the content of a math container is
  // fully escaped text, so the next matching close tag really is its own.
  const math = opts.engines?.math;
  if (math !== undefined) html = fillMath(html, math);

  return { html, needs };
}

/**
 * One block to markup.
 *
 * Headings arrive here only when nested (inside a block quote) — the top-level
 * form, with its `id`, is emitted by `renderBody`, which owns the slug counter.
 */
export function renderBlock(block: Block, opts: RenderOptions): string {
  switch (block.kind) {
    case 'heading':
      return `<h${block.level}>${inline(block.text)}</h${block.level}>`;

    case 'paragraph':
      // The only caller that asks for soft breaks. The conversion happens
      // inside `inline`, before protected math and code spans are restored, so
      // a multi-line display-math span keeps its own internal newlines instead
      // of getting `<br>`s injected.
      return `<p>${inline(block.text, true)}</p>`;

    case 'list':
      return renderList(block.items, block.ordered);

    case 'codeBlock':
      return renderCodeBlock(block.language, block.code, opts);

    case 'quote':
      return `<blockquote>\n${block.blocks.map((b) => renderBlock(b, opts)).join('\n')}\n</blockquote>`;

    case 'table':
      return renderTable(block.header, block.alignments, block.rows);

    case 'thematicBreak':
      return '<hr>';

    case 'pageBreak':
      // A subtle dashed rule in the preview; in export and print the CSS
      // collapses it to an invisible marker where a new page starts.
      return '<div class="md-pagebreak"></div>';

    case 'note':
      // Private author notes never reach the rendered document — they live in
      // the editor and the notes panel only.
      return '';

    case 'frontMatter':
      // Metadata about the document, not part of it. It is parsed so the fields
      // are available (and so the opening `---` stops being read as a
      // horizontal rule), but nothing is drawn — which is what every tool that
      // understands front matter does.
      return '';

    case 'footnoteDefinition':
      // Nothing is drawn where the definition was written; `renderBody`
      // collects them all and prints them at the foot of the page.
      return '';
  }
}

/**
 * A fenced block's info string selects a rich renderer. **Order matters — the
 * first match wins**, and the code languages are deliberately last so that
 * `mermaid`, `dot`, `csv` and `tex` can never be highlighted as source.
 */
function renderCodeBlock(language: string | null, code: string, opts: RenderOptions): string {
  // The parser hands over the first space-delimited word of the trimmed info
  // string, or null when it was empty. Lower-cased here with the
  // locale-independent `toLowerCase` — never `toLocaleLowerCase`, which would
  // make a Turkish locale spell `LATEX` differently.
  const lang = (language ?? '').toLowerCase();

  if (lang === 'mermaid') {
    // Mermaid renders in the preview, not the host: headless it needs real text
    // metrics and produces a 30 998px-wide broken layout without them.
    return `<pre class="mermaid">${escapeHTML(code)}</pre>`;
  }
  if (lang === 'plantuml' || lang === 'puml' || lang === 'plant-uml') {
    return `<div class="plantuml">${escapeHTML(code)}</div>`;
  }
  const engine = graphvizEngines[lang];
  if (engine !== undefined) {
    // Escaping is what makes DOT's HTML-like labels safe: `n [label=<<b>hi</b>>]`
    // emits `&lt;&lt;b&gt;hi&lt;/b&gt;&gt;`, or the label markup would be parsed
    // as page markup. md-init.js reads `el.textContent`, which decodes it back.
    const svg = opts.engines?.graphviz?.(code, engine) ?? null;
    return `<div class="graphviz" data-engine="${engine}">${svg ?? escapeHTML(code)}</div>`;
  }
  if (lang === 'csv' || lang === 'tsv') {
    // Data pasted straight out of a spreadsheet, drawn as a table while the
    // source stays the data — so it can be re-pasted and re-sorted without
    // hand-editing a grid of pipes.
    return renderDelimited(code, lang === 'tsv' ? '\t' : ',');
  }
  if (lang === 'math' || lang === 'latex' || lang === 'tex') {
    // A whole-block display formula. Note the shape: a fence is a `<div>`,
    // while `$$…$$` inside a paragraph is a `<span>`. Both are display mode and
    // both are found by `.md-mathd`.
    return `<div class="md-mathd">${escapeHTML(code)}</div>`;
  }
  if (lang.length > 0) {
    // A real code language. The diagram / math / data languages were handled
    // above, so anything left with a non-empty hint is code: tag it
    // `language-<lang>` for highlight.js. An unknown hint the "common" build
    // does not carry simply is not highlighted — the block stays plain, never
    // breaks.
    //
    // The class must *begin* with `language-`, because md-init.js selects with
    // `code[class^="language-"]`, an attribute-starts-with match. That is also
    // why `withSourceLine` appends its class rather than prepending it.
    const highlighted = opts.engines?.highlight?.(code, lang) ?? null;
    return `<pre><code class="language-${escapeHTML(lang)}">${highlighted ?? escapeHTML(code)}</code></pre>`;
  }
  return `<pre><code>${escapeHTML(code)}</code></pre>`;
}

/**
 * The flat, level-tagged item list with explicit markers and indentation —
 * mirroring the on-screen preview rather than reconstructing nested
 * `<ul>`/`<ol>` from a model that is not a tree.
 *
 * There is no `<ul>` or `<ol>` anywhere in this renderer. The parser's model is
 * flat with a `level` integer; rebuilding a tree here would be a second,
 * drifting interpretation of it.
 */
function renderList(items: ListItem[], ordered: boolean): string {
  let rows = '';
  for (const item of items) {
    // `toFixed(2)`, never a locale-aware formatter: a locale with a decimal
    // comma would write `padding-left:1,60em` and the rule would be dropped.
    const indent = (item.level * 1.6).toFixed(2);
    let marker: string;
    if (item.task !== null) {
      // Task beats ordered: a `- [x]` inside an ordered run still shows a box.
      marker = item.task ? '&#9745;' : '&#9744;'; // ☑ / ☐
    } else if (ordered && item.ordinal !== null) {
      marker = `${item.ordinal}.`;
    } else {
      // An ordered run whose item carries no ordinal falls back to a bullet.
      marker = '&bull;';
    }
    // Entities, not literal characters. The EPUB builder rewrites `&bull;` to
    // `&#8226;` because named entities are undefined in XML, which is another
    // reason to keep these spellings exact.
    const done = item.task === true ? ' done' : '';
    rows +=
      `<div class="md-item${done}" style="padding-left:${indent}em">` +
      `<span class="md-marker">${marker}</span>` +
      `<span>${inline(item.text)}</span></div>`;
  }
  // Rows are concatenated with no separator and no newlines: the whole list is
  // one line of HTML.
  return `<div class="md-list">${rows}</div>`;
}

/**
 * A ```csv / ```tsv block as a table: first row the header, the rest the body.
 * A block that parses to nothing stays a code block, so nothing the author
 * wrote disappears — and the fallback is the *bare* `<pre><code>` form, which
 * is what keeps it from tripping the highlight gate.
 */
function renderDelimited(code: string, separator: string): string {
  const table = delimitedTable(code, separator);
  if (table === null) return `<pre><code>${escapeHTML(code)}</code></pre>`;
  return renderTable(table.header, table.alignments, table.rows);
}

/**
 * A table. Alignment is an inline style per cell — `text-align:left`, no space
 * after the colon — and every cell, header and body alike, goes through
 * `inline()`, so code spans, math, links and emphasis all work inside one.
 * `<tbody>` is emitted even when there are no rows.
 */
function renderTable(header: string[], alignments: ColumnAlignment[], rows: string[][]): string {
  // A column past the end of the alignment array falls back to `left`. The
  // parser guarantees only that the delimiter row and the header row agree.
  const align = (i: number): string => {
    const alignment = alignments[i];
    if (alignment === undefined) return 'left';
    switch (alignment) {
      case 'leading':
        return 'left';
      case 'center':
        return 'center';
      case 'trailing':
        return 'right';
    }
  };
  let html = '<table><thead><tr>';
  for (let i = 0; i < header.length; i++) {
    html += `<th style="text-align:${align(i)}">${inline(header[i])}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (let i = 0; i < row.length; i++) {
      html += `<td style="text-align:${align(i)}">${inline(row[i])}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

// MARK: - Delimited data (shared with the LaTeX writer)

/**
 * The table a ```csv / ```tsv block describes — header row, inferred
 * alignments, body rows — or null when the block parses to nothing.
 *
 * Split out from `renderDelimited` because the LaTeX export owes the same
 * spreadsheet the same table: the number rule is subtle enough (see
 * `isDecimalNumber`) that a second copy of it would drift, and a column that is
 * right-aligned in the PDF and left-aligned in the `.tex` is exactly the kind of
 * difference nobody would look for. **One copy, by design.**
 */
export function delimitedTable(
  code: string,
  separator: string,
): { header: string[]; alignments: ColumnAlignment[]; rows: string[][] } | null {
  const rows = parseDelimited(code, separator);
  const header = rows[0];
  if (header === undefined || header.length === 0) return null;
  const body = rows.slice(1);

  // A column whose every filled cell is a number is right-aligned, the way a
  // spreadsheet would show it — decimal points then line up, which is most of
  // what makes a table of figures readable. Alignment is inferred from the body
  // only: the header text never votes. Empty cells are ignored rather than
  // disqualifying.
  let columns = header.length;
  for (const row of body) columns = Math.max(columns, row.length);
  const alignments: ColumnAlignment[] = [];
  for (let column = 0; column < columns; column++) {
    const cells: string[] = [];
    for (const row of body) {
      if (column >= row.length) continue;
      const cell = trimAsciiSpaceTab(row[column]);
      if (cell.length === 0) continue;
      cells.push(cell);
    }
    alignments.push(cells.length > 0 && cells.every(isDecimalNumber) ? 'trailing' : 'leading');
  }
  return { header, alignments, rows: body };
}

/**
 * Strip only ASCII space and tab, deliberately.
 *
 * Foundation's `.whitespaces` also contains U+200B, which Java's Zs-based trim
 * does not, so the two platforms would align the same spreadsheet differently
 * over an invisible character. `U+200B 1 U+200B` is therefore **not** a number
 * on any platform — the opposite decision from the blank-line rule, on purpose.
 */
function trimAsciiSpaceTab(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === ' ' || s[start] === '\t')) start++;
  while (end > start && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
  return s.slice(start, end);
}

/**
 * Whether `cell` is a plain decimal number — the only thing worth right-aligning
 * in a column of figures.
 *
 * The grammar, spelled out: optional sign, digits with an optional decimal
 * point, optional exponent; at least one digit overall; ASCII digits only; the
 * whole string consumed. So `0 -1 +2 3.5 .5 5. 1e9 -2.5E-3 007` are numbers and
 * `0x10 inf NaN 1,000 ٣ ½ 1e 1.2.3` are not.
 *
 * Deliberately **not** a language's own number parser. Swift's `Double(_:)`
 * accepts hex (`Double("0x10") == 16`) and `inf`/`nan` in any casing, none of
 * which Java's `Double.parseDouble` takes — so a column of `0x10` would be
 * right-aligned on Apple and left-aligned on Android, over a difference in two
 * standard libraries that has nothing to do with what the author wrote.
 * JavaScript is worse again: `Number("")` is 0, `Number(" 1 ")` is 1,
 * `Number("0x10")` is 16 and `Number("Infinity")` is finite enough for
 * `parseFloat`. Hand-writing the scanner is the same rule everywhere, and it is
 * also the honest one — a hex literal is not a figure whose decimal point can
 * line up with anything.
 */
export function isDecimalNumber(cell: string): boolean {
  let i = 0;
  const takeDigits = (): number => {
    let count = 0;
    while (i < cell.length) {
      const code = cell.charCodeAt(i);
      if (code < 0x30 || code > 0x39) break;
      count++;
      i++;
    }
    return count;
  };

  if (cell[i] === '+' || cell[i] === '-') i++;
  let digits = takeDigits();
  if (cell[i] === '.') {
    i++;
    digits += takeDigits();
  }
  if (digits === 0) return false;

  if (cell[i] === 'e' || cell[i] === 'E') {
    i++;
    if (cell[i] === '+' || cell[i] === '-') i++;
    if (takeDigits() === 0) return false;
  }
  return i === cell.length;
}

/**
 * Split delimiter-separated text into rows of fields, per RFC 4180: a field may
 * be quoted, a quoted field may contain the separator and line breaks, and a
 * doubled quote inside one is a literal quote.
 *
 * Line endings are normalised first rather than matched. In Swift that is
 * because a `Character` is a grapheme cluster and CRLF is a single one of them,
 * so a comparison against "\n" silently never fires on a file saved on Windows
 * — which is exactly where spreadsheet exports come from. Here the
 * normalisation is kept because the *output* must be the same, not because
 * JavaScript has the same problem.
 *
 * `separator` is one character (`,` or `\t`).
 *
 * Divergence worth recording: the Swift walks graphemes, so a separator carrying
 * a combining mark is one `Character` that does not equal `,` and the field is
 * not split. This walks UTF-16 code units, like Kotlin, and splits. That is the
 * model this port is required to use — Swift's grapheme comparisons were the
 * bug `ScalarText` exists to fix, and `parseDelimited` is one of the few places
 * the Swift was never routed through it.
 */
export function parseDelimited(text: string, separator: string): string[][] {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < normalized.length) {
    const character = normalized[i];
    if (quoted) {
      if (character === '"') {
        // A doubled quote is one literal quote; a single one ends the run.
        if (i + 1 < normalized.length && normalized[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += character;
      }
      i++;
      continue;
    }
    if (character === '"' && field.length === 0) {
      // A quote only *opens* a quoted field while the field is still empty, so
      // `5" pipe,x` parses as two ordinary fields.
      quoted = true;
    } else if (character === separator) {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += character;
    }
    i++;
  }
  // A file that does not end in a newline still has a last row. Note the test
  // is on both, so a trailing empty field is preserved: `Ann,\n` is two fields.
  if (field.length !== 0 || row.length !== 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// MARK: - Footnotes

/** `inline()`'s placeholder, and the only shape `withFootnotes` recognises. */
const FOOTNOTE_MARKER = /<sup class="md-fnref" data-fn="([A-Za-z0-9_-]+)"><\/sup>/g;

/**
 * Turn the placeholder references `inline()` left in `body` into numbered links,
 * and append the footnotes themselves.
 *
 * Numbering is by order of first *reference*, which is the order a reader meets
 * them — not the order the definitions happen to be written in. Two cases are
 * deliberate rather than incidental:
 *
 * - A reference with **no definition** is not a footnote at all, so it goes back
 *   to being the text the author typed. Linking it to nothing would be worse
 *   than leaving it alone.
 * - A definition that is **never referenced** is still printed, after the
 *   referenced ones. Dropping it would silently discard something the author
 *   wrote; it simply gets no back-link, having nowhere to go back to.
 */
function withFootnotes(body: string, definitions: { id: string; text: string }[]): string {
  // The Swift also bails when the pattern fails to compile. A literal regex in
  // JavaScript cannot, so only the "nothing to do" guard survives.
  const matches = [...body.matchAll(FOOTNOTE_MARKER)];
  if (matches.length === 0 && definitions.length === 0) return body;

  // First definition wins if an id is defined twice, matching how a duplicate
  // link reference behaves.
  const defined = new Map<string, string>();
  for (const definition of definitions) {
    if (!defined.has(definition.id)) defined.set(definition.id, definition.text);
  }

  // Walk the references FORWARD once — the numbering depends on reading order —
  // recording for each its range, its id and its occurrence, so repeated
  // references to one footnote each get a distinct anchor to come back to.
  interface Reference {
    start: number;
    length: number;
    id: string;
    occurrence: number;
  }
  const references: Reference[] = [];
  const occurrences = new Map<string, number>();
  const number = new Map<string, number>();
  const ordered: string[] = [];
  for (const match of matches) {
    const id = match[1];
    const start = match.index;
    if (id === undefined || start === undefined) continue;
    const occurrence = (occurrences.get(id) ?? 0) + 1;
    occurrences.set(id, occurrence);
    references.push({ start, length: match[0].length, id, occurrence });
    if (defined.has(id) && !number.has(id)) {
      number.set(id, ordered.length + 1);
      ordered.push(id);
    }
  }
  // Then every still-unnumbered definition, in definition order, so the
  // unreferenced notes take the trailing numbers.
  for (const definition of definitions) {
    if (number.has(definition.id)) continue;
    number.set(definition.id, ordered.length + 1);
    ordered.push(definition.id);
  }

  // Substitute BACK-TO-FRONT so the earlier ranges stay valid.
  let result = body;
  for (let i = references.length - 1; i >= 0; i--) {
    const reference = references[i];
    const n = number.get(reference.id);
    let replacement: string;
    if (n !== undefined && defined.has(reference.id)) {
      const anchor = reference.occurrence === 1 ? `fnref-${n}` : `fnref-${n}-${reference.occurrence}`;
      replacement = `<sup class="md-fnref" id="${anchor}"><a href="#fn-${n}">${n}</a></sup>`;
    } else {
      replacement = escapeHTML(`[^${reference.id}]`);
    }
    result =
      result.slice(0, reference.start) + replacement + result.slice(reference.start + reference.length);
  }

  if (ordered.length === 0) return result;
  let items = '';
  for (const id of ordered) {
    const n = number.get(id);
    if (n === undefined) continue;
    // A footnote's own text is inline Markdown. Should it contain a further
    // reference, that placeholder has missed the numbering pass above, so it is
    // cleaned back to literal text at the end rather than left as markup the
    // reader would see.
    const text = inline(defined.get(id) ?? '');
    // The back-link always targets the *first* citation, never `fnref-n-2`.
    const back = occurrences.has(id) ? ` <a class="md-fnback" href="#fnref-${n}">&#8617;</a>` : '';
    items += `<li id="fn-${n}">${text}${back}</li>`;
  }
  // A leading newline, on top of the blank lines the definitions already left
  // in the join. Both are part of the bytes. `<hr>` and `<ol>` are plain: the
  // stylesheet scopes them through `.md-footnotes`.
  result += `\n<section class="md-footnotes"><hr><ol>${items}</ol></section>`;
  // Final cleanup: no `data-fn=` may survive into the page. The template is
  // literally `[^$1]` — `escape("[^")` and `escape("]")` change nothing.
  return result.replace(FOOTNOTE_MARKER, '[^$1]');
}

// MARK: - Raw diagram documents

/**
 * Split `source` into lines, whatever it uses to end them.
 *
 * This is the *wider* newline set — `\n \v \f \r \r\n` and U+0085, U+2028,
 * U+2029 — used only here, by the two raw-diagram probes. Foundation's
 * `.newlines` is what the Swift splits on, and a `.gv` file whose lines end in
 * NEL is test-pinned as raw Graphviz.
 *
 * The block parser uses a *narrower* splitter (CR, LF, CRLF only); the two are
 * deliberately different and must not be merged.
 *
 * Whether CRLF counts as one terminator or as two with an empty line between is
 * unobservable here, because both callers skip blank lines.
 */
function newlineSetLines(source: string): string[] {
  return source.split(/\r\n|[\n\v\f\r\u0085\u2028\u2029]/u);
}

/**
 * True when `source` is a raw PlantUML document rather than Markdown — its
 * first non-blank, non-comment line opens a diagram.
 *
 * That is exactly what an opened `.puml` file is: bare diagram source with no
 * ```plantuml fence. Any `@start…` opener counts (`@startuml`, `@startmindmap`,
 * `@startgantt`, `@startjson`, …), matched as a prefix on `@start` rather than
 * as a whole word. PlantUML line comments (`'…`) and blank lines before the
 * opener are skipped, so a commented header does not hide it.
 *
 * The *first* qualifying line decides, which is why `# Title` followed by prose
 * mentioning `@startuml` stays Markdown.
 */
export function isRawPlantUML(source: string): boolean {
  for (const rawLine of newlineSetLines(source)) {
    const line = trimWSNL(rawLine);
    if (line.length === 0 || line.startsWith("'")) continue;
    return line.startsWith('@start');
  }
  return false;
}

/**
 * True when `source` is a raw Graphviz DOT document rather than Markdown — its
 * first non-blank, non-comment line opens a graph (`digraph {`, `graph G {`,
 * `strict digraph {`).
 *
 * Unlike PlantUML's `@start…`, `graph` is an ordinary English word, so the
 * opener is matched against DOT's actual grammar — `[strict] (graph | digraph)
 * [ID] '{'` — and not merely by prefix. A document that begins "graph theory is
 * a branch of…" has three words where DOT allows at most one name and then a
 * brace, so it stays Markdown. The `{` pre-guard is cheap, not sufficient: a
 * KaTeX formula or a JSON sample supplies one in plenty of ordinary documents.
 *
 * DOT's third comment form, a `#` line, is deliberately **not** skipped: every
 * Markdown heading starts with `#`, and skipping those would let the check see
 * straight past the title of an ordinary document to whatever prose follows.
 * The cost is only that a `.gv` file opening with a `#` line renders as
 * Markdown — a C-preprocessor artefact, vanishingly rare in hand-written DOT —
 * and the file's text is still shown either way.
 */
export function isRawGraphviz(source: string): boolean {
  if (!source.includes('{')) return false;
  for (const rawLine of newlineSetLines(source)) {
    const line = trimWSNL(rawLine);
    if (line.length === 0 || line.startsWith('//') || line.startsWith('/*')) continue;
    let head = line.toLowerCase();
    if (head.startsWith('strict ')) head = trimWS(head.slice('strict '.length));
    // `digraph` is tested first: it also has `graph` inside it, and a prefix
    // match on the shorter word would misread the longer one.
    for (const keyword of ['digraph', 'graph']) {
      if (head.startsWith(keyword)) return isGraphHeader(head.slice(keyword.length));
    }
    return false;
  }
  return false;
}

/**
 * Whether what follows a `graph` / `digraph` keyword is the rest of a DOT graph
 * header: an optional name, then the opening brace. The name may be a bare
 * identifier or a quoted string; the brace may be on a later line, in which case
 * nothing at all follows here.
 */
function isGraphHeader(tail: string): boolean {
  let rest = dropSpaceTab(tail);
  // `digraph` / `digraph {` — no name. This short-circuits *before* the
  // separator requirement below, so `digraph{a}` is a graph.
  if (rest.length === 0 || rest.startsWith('{')) return true;
  // A name must have been separated from the keyword by a space or a tab;
  // otherwise this is just a longer word — "digraphs", "graphviz".
  if (tail[0] !== ' ' && tail[0] !== '\t') return false;
  if (rest.startsWith('"')) {
    const close = rest.indexOf('"', 1);
    if (close < 0) return false;
    rest = rest.slice(close + 1);
  } else {
    // Marks are listed explicitly. Swift asks `Character.isLetter` of a whole
    // grapheme cluster, so a combining mark rides along with its base letter;
    // walking code points, U+0301 is `\p{M}` and nothing else. Without it an
    // NFD name — `digraph cafe◌́ {` — would end the run early and the file would
    // render as Markdown on this platform alone.
    const name = /^[\p{L}\p{N}\p{M}_]*/u.exec(rest)?.[0] ?? '';
    if (name.length === 0) return false;
    rest = rest.slice(name.length);
  }
  rest = dropSpaceTab(rest);
  return rest.length === 0 || rest.startsWith('{');
}

/** Drop leading U+0020 / U+0009 only — not the whole whitespace set. */
function dropSpaceTab(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(i);
}

// MARK: - Engine gating

/**
 * The five probes, as exact strings.
 *
 * `graphviz` deliberately matches the **tag prefix without `>`**, because the
 * tag carries a `data-engine` that varies over the engines in the table above;
 * a whole-tag literal would match only one of them and the rest would ship to
 * the reader as raw DOT source.
 *
 * The "escaping prevents false positives" argument holds for the four
 * tag-shaped probes — a code block quoting `<pre class="mermaid">` has its `<`
 * and `"` escaped — but it is **FALSE for math**: `md-mathi` / `md-mathd`
 * contain no `<`, `>` or `"`, so a document whose prose merely mentions the
 * class name does pull in KaTeX and mhchem. Verified, harmless at runtime
 * (KaTeX finds no elements), and a real byte difference. Reproduced on purpose.
 */
function engineNeeds(body: string): EngineNeeds {
  return {
    math: body.includes('md-mathi') || body.includes('md-mathd'),
    mermaid: body.includes('<pre class="mermaid">'),
    plantuml: body.includes('<div class="plantuml">'),
    graphviz: body.includes('<div class="graphviz"'),
    highlight: body.includes('<pre><code class="language-'),
  };
}

// MARK: - Host-side KaTeX (VS Code only)

/**
 * The three shapes a math container takes, as **tag prefixes**: `$…$` and
 * `\(…\)` become `<span class="md-mathi">`, `$$…$$` and `\[…\]` become
 * `<span class="md-mathd">`, and a ```math / ```latex / ```tex fence becomes a
 * `<div class="md-mathd">`.
 *
 * The prefixes stop short of the closing quote of the class attribute — the
 * same trick the Graphviz probe uses — so that they keep matching after
 * `withSourceLine` has appended `code-line` to the class list.
 */
const MATH_CONTAINERS: ReadonlyArray<{ open: string; close: string; display: boolean }> = [
  { open: '<span class="md-mathi', close: '</span>', display: false },
  { open: '<span class="md-mathd', close: '</span>', display: true },
  { open: '<div class="md-mathd', close: '</div>', display: true },
];

/**
 * Pre-fill every math container with KaTeX's output.
 *
 * KaTeX has a pure string API in Node, so the formula is typeset in the
 * extension host and the preview never loads the engine at all. The container
 * is *filled*, never replaced, so the engine gate above still sees a math
 * document and the export paths still find the element they expect.
 *
 * Finding the close tag by simple search is safe for the same reason
 * `DocumentExport.richElementRanges` gives: the content of a math container is
 * fully escaped text, so no `<` survives inside it and the next matching close
 * tag really is the element's own. That reasoning stops holding the moment a
 * container has been filled, which is why this runs exactly once, forward, over
 * a body no earlier pass has filled.
 */
function fillMath(body: string, render: (tex: string, displayMode: boolean) => string | null): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    let openAt = -1;
    let container: (typeof MATH_CONTAINERS)[number] | null = null;
    for (const candidate of MATH_CONTAINERS) {
      const at = body.indexOf(candidate.open, cursor);
      if (at >= 0 && (openAt < 0 || at < openAt)) {
        openAt = at;
        container = candidate;
      }
    }
    if (container === null) break;
    const contentStart = body.indexOf('>', openAt + container.open.length);
    if (contentStart < 0) break;
    const contentEnd = body.indexOf(container.close, contentStart + 1);
    if (contentEnd < 0) break;
    const content = body.slice(contentStart + 1, contentEnd);
    // md-init.js hands KaTeX `el.textContent`, i.e. the *decoded* text, so `<`,
    // `>` and `&` inside a formula reach the engine as themselves. Decoding
    // here keeps the host-side path identical to the in-page one.
    const filled = render(decodeEntities(content), container.display);
    out += body.slice(cursor, contentStart + 1) + (filled ?? content);
    cursor = contentEnd;
  }
  return out + body.slice(cursor);
}

/** The exact inverse of `escapeHTML`, so `&amp;` must be undone **last**. */
function decodeEntities(s: string): string {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

// MARK: - Source-line attributes (VS Code only)

/**
 * Add `class="code-line" data-line="N"` to a top-level block's opening tag.
 *
 * VS Code's built-in preview syncs scrolling off `.code-line[data-line]`
 * elements, which its own markdown-it chain injects with a core ruler
 * (`attrSet("data-line") + attrJoin("class","code-line")`). We emit our own
 * body, so we owe it the same attributes — but only when asked, and never in
 * the bytes the parity tests diff.
 *
 * Two details are taken from VS Code's client, not invented:
 *
 *   * The class is **appended** to any existing one, never prepended. That is
 *     what `attrJoin` does, and here it is also mandatory: md-init.js and
 *     highlight.js select code with `code[class^="language-"]`, so a class list
 *     that stops starting with `language-` stops being highlighted.
 *   * For a fenced code block the attributes go on the `<code>`, not the
 *     `<pre>`. VS Code's `getCodeLineElements` skips every `PRE` and handles the
 *     `CODE` inside it, computing an end line from the newline count so that a
 *     long block scrolls proportionally instead of snapping.
 *
 * VS Code appends its own trailing `<div class="code-line" data-line="N">`
 * end-of-document anchor around whatever we return, so there is none here.
 */
function withSourceLine(html: string, line: number): string {
  // Blocks that render to "" — notes, front matter, footnote definitions —
  // stay empty. They are blank lines in the join and have no tag to decorate.
  if (html.length === 0) return html;

  const anchor = html.startsWith('<pre><code') ? '<pre>'.length : 0;
  const close = html.indexOf('>', anchor);
  if (close < 0) return html;

  // Everything interpolated into one of these opening tags is escaped, so no
  // attribute value can contain a `>` and the first one really does end the tag.
  const tag = html.slice(anchor, close);
  const marker = ' class="';
  const at = tag.indexOf(marker);
  let patched: string;
  if (at >= 0) {
    const valueStart = at + marker.length;
    const valueEnd = tag.indexOf('"', valueStart);
    if (valueEnd < 0) return html;
    const value = tag.slice(valueStart, valueEnd);
    const joined = value.length > 0 ? `${value} code-line` : 'code-line';
    patched = tag.slice(0, valueStart) + joined + tag.slice(valueEnd);
  } else {
    patched = `${tag} class="code-line"`;
  }
  patched += ` data-line="${line}"`;
  return html.slice(0, anchor) + patched + html.slice(close);
}

// MARK: - CSS

/**
 * The stylesheet, in one of its three variants.
 *
 * The `dark && !export` collapse is the **caller's** job and happens in
 * `renderDocument` before this is reached, exactly as the Swift shadows its own
 * parameter — which is why only three stylesheets exist and why an exported
 * document contains no `#241E18` anywhere.
 *
 * The text itself lives in `css-text.ts`; this indirection exists so that the
 * emitter stays free of raw CSS and the sheet can be byte-compared on its own.
 */
export function css(dark: boolean, exportMode: boolean): string {
  return stylesheet(dark, exportMode);
}
