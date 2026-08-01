//
//  html.ts
//  md.vscode — the self-contained single-file `.html` export.
//
//  A port of `DocumentExport.exportHTML` and `WebRenderer.selfContainedHTML`.
//  The pipeline, unchanged from the apps:
//
//    1. render the document with `export: true, dark: false`
//    2. un-swap the page-break rule (see below)
//    3. load it in the offscreen render surface and wait for the handshake
//    4. capture `document.documentElement.outerHTML` with every `<script>` and
//       every stylesheet `<link>` removed
//    5. inject KaTeX's stylesheet, fonts inlined, iff the *input* had math
//    6. add Mermaid's licence notice iff the *captured page* has a diagram
//
//  Steps 1, 2, 5 and 6 live here; steps 3 and 4 are `renderHost.ts`, because
//  they are the only part that needs a browser.
//
//  WHAT "SELF-CONTAINED" MEANS, EXACTLY
//  ------------------------------------
//  Engine- and font-self-contained, **not** asset-self-contained. By capture
//  time Mermaid, Graphviz and PlantUML have become inline `<svg>` and KaTeX has
//  expanded into markup, so nothing is left to run and every engine reference
//  is stripped. The author's own images are a different matter: the renderer
//  emits `<img src="photo.png">` unchanged, so a local relative image stays
//  relative and breaks in the exported file. That is a known, accepted gap
//  shared with the preview on all three platforms — closing it here alone would
//  be a parity break, not a bug fix.
//

import * as fs from 'node:fs';
import * as path from 'node:path';

import { renderDocument } from '../render/html';
import { richRoot } from '../engines/paths';

/**
 * The page-break rule as the export stylesheet writes it, and the screen rule
 * it is swapped back to.
 *
 * In export CSS `\newpage` becomes `break-after: page`, which is invisible on
 * screen and only means anything on paper — so a reader scrolling the exported
 * file would see the author's page breaks silently vanish. The screen styling
 * keeps them as the dashed rule they look like in the preview.
 *
 * The replacement hard-codes the light-theme border colour rather than
 * recomputing it from the palette, exactly as the Swift does. It is also
 * applied to **every** occurrence, unlike the PDF margin rewrite which touches
 * only the first — that asymmetry is deliberate on both sides and predates this
 * port.
 */
const EXPORT_PAGEBREAK_RULE = '.md-pagebreak { height: 0; margin: 0; break-after: page; }';
const SCREEN_PAGEBREAK_RULE =
  '.md-pagebreak { border-top: 2px dashed rgba(43,38,32,0.16); margin: 1.6em 0; }';

/**
 * The document to load into the render surface for an HTML export.
 *
 * `dark: false, export: true` unconditionally: `renderDocument` collapses
 * `dark && !export` before it computes the palette, so the colour scheme the UI
 * threads through every export call site on the apps can never take effect.
 * Wiring the VS Code theme in here would diverge from all three of them.
 */
export function exportDocumentHTML(source: string, title: string): string {
  return renderDocument(source, { title, dark: false, export: true }).replaceAll(
    EXPORT_PAGEBREAK_RULE,
    SCREEN_PAGEBREAK_RULE,
  );
}

/**
 * The finished file, given the captured page and the HTML that produced it.
 *
 * **Step 5's gate reads the *input* HTML, not the captured page.** The
 * `<link rel="stylesheet" href="rich/katex.min.css">` tag is only emitted when
 * the document has math, and by capture time it has already been stripped from
 * the DOM — so testing the captured page would never match and no exported
 * document would ever carry KaTeX's stylesheet. Do not "simplify" this.
 *
 * **Step 6's gate reads the *captured page*** and is deliberately
 * double-barrelled: `<pre class="mermaid"` survives as the container, and
 * `class="mermaid"` also catches the markup Mermaid generates for itself.
 */
