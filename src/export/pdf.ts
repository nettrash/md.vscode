//
//  pdf.ts
//  md.vscode — the trim-size table, the margin rewrite, and the print path.
//
//  BYTE PARITY WITH THE APPS IS IMPOSSIBLE HERE, AND SAYING SO IS THE POINT
//  -----------------------------------------------------------------------
//  Every other export in this folder is required to produce the same bytes as
//  iOS, macOS and Android. This one cannot, and no amount of care would change
//  that:
//
//    * Apple paginates with WebKit (`UIPrintPageRenderer` pointed at a PDF
//      context). VS Code is Chromium. The two disagree about widow and orphan
//      handling, about where a line may be broken, and about how PDF objects
//      are serialized — the same document is a different file.
//    * **American Typewriter does not exist off Apple platforms.** The body font
//      stack falls through to Courier New, so even the *glyphs* differ. A
//      pixel-comparison would fail on the first word of the first paragraph.
//    * There is no print API in VS Code and no way to read bytes back out of a
//      webview's print pipeline, so md.vscode cannot write the file at all; the
//      user chooses "Save as PDF" in the host's own dialogue and names the
//      destination there.
//
//  What *must* match, and does, are the inputs — because those are what make
//  two renderers paginate the same document the same way even when the ink
//  differs: the page-size table below, the per-axis margin scaling, zero printer
//  margin, no header, no footer, no page number, and `\newpage` as
//  `break-after: page`. **Do not add a running header or a page number.** The
//  export CSS's body padding *is* the margin, on all four platforms.
//
//  A puppeteer dependency would buy back some of this. It is deliberately not
//  taken: it is a browser download or a fragile hunt for an installed one, for
//  a file the host can already produce from the dialogue the author is looking
//  at.
//

import { renderDocument } from '../render/html';
import { RenderHost } from './renderHost';

// MARK: - Trim sizes

/** A named PDF page ("trim") size in PostScript points — 1 inch = 72 pt, portrait. */
export interface PageSize {
  /** Stable key, shared verbatim with the apps' `@AppStorage`. Never localised. */
  id: string;
  label: string;
  width: number;
  height: number;
}

/**
 * The trim-size table.
 *
 * This small table is the *single source of truth* the four platforms copy
 * verbatim (iOS feeds it to `paperRect`/`printableRect`, macOS to
 * `NSPrintInfo.paperSize`, Android builds a custom `MediaSize` from it, and
 * this port writes it into an `@page` rule), so the numbers must live in
 * exactly one place per platform and never be typed twice — a drift here would
 * paginate the same document differently on iOS than on Android.
 *
 * A4 keeps the historical `595.2 × 841.8` (210 × 297 mm rounded to a tenth of a
 * point — the value the app paginated to before trim sizes existed), so
 * choosing A4, the default, reproduces the old output exactly. **Do not "fix"
 * it to 595.28 × 841.89.** The imperial sizes are exact (6 × 9" = 432 × 648 pt);
 * A5 is 148 × 210 mm converted the same way A4 was.
 *
 * A4 first, since it is the default.
 */
export const PAGE_SIZES: readonly PageSize[] = Object.freeze([
  { id: 'a4', label: 'A4', width: 595.2, height: 841.8 },
  { id: 'a5', label: 'A5', width: 419.5, height: 595.3 },
  { id: 'letter', label: 'US Letter', width: 612, height: 792 },
  { id: 'legal', label: 'US Legal', width: 612, height: 1008 },
  { id: '6x9', label: '6 × 9"', width: 432, height: 648 },
  { id: '5x8', label: '5 × 8"', width: 360, height: 576 },
  { id: '5.5x8.5', label: '5.5 × 8.5"', width: 396, height: 612 },
]);

const A4 = PAGE_SIZES[0];

/**
 * The size stored under `id`, falling back to A4 for an empty or unknown key —
 * so a first launch, or a preference written by some future version that
 * offered a size this build does not, still lands on the default.
 *
 * Matched case-insensitively because this port's own setting spells the ids in
 * the menu's capitalisation (`A4`, `Letter`) while the apps store them
 * lower-cased (`a4`, `letter`). Accepting both keeps a settings file portable
 * between them, which is the whole reason the ids are shared at all.
 */
