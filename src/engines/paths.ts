//
//  paths.ts
//  md.vscode — where the vendored engines live, and the only module that knows.
//
//  `media/rich/` is the fourth copy of a directory that is byte-identical in
//  md (iOS), md.macOS and md.Android — `md-init.js` says so in its own header:
//  "Identical file is bundled in md / md.macOS / md.Android — edit here, copy
//  everywhere." Parity with the three shipping apps is a product invariant, so
//  those files are loaded from disk exactly as vendored: never bundled, never
//  re-minified, never transpiled. esbuild.mjs makes the same point and keeps
//  them external.
//
//  Nothing may reach for them by a hard-coded path. The extension root is only
//  knowable at run time — an installed `.vsix`, a `--extensionDevelopmentPath`
//  checkout and a vitest run all resolve differently — so `extension.ts` sets
//  the root once on activation and every other module asks here.
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Absolute path of the vendored `rich/` directory, or `null` before
 * `setRichRoot()` has run.
 */
let root: string | null = null;

/**
 * The file a candidate directory is probed for.
 *
 * KaTeX rather than, say, `md-init.js`, because it is the asset whose absence
 * is most immediately visible (every other engine degrades to showing its own
 * source, KaTeX degrades to raw LaTeX in the middle of a sentence).
 */
const SENTINEL = 'katex.min.js';

/**
 * Directories tried, in order, when resolving what the caller handed us.
 *
 * The contract says `setRichRoot` is "called once on activate with
 * extensionUri", and the name says it takes the *rich* root — those are two
 * different directories, and it is not worth a four-repo argument. Both are
 * accepted, plus a bare `rich/` layout, because the cost of being wrong is a
 * preview with no maths and a support ticket that reads "it works on my
 * machine".
 */
const LAYOUTS: readonly string[][] = [
  [],                     // the caller already gave us media/rich
  ['media', 'rich'],      // the caller gave us the extension root
  ['rich'],               // a flatter layout, as the apps themselves use
];

let warnedAboutMissingRoot = false;

/**
 * Point the engine loaders at the vendored `rich/` directory.
 *
 * Call it once, before anything renders. Each engine loads lazily and keeps
 * what it found — including the fact that it found nothing — so moving the root
 * afterwards does not reload an engine that has already been asked for.
 *
 * Cheap: a handful of `existsSync` calls, once per activation.
 * A directory that holds none of the engines is still stored, because the
 * resulting failure — `ENOENT … /media/rich/katex.min.js` — names the exact
 * file we wanted, which is a far better diagnostic than "root not set".
 */
export function setRichRoot(dir: string): void {
  const resolved = path.resolve(dir);
  for (const layout of LAYOUTS) {
    const candidate = path.join(resolved, ...layout);
    if (fs.existsSync(path.join(candidate, SENTINEL))) {
      root = candidate;
      return;
    }
  }
  root = path.join(resolved, 'media', 'rich');
  if (!warnedAboutMissingRoot) {
    warnedAboutMissingRoot = true;
    console.warn(
      `[md] no vendored engines under ${resolved}: expected ${SENTINEL} in one of ` +
        LAYOUTS.map((l) => path.join(resolved, ...l)).join(', '),
    );
  }
}

/**
 * The vendored `rich/` directory.
 *
 * Throws when activation has not run. Every engine wrapper catches — the whole
 * layer degrades to `null` rather than throwing — so a mis-wired activation
 * costs one warning in the extension host log and a preview whose formulas and
 * diagrams stay as their own source text, which is exactly how md behaves when
 * an engine cannot load.
 */
export function richRoot(): string {
  if (root === null) {
    throw new Error('[md] engines used before setRichRoot() — call it on activation');
  }
  return root;
}

/** A file inside `rich/`. Additive convenience; the contract only names the two above. */
export function richPath(...segments: string[]): string {
  return path.join(richRoot(), ...segments);
}

/**
 * `require()` a vendored engine by file name.
 *
 * `createRequire` rather than a bare `require`, for two reasons. It states the
 * intent — this is a *runtime* load of a file that is deliberately outside the
 * bundle — where a bare `require` with a computed argument merely happens to
 * be left alone by esbuild today. And it keeps working if the extension bundle
 * is ever emitted as ESM, where `require` would not exist at all.
 *
 * The base filename is irrelevant: every path we pass is absolute.
 *
 * Node's module cache does the rest — asking twice returns the same instance,
 * which matters for KaTeX, since mhchem registers its macros onto whichever
 * instance it is handed and a second copy would not carry them.
 */
const requireVendored = createRequire(__filename);

export function requireRich(fileName: string): unknown {
  return requireVendored(richPath(fileName));
}
