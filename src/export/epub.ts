//
//  epub.ts
//  md.vscode — the EPUB 3 package: container, OPF, navigation and the
//  HTML→XHTML fixer.
//
//  A port of `EpubBuilder` and the single-document packager in
//  `md/md/DocumentExport.swift`. Everything in this file is pure string work —
//  no `vscode`, no webview, no filesystem — which is exactly how the Swift is
//  arranged and for the same reason: the container shape and, above all, the
//  nav cursor are the parts that go wrong silently, so they must be testable
//  without a browser in the loop.
//
//  WHAT IS AND IS NOT BYTE-EXACT
//  -----------------------------
//  The container, the package document, the navigation document, the stylesheet
//  and the derived identifier are byte-identical to the three apps. The only
//  non-deterministic byte in the whole archive is `dcterms:modified`, which is
//  the timestamp of the export itself.
//
//  The rich-block **snapshots** are the one soft part, and they are soft on
//  every platform for a different reason. Apple uses `WKSnapshotConfiguration`;
//  there is no such thing in a VS Code webview, so `index.ts` rasterises each
//  rendered diagram through a canvas instead (see `renderHost.ts`). A formula
//  has no vector at all — KaTeX is HTML and CSS — so a math container has no
//  snapshot here and degrades to its escaped source text, which is the same
//  rule the Swift applies to any capture it could not take: never a hole.
//

import type { MetadataField, OutlineEntry } from '../render/types';
import { renderDocument } from '../render/html';
import { trimWSNL } from '../render/text';
import { archive, assertEpubOrder, EPUB_MIMETYPE, type ZipEntry } from './zip';
import { createHash } from 'node:crypto';

// MARK: - The book model

/**
 * One article of a book, already read from disk — the navigator reads inside
 * the book's folder and hands the strings over; nothing in the EPUB pipeline
 * touches the folder again.
 */
export interface EpubArticle {
  title: string;
  source: string;
}

export interface EpubChapter {
  title: string;
  articles: EpubArticle[];
}

/**
 * The whole book in reading order — root articles first, then the chapters; the
 * same order the PDF compile uses.
 *
 * Declared here rather than in `latex.ts` because this is where the Swift
 * declares it; the LaTeX writer imports the type only, which erases at compile
 * time and leaves the two modules independent at runtime.
 */
export interface EpubBook {
  title: string;
  rootArticles: EpubArticle[];
  chapters: EpubChapter[];
}

/** One rasterised rich block: where it lives in the archive, and its PNG bytes. */
export interface EpubImage {
  /** Archive-relative, e.g. `images/content-01.png`. */
  href: string;
  data: Uint8Array;
}

// MARK: - The pure XML pieces

/** `META-INF/container.xml`, the fixed pointer at the package document. */
export const containerXML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
  '<rootfiles>',
  '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>',
  '</rootfiles>',
  '</container>',
].join('\n');

/**
 * Minimal XML escape for text and attribute content: `&` first, then `<`, `>`,
 * `"`. `'` is deliberately **not** escaped — it is legal in both text and a
 * double-quoted attribute, and the four ports have to agree on this table
 * exactly as they do on the HTML one.
 */
