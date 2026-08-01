//
//  highlight.ts
//  md.vscode — fenced-code colouring, in the extension host.
//
//  highlight.js 11.11.1, the cdnjs "common" browser build the three apps ship.
//  `highlight(code, {language}).value` returns HTML and touches no DOM, so it
//  runs here and the same spans reach the preview and every export.
//
//  THIRTY-SIX LANGUAGES, NOT ONE HUNDRED AND NINETY
//  ------------------------------------------------
//  The vendored file is the "common" build. `listLanguages()` returns exactly:
//
//      bash c cpp csharp css diff go graphql ini java javascript json kotlin
//      less lua makefile markdown objectivec perl php php-template plaintext
//      python python-repl r ruby rust scss shell sql swift typescript vbnet
//      wasm xml yaml
//
//  So `zig`, `dart`, `haskell`, `scala`, `elixir` and a long tail besides are
//  *unknown*, and an unknown language must leave the block plain. That is not a
//  limitation to route around: swapping in the full build would colour a block
//  in VS Code that is plain text on iOS, macOS and Android, which is precisely
//  the kind of divergence this port exists to avoid. Keep the vendored bytes.
//
//  ALIASES ARE PART OF THE CONTRACT
//  --------------------------------
//  `listLanguages()` names the 36 grammars; it does not name their aliases.
//  `getLanguage()` resolves both — `js`, `ts`, `py`, `sh`, `yml` all answer,
//  `zig` does not (measured). md gets aliases for free, because
//  `hljs.highlightElement(el)` reads the language off the class and looks it up
//  the same way. Consulting only `listLanguages()` here would leave ```` ```js ````
//  plain in VS Code and coloured in the apps, so both are consulted.
//
//  ASKING FIRST IS ALSO WHAT KEEPS THE LOG QUIET
//  ---------------------------------------------
//  `highlight()` with an unknown language does not fail softly: it writes
//  "Could not find the language 'zig', did you forget to load/include a language
//  module?" to the console and *then* throws `Unknown language: "zig"`. md never
//  sees either, because `md-init.js` wraps every `highlightElement` call in a
//  `try/catch` — which is exactly what its comment means by "an unknown language
//  simply leaves the block unstyled rather than throwing". Gating on
//  `knowsLanguage` first gives the same outcome without a line of somebody
//  else's diagnostics in the extension host log per code block per keystroke.
//
//  WHAT THIS FUNCTION DOES *NOT* OWN
//  ---------------------------------
//  Only the inner HTML. `hljs.highlightElement` also stamps `class="hljs
//  language-x"` and `data-highlighted="yes"` onto the element; pre-rendering
//  cannot, and `renderBody` emits the container. No visual consequence: md's
//  hljs theme is six hand-written rules and `.hljs` itself is deliberately
//  unstyled, so the block keeps the paper background either way. (Ship no file
//  from `highlight.js/styles/` — every stock theme sets `.hljs { background;
//  color }` and destroys the look.)
//

import { HIGHLIGHT_CACHE_ENTRIES, MemoCache } from './cache';
import { requireRich } from './paths';

/** The sliver of highlight.js's surface we use. */
interface Hljs {
  listLanguages(): string[];
  getLanguage(name: string): unknown;
  highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
}

const cache = new MemoCache(HIGHLIGHT_CACHE_ENTRIES);

/** `undefined` = not tried yet, `null` = tried and failed (do not retry). */
let engine: Hljs | null | undefined;

/** The 36 grammar names, resolved once. Aliases go through `getLanguage`. */
let registered: Set<string> | null = null;

function hljs(): Hljs | null {
  if (engine !== undefined) return engine;
  engine = null;
  try {
    const loaded = requireRich('highlight.min.js') as Hljs;
    registered = new Set(loaded.listLanguages());
    engine = loaded;
  } catch (error) {
    console.warn('[md] highlight.js unavailable, code blocks will stay plain:', error);
  }
  return engine;
}

/**
 * Can this build colour `language`?
 *
 * The renderer asks before it asks for the colouring, so that an unknown
 * language costs nothing and never throws. Case is folded because md emits the
 * lower-cased info word into `class="language-…"` and highlight.js lower-cases
 * every lookup anyway.
 */
export function knowsLanguage(language: string): boolean {
  const name = language.toLowerCase();
  if (name.length === 0) return false;

  const instance = hljs();
  if (instance === null) return false;

  // The grammar names first — a set lookup, and the honest answer to "what is
  // in this build". Aliases second, via the engine's own resolver.
  if (registered !== null && registered.has(name)) return true;
  try {
    return instance.getLanguage(name) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Colour one fenced block.
 *
 * Returns `null` — leave the block plain, exactly as the no-hook path emits it
 * — for an unknown language, an unloadable engine, or a hard throw. That is
 * highlight.js's failure mode in md too, and it is why the host can pass an
 * arbitrary fence info string straight through.
 *
 * `ignoreIllegals: true` because md reaches the engine through
 * `highlightElement`, which sets it. Neither illegal-rule case tried (a stray
 * `</html>` inside C, `<<<<` inside Python) rendered differently with the flag
 * off, so this is here to keep the *failure* behaviour identical rather than to
 * fix an observed divergence — with it off, a grammar that trips its own
 * `illegal` rule abandons the highlight and returns the plainly-escaped source.
 */
export function highlightCode(code: string, language: string): string | null {
  const name = language.toLowerCase();
  if (!knowsLanguage(name)) return null;

  const instance = hljs();
  if (instance === null) return null;

  return cache.memo([code, name], () => {
    try {
      return instance.highlight(code, { language: name, ignoreIllegals: true }).value;
    } catch (error) {
      console.warn(`[md] highlight.js threw on a ${name} block, leaving it plain:`, error);
      return null;
    }
  });
}
