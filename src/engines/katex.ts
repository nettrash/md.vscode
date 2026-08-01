//
//  katex.ts
//  md.vscode — maths and chemistry, typeset in the extension host.
//
//  KaTeX 0.17.0, plus the mhchem contrib shipped with it. Both are pure string
//  APIs in Node: `renderToString()` needs no DOM, no WASM and no network, which
//  is why they run here rather than in the preview. Pre-rendering keeps ~300 KB
//  of engine out of every preview and — the reason that actually matters —
//  makes the preview and every export path emit the *same* markup, because both
//  read it from this function.
//
//  WHAT MD DOES, AND WHY THIS IS THE SAME THING
//  --------------------------------------------
//  `md-init.js` calls `katex.render(el.textContent, el, {displayMode, throwOnError:false})`
//  on exactly the spans the host marked `.md-mathi` / `.md-mathd`. We call
//  `renderToString` with the same two options instead, because there is no DOM
//  here. They are the same tree: KaTeX builds one dom-tree and either
//  materialises it (`toNode()`, what `render` appends) or serialises it
//  (`toMarkup()`, what `renderToString` returns).
//
//  Two consequences worth stating plainly:
//
//   * **Exactly two options are ever passed** — `displayMode` and
//     `throwOnError:false`. Everything else stays at KaTeX 0.17.0's defaults
//     (`output:'htmlAndMathml'`, `strict:'warn'`, `trust:false`, `macros:{}`,
//     `maxExpand:1000`, `leqno:false`, `fleqn:false`, `minRuleThickness:0`).
//     Passing anything else diverges the markup from the three apps.
//   * **The `tex` we are handed must be the decoded LaTeX**, not the
//     HTML-escaped form the container carries. md's KaTeX reads `el.textContent`,
//     which the browser has already decoded; `MarkdownHTML.swift` spells it out:
//     "the LaTeX is escaped for HTML but KaTeX reads the decoded textContent."
//
//  There is no whole-body delimiter scan here and there must never be one. md
//  refuses KaTeX's auto-render for a reason it wrote down: "that would
//  re-interpret ordinary prose (e.g. two currency amounts, "$5 and $10") as a
//  formula. The host's inline() pass owns the decision of what is math; here we
//  just typeset it." `auto-render.min.js` is bundled in the apps and referenced
//  by nothing.
//
//  MHCHEM NEEDS A RESOLVER SHIM — MEASURED, NOT GUESSED
//  ----------------------------------------------------
//  `mhchem.min.js` is a UMD whose CommonJS branch is
//
//      module.exports = factory(require("katex"))
//
//  and there is no `katex` package on disk — the engines are vendored files,
//  not npm dependencies. Requiring it plainly therefore fails outright:
//
//      require('media/rich/mhchem.min.js')
//        → Error [MODULE_NOT_FOUND]: Cannot find module 'katex'
//
//  So the file is evaluated inside Node's own module wrapper with a `require`
//  that answers `'katex'` with the instance we already loaded. Proof that the
//  macros actually land, both halves run in a clean Node 26 process:
//
//      with the shim:     renderToString('\\ce{CO2 + C -> 2CO}', …)
//                         → 3,734 characters of markup, no `katex-error`,
//                           no `mathcolor="#cc0000"` anywhere
//      without it:        the same call returns markup carrying
//                         `mathcolor="#cc0000"` — KaTeX's red "undefined
//                           control sequence" text
//
//  That second shape is precisely the failure the apps warn about: "mhchem
//  silently no-ops against a mismatched KaTeX, so the two files must always be
//  replaced together." It does not throw. It renders the formula wrong, in red,
//  and nothing else tells you. Keep the two files version-locked at 0.17.0.
//
//  Why the module wrapper and not a `Module._load` hook: the hook is a global
//  mutation of the extension host's module system, it races anything else that
//  requires while it is installed, and it has to be unwound in a `finally`. The
//  wrapper is local, needs no cleanup, and is exactly what Node itself does to
//  every CommonJS file.
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { MATH_CACHE_ENTRIES, MemoCache } from './cache';
import { richPath, requireRich } from './paths';