export function escapeXML(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * A stable identifier for a book, derived from its title — an RFC 4122 version
 * 5 (name-based) UUID in the standard URL namespace.
 *
 * EPUB's `dc:identifier` is what a reader uses to decide whether two files are
 * the same publication. A fresh random UUID on every export means every export
 * is a *different* book: re-exporting after fixing a typo stacks up beside the
 * old one in Apple Books instead of replacing it, and a store that expects a
 * stable identifier across releases — KDP, Kobo — cannot accept the file at
 * all. Deriving it from the title makes the same book export to the same
 * identifier every time, on every platform, with nothing to store alongside the
 * folder.
 *
 * Renaming the book does change it, which is the right answer: to a reader's
 * library that is a different publication.
 *
 * SHA-1 because RFC 4122 v5 *is* SHA-1. It is not a security decision and it
 * must not be "upgraded" to SHA-256 — that would change every identifier this
 * family has ever issued and orphan every book already in a reader's library.
 */
export function stableIdentifier(title: string): string {
  // The URL namespace from RFC 4122 Appendix C.
  const namespace = Uint8Array.from([
    0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
  ]);
  const input = Buffer.concat([Buffer.from(namespace), Buffer.from(title, 'utf8')]);
  const bytes = createHash('sha1').update(input).digest().subarray(0, 16);

  const patched = Uint8Array.from(bytes);
  patched[6] = (patched[6] & 0x0f) | 0x50; // version 5
  patched[8] = (patched[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = Buffer.from(patched).toString('hex');
  const groups = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ];
  return 'urn:uuid:' + groups.join('-');
}

/**
 * The EPUB title for a single document: the front-matter `title:` field if the
 * author gave a non-empty one, else the file name.
 *
 * A book takes its title from its folder name; a lone document has no folder,
 * so the file name is the closest thing to a title it has — and the title is
 * also what `stableIdentifier` hashes, so two exports of the same document
 * (same front matter, same file name) reach the same identifier. The key match
 * is case-insensitive because generators write `title:` and `Title:` alike; the
 * first non-empty one wins, matching how a duplicate key is otherwise resolved.
 */
export function documentTitle(frontMatter: readonly MetadataField[] | null, fileName: string): string {
  for (const field of frontMatter ?? []) {
    if (field.key.toLowerCase() !== 'title') continue;
    // The *wider* trim, whitespace and newlines both — this is Foundation's
    // `.whitespacesAndNewlines`, and the parser's own primitive rather than
    // `String.prototype.trim()`, which has a fourth definition of the set again.
    const value = trimWSNL(field.value);
    if (value.length > 0) return value;
  }
  return fileName;
}

/**
 * The package document: metadata, manifest (nav + stylesheet + every unit and
 * image), and the spine in reading order.
 *
 * `dc:language` is hard-coded `en` — the app is English-only, and that is a
 * product fact rather than an oversight. `modified` is **not** escaped: it is
 * an ISO-8601 string by construction, and escaping it would be the kind of
 * defensive edit that quietly changes bytes.
 */
export function contentOPF(args: {
  title: string;
  identifier: string;
  modified: string;
  units: readonly { id: string; href: string }[];
  images: readonly string[];
}): string {
  const manifest = [
    ...args.units.map(
      (unit) => `<item id="${unit.id}" href="${unit.href}" media-type="application/xhtml+xml"/>`,
    ),
    ...args.images.map(
      (href, index) => `<item id="img${index + 1}" href="${href}" media-type="image/png"/>`,
    ),
  ];
  const spine = args.units.map((unit) => `<itemref idref="${unit.id}"/>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">',
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `<dc:identifier id="book-id">${escapeXML(args.identifier)}</dc:identifier>`,
    `<dc:title>${escapeXML(args.title)}</dc:title>`,
    '<dc:language>en</dc:language>',
    `<meta property="dcterms:modified">${args.modified}</meta>`,
    '</metadata>',
    '<manifest>',
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    manifest.join('\n'),
    '</manifest>',
    '<spine>',
    spine.join('\n'),
    '</spine>',
    '</package>',
  ].join('\n');
}

/** One entry of the navigation document. */
export interface NavEntry {
  title: string;
  href: string;
}

/**
 * The EPUB 3 navigation document: root articles first, then each chapter with
 * its articles as a nested list — display names, same reading order as the
 * spine.
 */
export function navXHTML(
  bookTitle: string,
  rootArticles: readonly NavEntry[],
  chapters: readonly (NavEntry & { articles: readonly NavEntry[] })[],
): string {
  const items: string[] = rootArticles.map(
    (article) => `<li><a href="${article.href}">${escapeXML(article.title)}</a></li>`,
  );
  for (const chapter of chapters) {
    const link = `<a href="${chapter.href}">${escapeXML(chapter.title)}</a>`;
    if (chapter.articles.length === 0) {
      items.push(`<li>${link}</li>`);
    } else {
      const nested = chapter.articles
        .map((article) => `<li><a href="${article.href}">${escapeXML(article.title)}</a></li>`)
        .join('\n');
      items.push(`<li>${link}\n<ol>\n${nested}\n</ol>\n</li>`);
    }
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">',
    '<head>',
    `<title>${escapeXML(bookTitle)}</title>`,
    '<link rel="stylesheet" type="text/css" href="style.css"/>',
    '</head>',
    '<body>',
    '<nav epub:type="toc">',
    `<h1>${escapeXML(bookTitle)}</h1>`,
    '<ol>',
    items.join('\n'),
    '</ol>',
    '</nav>',
    '</body>',
    '</html>',
  ].join('\n');
}

/** One content page: the XHTML5 skeleton around an already-fixed body. */
export function page(title: string, body: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    '<head>',
    `<title>${escapeXML(title)}</title>`,
    '<link rel="stylesheet" type="text/css" href="style.css"/>',
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * Post-process the renderer's HTML into well-formed XHTML: drop script tags and
 * engine stylesheet links (readers run no scripts — rich blocks have already
 * been replaced by images), self-close the void elements, and turn
 * XML-undefined named entities into numeric references.
 *
 * XHTML has no HTML DTD, so only the `&amp;` family of names exists. `&bull;`
 * is real — it is the unordered-list marker `MarkdownHTML` emits — and `&nbsp;`
 * is defensive: the current renderer never writes one, but the replacement is
 * free and the day something does emit one is not the day to find out.
 */
export function xhtml(html: string): string {
  let result = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  result = result.replace(/<link[^>]*>/g, '');
  result = result.replace(
    /<(br|hr|img|input|meta|source|col|area|base|embed|track|wbr)((?:[^>])*?)\s*\/?>/g,
    '<$1$2/>',
  );
  result = result.replaceAll('&bull;', '&#8226;');
  result = result.replaceAll('&nbsp;', '&#160;');
  return result;
}

/**
 * The inner HTML of a rendered document's `<body>`.
 *
 * `<body` then the first `>` after it then the **last** `</body>`: the closing
 * tag is searched backwards because a code block quoting `</body>` is escaped
 * to `&lt;/body&gt;` and cannot match, while a document that somehow held two
 * would still yield the whole body rather than half of it. Any of the three
 * missing hands back the input untouched.
 */
export function bodyContent(html: string): string {
  const open = html.indexOf('<body');
  if (open < 0) return html;
  const openEnd = html.indexOf('>', open + '<body'.length);
  if (openEnd < 0) return html;
  const close = html.lastIndexOf('</body>');
  if (close < 0 || close < openEnd) return html;
  return html.slice(openEnd + 1, close);
}

/** The contents of a rendered document's `<style>` block; `""` if either tag is missing. */
export function styleContent(html: string): string {
  const open = html.indexOf('<style>');
  if (open < 0) return '';
  const close = html.indexOf('</style>');
  if (close < 0) return '';
  return html.slice(open + '<style>'.length, close);
}

/**
 * The stylesheet every page links: the export CSS pulled from the shared
 * document renderer (light theme — readers own dark mode), minus paper chrome
 * (page-break rules mean nothing to a reflowing book), plus a cap so the 2×
 * snapshots scale down on narrow screens.
 *
 * A quirk to preserve rather than fix: because this is the export CSS verbatim,
 * every EPUB page carries `body { padding: 48px 56px }` and `font-size: 11pt`.
 * That is intentional-by-omission in all three apps, and changing it here would
 * be a four-repo decision.
 */
export function epubStyle(): string {
  const document = renderDocument('', { title: 'style', dark: false, export: true });
  return (
    styleContent(document) +
    '\n.md-pagebreak { display: none; }\nimg { max-width: 100%; height: auto; }'
  );
}

// MARK: - Rich blocks

export type RichKind = 'formula' | 'diagram';

/** One rich element's span in the body string, as `[start, end)` offsets. */
export interface RichRange {
  start: number;
  end: number;
  kind: RichKind;
}

/**
 * The rich containers exactly as `MarkdownHTML` emits them. Their content is
 * fully escaped text (no `<` survives escaping), so the next matching close tag
 * really is the element's own.
 *
 * The Graphviz opener is deliberately the tag *prefix*, without its `>`:
 * the renderer writes the layout program into the tag
 * (`<div class="graphviz" data-engine="dot">`, `…"neato">`, …), so a whole-tag
 * literal would match only one of the nine engines and the rest would ship to
 * the reader as raw DOT source. Everything after the prefix is still inside the
 * element, so the close-tag search is unaffected.
 */
const RICH_CONTAINERS: readonly { open: string; close: string; kind: RichKind }[] = [
  { open: '<span class="md-mathi">', close: '</span>', kind: 'formula' },
  { open: '<span class="md-mathd">', close: '</span>', kind: 'formula' },
  { open: '<div class="md-mathd">', close: '</div>', kind: 'formula' },
  { open: '<pre class="mermaid">', close: '</pre>', kind: 'diagram' },
  { open: '<div class="plantuml">', close: '</div>', kind: 'diagram' },
  { open: '<div class="graphviz"', close: '</div>', kind: 'diagram' },
];

/**
 * The CSS selector that finds the same elements in the rendered DOM.
 *
 * **This and `RICH_CONTAINERS` must be changed together.** The string scan and
 * the `querySelectorAll` walk the document in the same order and see the same
 * elements, so they pair up index-for-index; a class one of them missed would
 * shift every later snapshot onto the wrong element. The Swift states that
 * invariant three separate times, which is a fair measure of how easily it is
 * broken.
 */
export const RICH_SELECTOR = '.md-mathi, .md-mathd, pre.mermaid, div.plantuml, div.graphviz';

/**
 * Every rich element's span in `html`, in document order — the same order
 * `querySelectorAll` reports in the rendered DOM.
 *
 * From a cursor, find the **earliest** of all six openers, find its close after
 * the opener, emit the span and move the cursor past the close. Non-overlapping
 * by construction.
 */
export function richElementRanges(html: string): RichRange[] {
  const results: RichRange[] = [];
  let cursor = 0;
  for (;;) {
    let earliest: { at: number; open: string; close: string; kind: RichKind } | null = null;
    for (const candidate of RICH_CONTAINERS) {
      const at = html.indexOf(candidate.open, cursor);
      if (at < 0) continue;
      if (earliest === null || at < earliest.at) {
        earliest = { at, open: candidate.open, close: candidate.close, kind: candidate.kind };
      }
    }
    if (earliest === null) break;
    const close = html.indexOf(earliest.close, earliest.at + earliest.open.length);
    if (close < 0) break;
    const end = close + earliest.close.length;
    results.push({ start: earliest.at, end, kind: earliest.kind });
    cursor = end;
  }
  return results;
}

/**
 * Replace the rich elements the capture managed to rasterise with `<img>` tags,
 * back to front.
 *
 * `replacements[i]` is null for an element that could not be captured — a
 * formula, which has no vector at all, or a diagram whose engine failed — and
 * that element keeps its escaped source text. A count mismatch or a zero-sized
 * frame does the same. **Never a hole.**
 *
 * Back to front so that each still-untouched range stays valid, which is the
 * same reason the footnote pass, the KaTeX font rewrite and the TextBundle
 * rewrite all run backwards.
 */
export function applyImageReplacements(
  body: string,
  ranges: readonly RichRange[],
  replacements: readonly (string | null)[],
): string {
  let out = body;
  for (let index = ranges.length - 1; index >= 0; index--) {
    const tag = replacements[index];
    if (tag === null || tag === undefined) continue;
    const range = ranges[index];
    out = out.slice(0, range.start) + tag + out.slice(range.end);
  }
  return out;
}

/**
 * The `<img>` that stands in for one captured rich block.
 *
 * The inline `width` is the element's *layout* width, not the snapshot's: the
 * PNG is taken at 2× for crispness and the `max-width: 100%` in the stylesheet
 * scales it back down on a narrow screen.
 */
export function imageTag(href: string, kind: RichKind, layoutWidth: number): string {
  const alt = kind === 'formula' ? 'formula' : 'diagram';
  return `<img src="${href}" alt="${alt}" style="width:${Math.round(layoutWidth)}px;max-width:100%"/>`;
}

/** The archive href for the n-th (1-based) image of a unit: `images/content-01.png`. */
export function imageHref(unitID: string, ordinal: number): string {
  return `images/${unitID}-${String(ordinal).padStart(2, '0')}.png`;
}

// MARK: - The single-document package

/**
 * The EPUB package entries for a single document, `mimetype` first: container,
 * package document, nav, the shared stylesheet, the one content file (its
 * already-rendered, rich-blocks-snapshotted body), and the snapshot images.
 *
 * Pure — no webview, no I/O — so the container shape and, above all, the nav
 * cursor stay testable. The subtlety a book export carries and a document must
 * *not*: the book path makes unit `u001` a title page and starts its nav cursor
 * past it, so naively reusing that path with the title page removed would leave
 * the nav pointing one file short. Here there is exactly one unit —
 * `content.xhtml` — the spine names it, and every nav entry is a heading anchor
 * *into* it. The nav links use the slug `outline()` assigns each heading, which
 * is the same id the renderer gives that heading, so a nav tap lands on the
 * right section rather than on nothing.
 */
export function documentEpubEntries(args: {
  title: string;
  body: string;
  images: readonly EpubImage[];
  outline: readonly OutlineEntry[];
  modified: string;
}): ZipEntry[] {
  const contentHref = 'content.xhtml';
  const opf = contentOPF({
    title: args.title,
    identifier: stableIdentifier(args.title),
    modified: args.modified,
    units: [{ id: 'content', href: contentHref }],
    images: args.images.map((image) => image.href),
  });

  // The document's outline as the nav TOC: a flat list of heading links, the
  // way the Contents menu itself lists them, each pointing at its anchor inside
  // the single content file. Reuses the book nav builder — root articles, no
  // chapters — so a heading is one `<li><a>` and there is no book-tree nesting
  // to fork.
  //
  // A document with no headings has an empty outline, and a toc `<nav>` whose
  // `<ol>` holds no `<li>` is not valid EPUB 3. So a headingless document gets
  // a single entry — the whole document, under its title, linking to the
  // content file itself — which is both spec-valid and the sensible thing for a
  // reader to see. (Android already guarded this; the two Apple copies did not,
  // so this is a fixed parity bug rather than a port decision.)
  const navEntries: NavEntry[] =
    args.outline.length === 0
      ? [{ title: args.title, href: contentHref }]
      : args.outline.map((entry) => ({ title: entry.text, href: `${contentHref}#${entry.slug}` }));
  const nav = navXHTML(args.title, navEntries, []);

  const utf8 = (s: string): Uint8Array => Buffer.from(s, 'utf8');
  const entries: ZipEntry[] = [
    { name: 'mimetype', data: utf8(EPUB_MIMETYPE) },
    { name: 'META-INF/container.xml', data: utf8(containerXML) },
    { name: 'OEBPS/content.opf', data: utf8(opf) },
    { name: 'OEBPS/nav.xhtml', data: utf8(nav) },
    { name: 'OEBPS/style.css', data: utf8(epubStyle()) },
    { name: `OEBPS/${contentHref}`, data: utf8(page(args.title, args.body)) },
  ];
  for (const image of args.images) {
    entries.push({ name: `OEBPS/${image.href}`, data: image.data });
  }
  return entries;
}

/**
 * The finished `.epub` bytes for a single document.
 *
 * `assertEpubOrder` runs first, so a future edit that reorders or compresses
 * the entry list fails here rather than in the reader that rejects the file.
 */
export function packDocumentEpub(args: {
  title: string;
  body: string;
  images: readonly EpubImage[];
  outline: readonly OutlineEntry[];
  modified: string;
}): Uint8Array {
  const entries = documentEpubEntries(args);
  assertEpubOrder(entries);
  return archive(entries);
}

/**
 * The `dcterms:modified` value: the export's own moment, to whole seconds.
 *
 * `toISOString()` gives milliseconds (`2026-07-31T12:34:56.789Z`), which EPUB 3
 * does not accept in this property — the specification asks for
 * `CCYY-MM-DDThh:mm:ssZ` exactly, and `epubcheck` reports the fractional form
 * as an error. Slicing to 19 characters and appending `Z` is what
 * `ISO8601DateFormatter` produces on Apple.
 */
export function modifiedNow(now: Date = new Date()): string {
  return now.toISOString().slice(0, 19) + 'Z';
}