export function pageSizeNamed(id: string | undefined): PageSize {
  if (id === undefined) return A4;
  const wanted = id.toLowerCase();
  return PAGE_SIZES.find((size) => size.id.toLowerCase() === wanted) ?? A4;
}

/**
 * The body margin (CSS `padding`) for a trim size, scaled down from A4's
 * `48px 56px` so a small page does not wear A4-sized margins — a 6 × 9"
 * booklet with A4 margins wastes a quarter of its width.
 *
 * Each axis scales with its own dimension, so A4 reproduces `48px 56px` to the
 * pixel (the historical value, hence an A4 export is byte-for-byte what it
 * always was) and every smaller page gets a proportionate frame. US Letter is
 * *wider* than A4, so its horizontal margin **grows** to 58px: the scale is
 * proportional, not a cap.
 *
 * Rounded to whole pixels — sub-pixel margins are invisible, and the integer
 * string is what keeps the A4 case identical.
 */
export function cssPadding(size: PageSize): string {
  const vertical = Math.round((48 * size.height) / A4.height);
  const horizontal = Math.round((56 * size.width) / A4.width);
  return `${vertical}px ${horizontal}px`;
}

/**
 * Swap the body padding for the one this trim size asks for.
 *
 * **Only the first occurrence** is touched — that is the body rule inside the
 * head's `<style>`, which always precedes any user content, so a document that
 * happens to quote that exact CSS in a code block is left untouched. A plain
 * string needle is already single-occurrence in JavaScript; **do not reach for
 * a `/g` regex here.** (Contrast the HTML export's page-break swap, which
 * deliberately replaces *every* occurrence. The asymmetry is intentional on
 * both sides.)
 */
export function styledForExport(html: string, size: PageSize): string {
  const padding = cssPadding(size);
  return html.replace('padding: 48px 56px;', () => `padding: ${padding};`);
}

// MARK: - The printable document

/**
 * The document to print, at `size`.
 *
 * `dark: false, export: true`, as every export is: the renderer collapses
 * `dark && !export` before it computes the palette, so a colour scheme threaded
 * through here could never take effect anyway.
 *
 * The `@page` rule is **appended after** the verbatim stylesheet, never woven
 * into it. The family's sheet contains no `@page`, no `@media print` and no
 * custom properties, because pagination on the three apps is native; a
 * browser-based path needs the page box declared, and appending it is what
 * keeps the sheet itself byte-identical to the one every other surface uses.
 *
 * `margin: 0` because the printable area is the full page — the export CSS's
 * body padding is the margin, and asking the printer for one as well would
 * inset the text twice.
 */
export function pdfDocumentHTML(source: string, title: string, size: PageSize): string {
  const html = styledForExport(
    renderDocument(source, { title, dark: false, export: true }),
    size,
  );
  const pageRule =
    `<style>@page { size: ${size.width}pt ${size.height}pt; margin: 0; }\n` +
    // The Chromium spelling of the `-webkit-print-color-adjust: exact` already
    // in the sheet: without it the paper background and the diagram fills are
    // dropped by the print pipeline and a themed document prints as bare text.
    `html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }</style>`;
  // Function replacements throughout this folder wherever the inserted text is
  // generated: `$&` and its siblings are interpreted inside a string one.
  return html.replace('</style>', () => `</style>\n${pageRule}`);
}

/**
 * Render `html` offscreen, wait for the engines, then hand the finished page to
 * the host's print pipeline.
 *
 * The panel must outlive the call — the print dialogue belongs to it, exactly
 * as Apple's `withExtendedLifetime(renderer)` keeps the web view alive while
 * `UIPrintInteractionController` is up — so it is disposed on a timer rather
 * than immediately. Disposing it under an open dialogue would cancel the
 * author's print job with no explanation.
 */
export async function printThroughWebview(html: string, title: string): Promise<void> {
  const host = await RenderHost.open(html, { title: `md — ${title}` });
  try {
    await host.print();
  } catch (err) {
    host.dispose();
    throw err;
  }
  // Two minutes is long enough to choose a printer and a filename, and short
  // enough that a forgotten panel does not sit there holding 11 MB of engines.
  setTimeout(() => host.dispose(), 120_000);
}