/** The sliver of KaTeX's surface we use. */
interface Katex {
  renderToString(tex: string, options: { displayMode: boolean; throwOnError: boolean }): string;
}

/** Node's module wrapper, as a callable. */
type ModuleFactory = (
  exports: unknown,
  require: (id: string) => unknown,
  module: { exports: unknown },
  filename: string,
  dirname: string,
) => void;

const cache = new MemoCache(MATH_CACHE_ENTRIES);

/** `undefined` = not tried yet, `null` = tried and failed (do not retry). */
let engine: Katex | null | undefined;

/**
 * Load KaTeX once, with mhchem's macros registered onto it.
 *
 * A failure is sticky. The only ways this fails are a missing or corrupt
 * vendored file and a mis-wired `setRichRoot`, none of which get better by
 * retrying on the next keystroke, and all of which would otherwise log once per
 * formula per render.
 */
function katex(): Katex | null {
  if (engine !== undefined) return engine;
  engine = null;
  try {
    const loaded = requireRich('katex.min.js') as Katex;
    registerMhchem(loaded);
    engine = loaded;
  } catch (error) {
    console.warn('[md] KaTeX unavailable, formulas will stay as LaTeX:', error);
  }
  return engine;
}

/**
 * Evaluate `mhchem.min.js` with a `require` that resolves `'katex'` to the
 * instance we just loaded, so its `__defineMacro` calls for `\ce`, `\pu` and
 * `\tripledash` land on the KaTeX every formula is typeset by.
 *
 * mhchem's whole observable effect is that side effect — its exports are empty
 * (this wrapper's `module.exports` comes back `undefined`), which is why the
 * return value is discarded.
 *
 * A failure here is deliberately *not* fatal to maths: chemistry then renders
 * as KaTeX's red undefined-macro text, exactly as a version skew would, while
 * ordinary formulas carry on working.
 */
function registerMhchem(instance: Katex): void {
  const file = richPath('mhchem.min.js');
  try {
    const source = fs.readFileSync(file, 'utf8');
    // The trailing newline before `}` is not decoration: it terminates a final
    // line comment, should the file ever end in one. Node's own wrapper does
    // the same for the same reason.
    const factory = vm.runInThisContext(
      `(function (exports, require, module, __filename, __dirname) {${source}\n})`,
      { filename: file },
    ) as ModuleFactory;

    const shim = { exports: {} as unknown };
    factory(
      shim.exports,
      (id: string): unknown => {
        if (id === 'katex') return instance;
        throw new Error(`[md] mhchem asked for an unexpected module: ${id}`);
      },
      shim,
      file,
      path.dirname(file),
    );
  } catch (error) {
    console.warn('[md] mhchem unavailable, \\ce{} and \\pu{} will not typeset:', error);
  }
}

/**
 * Typeset one formula.
 *
 * Returns `null` only when KaTeX itself could not be reached or threw hard, in
 * which case `renderBody` leaves md's container exactly as the no-hook path
 * would emit it and the reader sees the LaTeX. A *bad* formula is not that
 * case: `throwOnError:false` makes KaTeX return its red error markup in place,
 * which is md's documented failure mode for maths and is a perfectly good
 * string. The `try` is the same second belt md's `try/catch` is — it catches
 * the rare hard throw, not the ordinary parse error.
 */
export function renderMath(tex: string, displayMode: boolean): string | null {
  const instance = katex();
  if (instance === null) return null;

  // `displayMode` joins the key: the same LaTeX renders differently inline and
  // as a display block, and the two forms coexist in one document.
  return cache.memo([tex, displayMode ? 'display' : 'inline'], () => {
    try {
      return instance.renderToString(tex, { displayMode, throwOnError: false });
    } catch (error) {
      console.warn('[md] KaTeX threw on a formula, leaving it as LaTeX:', error);
      return null;
    }
  });
}
