//
//  plantuml-limit.test.ts
//  md.vscode — the one deliberate patch inside a vendored engine, pinned.
//
//  THE GATE, AND WHY IT IS GONE
//  ----------------------------
//  The vendored browser build of PlantUML (1.2026.4beta4 / 9a0b195) carries a
//  hard size gate of its own: after a diagram is fully laid out, its final
//  width and height are each compared against 4096.0, and if either exceeds it
//  the drawing is thrown away and the block shows
//
//      java.lang.RuntimeException: Diagram too large for browser rendering:
//      7655x1445 (max 4096)
//
//  instead of a diagram. A 48-participant sequence diagram is already past the
//  limit; nothing about it is unreasonable to write.
//
//  The gate guards a raster budget — a canvas that size is real memory — and
//  in this extension that budget is bounded by layout, not by the diagram.
//  The preview, the diagram panel and the HTML / SVG / PDF exports take the
//  SVG itself, whose dimensions are numbers in a text file; the LaTeX export
//  keeps the source. The one consumer that does rasterise — the EPUB export,
//  whose render host snapshots each diagram through a canvas at twice its
//  laid-out size — draws the rect the page gave it, and `.plantuml svg
//  { max-width: 100%; height: auto; }` (css-text.ts) has already capped that
//  rect at the panel's width. That bound is the load-bearing fact, so it is
//  said precisely: capture those snapshots at the SVG's *intrinsic* size one
//  day — a tempting "quality fix", since a wide diagram now downscales into
//  the EPUB — and the diagrams this patch unlocks will blow straight through
//  Chromium's canvas caps (32 767 px per side, ~268 Mpx of area), silently,
//  as an empty `toDataURL` payload. So the gate was costing real diagrams to
//  defend a budget no consumer as written can overspend, and both literals
//  are raised to 1.0E9 in `media/rich/plantuml.js` — the one place this
//  repository's engines depart from the vendored bytes, said plainly in
//  `.vscodeignore` and `esbuild.mjs` where the "vendored" story is told.
//
//  MEASURED, NOT REASONED
//  ----------------------
//  Verified 2026-08-06 in headless Chrome (a real canvas, real `measureText` —
//  the jsdom caveat in `vitest.config.ts` is why this file asserts bytes and
//  not renders). Unpatched, the 48-participant sequence dies at the gate with
//  the error above. Patched, the same source renders 7656×1445 with 143
//  `<text>` elements, and a 120-participant one renders 19397×3533 with 359 in
//  about 130 ms — so there is no hidden second gate behind the first, and no
//  timeout worry either: the preview allows a diagram twenty seconds. A
//  3-participant control renders 460×140 on both sides of the patch,
//  byte-identically.
//
//  WHAT THIS TEST ACTUALLY GUARDS
//  ------------------------------
//  A re-vendored plantuml.js would carry the gate again, silently — the
//  extension would build, every other test would pass, and big diagrams would
//  be broken in a way nobody notices until one is. So this file fails loudly
//  instead, **by design**, the day the engine is replaced: the pinned fragment
//  below is minifier output and a fresh build will not reproduce it. That
//  failure is the reminder to re-apply the patch:
//
//      perl -pi -e 's/o<=4096\.0\)\{p=m\.bDm;if\(p<=4096\.0\)/o<=1.0E9){p=m.bDm;if(p<=1.0E9)/' media/rich/plantuml.js
//
//  (adjusting the minified identifiers to whatever the new build calls them),
//  to re-verify in a real browser, and to update the pin.
//

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const PLANTUML = path.resolve(__dirname, '..', 'media', 'rich', 'plantuml.js');

/** The patched gate, exactly as it reads in the vendored file: width, then
 *  height, each allowed up to 1.0E9 where the build shipped 4096.0. */
const PATCHED_GATE = 'o<=1.0E9){p=m.bDm;if(p<=1.0E9)';

describe('the PlantUML size-gate patch', () => {
  const source = readFileSync(PLANTUML, 'latin1');

  it('holds the raised gate, once', () => {
    expect(source.split(PATCHED_GATE).length - 1).toBe(1);
  });

  it('holds no 4096-pixel comparison anywhere', () => {
    // `4096` alone appears legitimately — sprite palette class names, Unicode
    // tables — but the gate compared *doubles*, and no other double 4096.0
    // exists in the build. Its reappearance means a re-vendored engine.
    expect(source.includes('4096.0')).toBe(false);
  });
});