export function selfContainedHTML(capturedPage: string, inputHTML: string): string {
  let page = capturedPage;

  // Only a document with math pulled KaTeX in, and only that document needs to
  // carry the stylesheet and its fonts.
  if (inputHTML.includes('rich/katex.min.css')) {
    const css = embeddedKatexCSS();
    if (css !== null) {
      // A **function** replacement, because the inserted text is not ours: a
      // string replacement has `$&`, `` $` ``, `$'` and `$1` interpreted inside
      // it, and a stylesheet that happened to contain one of those pairs would
      // be silently mangled — with 300 KB of base64 in it, nobody would ever
      // find the corruption.
      page = page.replace('</head>', () => `<style>${css}</style>\n${KATEX_NOTICE}\n</head>`);
    }
  }
  // Mermaid's own stylesheet travels inside every diagram it drew.
  if (page.includes('<pre class="mermaid"') || page.includes('class="mermaid"')) {
    page = page.replace('</head>', () => `${MERMAID_NOTICE}\n</head>`);
  }
  return page;
}

/**
 * KaTeX's stylesheet with its web fonts embedded, or null if the vendored copy
 * is missing.
 *
 * A formula is not glyphs alone: `katex.min.css` positions every piece of it,
 * so an export that dropped the stylesheet would show the right characters in
 * the wrong places. It cannot be linked either, since the file has to stand on
 * its own — so it is inlined, and each `@font-face` keeps only its **woff2**
 * source, rewritten as a `data:` URI. woff2 is the one format every browser
 * that matters reads; carrying the `woff` and `ttf` alternates as well would
 * quadruple the payload for nothing, and leaving them as relative paths would
 * leave dead links in the file. Twenty faces, about 300 KB before encoding.
 */
export function embeddedKatexCSS(): string | null {
  let root: string;
  try {
    root = richRoot();
  } catch {
    return null;
  }

  let css: string;
  try {
    css = fs.readFileSync(path.join(root, 'katex.min.css'), 'utf8');
  } catch {
    return null;
  }

  // The `[^;}]*` tail is what eats the sibling `url(fonts/X.woff) format("woff"),
  // url(fonts/X.ttf) format("truetype")` alternates: they are dead links once
  // the file leaves this machine, so the whole `src` run is replaced rather
  // than only the woff2 term.
  const pattern = /src:url\(fonts\/([A-Za-z0-9_-]+)\.woff2\) format\("woff2"\)[^;}]*/g;
  const matches = [...css.matchAll(pattern)];

  // Back-to-front, so each replacement leaves the earlier ranges valid.
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    const face = match[1];
    const start = match.index ?? 0;
    let data: Buffer;
    try {
      data = fs.readFileSync(path.join(root, 'fonts', `${face}.woff2`));
    } catch {
      // Leave the rule alone rather than emit a broken `src`: a rule pointing
      // at a relative path that is merely absent still degrades to a fallback
      // face, whereas a truncated `data:` URI is a parse error that takes the
      // surrounding rules with it.
      continue;
    }
    const src = `src:url(data:font/woff2;base64,${data.toString('base64')}) format("woff2")`;
    css = css.slice(0, start) + src + css.slice(start + match[0].length);
  }
  return css;
}

/**
 * The notice that has to travel with an exported page carrying KaTeX's
 * stylesheet and fonts.
 *
 * The code is MIT; the faces are **not** — they are SIL Open Font License 1.1
 * with reserved names, and the OFL requires its notice to accompany the fonts
 * wherever they go. Exporting is the first thing md does that hands those files
 * to somebody else, so this is the first place the obligation actually bites.
 * It is legal text: copy it, never reword it.
 */
export const KATEX_NOTICE = [
  '<!--',
  '  Mathematics rendered with KaTeX (https://katex.org) — MIT License,',
  '  Copyright (c) 2013-2020 Khan Academy and other contributors.',
  '  The embedded KaTeX_* fonts are licensed under the SIL Open Font',
  '  License 1.1 (https://scripts.sil.org/OFL); "KaTeX" is a Reserved Font',
  '  Name. The fonts are embedded unmodified.',
  '-->',
].join('\n');

/**
 * Mermaid writes its own theme CSS into every diagram it draws, so an exported
 * page carrying a Mermaid diagram is carrying several kilobytes of Mermaid's
 * *source text* — not just generated geometry, the way Graphviz and PlantUML
 * output is. MIT asks for its notice to go with that, so it does.
 */
export const MERMAID_NOTICE = [
  '<!--',
  '  Diagrams rendered with Mermaid (https://mermaid.js.org) — MIT License,',
  '  Copyright (c) 2014-2022 Knut Sveidqvist. The diagram SVG carries',
  "  Mermaid's own theme stylesheet.",
  '-->',
].join('\n');
