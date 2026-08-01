//
//  engines.test.ts
//  md.vscode — the three host-side engines, exercised for real.
//
//  Nothing here is mocked. These tests load the vendored bytes out of
//  `media/rich` exactly as the extension host does, because the whole point of
//  running KaTeX, highlight.js and Graphviz in Node is that they behave there
//  identically to the way they behave in the apps' WebView — and the only way
//  to know that is to run them.
//
//  WHERE EACH ENGINE RUNS, AND WHY IT IS NOT A PREFERENCE
//  ------------------------------------------------------
//  `specs/12-CSP-GROUND-TRUTH.md` measured the built-in Markdown preview's
//  default CSP in VS Code 1.131.0: `script-src 'nonce-…'` and nothing else — no
//  `'wasm-unsafe-eval'` — and no `frame-src`, so `default-src 'none'` also
//  forbids the "render it in a sandboxed iframe" escape. In real Chromium under
//  that exact policy `WebAssembly.instantiate()` fails with a `CompileError`.
//  So Graphviz *must* run here. KaTeX and highlight.js have pure string APIs in
//  Node, so pre-rendering them keeps ~400 KB out of every preview and makes the
//  preview and every export path emit the same markup, because both read it
//  from these functions.
//
//  Mermaid and PlantUML are deliberately absent: Mermaid needs real text
//  metrics (headless it produces a `viewBox="-8 -8 30998 32"` with no `<text>`)
//  and PlantUML needs a real canvas's `measureText`. Both run in the preview.
//  A jsdom test of either would be worse than no test at all.
//

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { clearAllCaches, digest, MemoCache } from '../src/engines/cache';
import { engineHooks } from '../src/engines/index';
import { highlightCode, knowsLanguage } from '../src/engines/highlight';
import { renderMath } from '../src/engines/katex';
import { richRoot, setRichRoot } from '../src/engines/paths';
import {
  isWarm,
  renderGraphviz,
  renderGraphvizSync,
  vizEngines,
  warmUp,
} from '../src/engines/graphviz';
import { graphvizEngines, renderBody } from '../src/render/html';

/** The extension root, which is what `activate()` passes. */
const EXTENSION_ROOT = path.resolve(__dirname, '..');

beforeAll(async () => {
  setRichRoot(EXTENSION_ROOT);
  // Graphviz compiles ~1.4 MB of inlined WebAssembly on first use, and every
  // `Viz.instance()` call compiles it afresh — so the extension warms exactly
  // one instance on activation and holds it for the session. Same here.
  await warmUp();
});

afterAll(() => {
  clearAllCaches();
});

describe('paths', () => {
  it('accepts the extension root and media/rich alike', () => {
    // The contract says `setRichRoot` is "called once on activate with
    // extensionUri", and the name says it takes the *rich* root. Those are two
    // different directories and it is not worth a four-repo argument, so both
    // resolve — the cost of being wrong is a preview with no maths and a
    // support ticket that reads "it works on my machine".
    setRichRoot(EXTENSION_ROOT);
    const fromRoot = richRoot();
    setRichRoot(fromRoot);
    expect(richRoot()).toBe(fromRoot);
    expect(fromRoot.endsWith(path.join('media', 'rich'))).toBe(true);
  });
});

describe('KaTeX', () => {
  it('typesets a formula to markup, inline and in display mode', () => {
    const inline = renderMath('x^2', false);
    const display = renderMath('x^2', true);
    expect(inline).toContain('class="katex"');
    expect(inline).toContain('<math');
    // `displayMode` joins the cache key because the same LaTeX renders
    // differently in the two modes and both coexist in one document.
    expect(display).toContain('katex-display');
    expect(display).not.toBe(inline);
  });

  it('typesets chemistry through mhchem', () => {
    // mhchem's UMD does `module.exports = factory(require("katex"))`, and there
    // is no `katex` package on disk — the engines are vendored files, not npm
    // dependencies — so it is evaluated inside Node's own module wrapper with a
    // `require` that answers `'katex'` with the instance already loaded.
    //
    // The failure this pins is not a throw. A mismatched or unregistered
    // mhchem renders the formula *wrong, in red*, and nothing else tells you:
    // KaTeX's "undefined control sequence" markup carries
    // `mathcolor="#cc0000"`. Keep mhchem and KaTeX version-locked at 0.17.0
    // and always replace the two files together.
    const html = renderMath('\\ce{CO2 + C -> 2CO}', false);
    expect(html).not.toBeNull();
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('mathcolor="#cc0000"');
    expect((html ?? '').length).toBeGreaterThan(1000);
    expect(renderMath('\\pu{123 kJ//mol}', false)).not.toContain('mathcolor="#cc0000"');
  });

  it('returns KaTeX’s own red error markup for a bad formula', () => {
    // `throwOnError:false` is one of exactly two options ever passed. A bad
    // formula is not the "engine unreachable" case — it is md's documented
    // failure mode for maths, and a perfectly good string to put in the page.
    const html = renderMath('\\frac{', false);
    expect(html).not.toBeNull();
    expect(html).toContain('katex-error');
  });

  it('memoises, so a document of thirty formulas does not retypeset on every keystroke', () => {
    // VS Code re-renders the whole document on a debounce as the author types,
    // and these engines run synchronously inside that render, on the thread
    // that answers the editor's requests.
    expect(renderMath('a_1^2', true)).toBe(renderMath('a_1^2', true));
  });
});

describe('highlight.js', () => {
  it('colours a language the vendored build carries', () => {
    const html = highlightCode('let x = 1', 'swift');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('let');
  });

  it('resolves aliases as well as grammar names', () => {
    // `listLanguages()` names the 36 grammars, not their aliases;
    // `getLanguage()` resolves both. md gets aliases for free because
    // `highlightElement` reads the class and looks it up the same way, so
    // consulting only the list would leave ```js plain in VS Code and coloured
    // in the apps.
    for (const alias of ['js', 'ts', 'py', 'sh', 'yml']) {
      expect(knowsLanguage(alias), alias).toBe(true);
    }
    expect(highlightCode('const x = 1', 'js')).toContain('hljs-keyword');
  });

  it('folds case, because md emits the lower-cased info word', () => {
    expect(knowsLanguage('SWIFT')).toBe(true);
    expect(highlightCode('let x = 1', 'Swift')).toBe(highlightCode('let x = 1', 'swift'));
  });

  it('leaves an unknown language plain rather than throwing', () => {
    // THIRTY-SIX LANGUAGES, NOT ONE HUNDRED AND NINETY. The vendored file is
    // the cdnjs "common" build the three apps ship, so `zig`, `dart`,
    // `haskell`, `scala`, `elixir` and a long tail besides are unknown. That is
    // not a limitation to route around: the full build would colour a block in
    // VS Code that is plain text on iOS, macOS and Android.
    //
    // Asking first is also what keeps the log quiet: `highlight()` with an
    // unknown language writes a line of somebody else's diagnostics to the
    // console and *then* throws.
    for (const unknown of ['zig', 'dart', 'haskell', 'elixir', '']) {
      expect(knowsLanguage(unknown), unknown).toBe(false);
      expect(highlightCode('x', unknown), unknown).toBeNull();
    }
  });

  it('leaves the block exactly as the no-hook path emitted it when it declines', () => {
    // The hooks rule, end to end: `null` means "leave md's container alone".
    const withHook = renderBody('```zig\nconst x = 1;\n```', {
      title: 't',
      dark: false,
      engines: { highlight: highlightCode },
    });
    expect(withHook.html).toBe(
      '<pre><code class="language-zig">const x = 1;</code></pre>',
    );
    // …and the gate still asks for the engine, because the container is there.
    expect(withHook.needs.highlight).toBe(true);
  });
});

describe('Graphviz', () => {
  it('warms one instance and then lays out synchronously', () => {
    // `Viz.instance()` is `C().then(A => new M(A))` — every call compiles the
    // WASM afresh. `renderBody` is synchronous, so the flow is: `warmUp()` on
    // activation → `renderGraphvizSync` during render → if still cold, emit the
    // plain container and refresh when the promise settles.
    expect(isWarm()).toBe(true);
    const svg = renderGraphvizSync('digraph { a -> b }', 'dot');
    expect(svg).not.toBeNull();
    expect((svg ?? '').startsWith('<svg')).toBe(true);
    expect((svg ?? '').endsWith('</svg>')).toBe(true);
  });

  it('cuts the standalone document down to its root element', () => {
    // `renderString` hands back an `<?xml?>` declaration, a two-line SVG 1.1
    // DOCTYPE and Graphviz's own comments before the root. A DOCTYPE mid-body
    // is a parse error, so none of it may be embedded inline in HTML.
    const svg = renderGraphvizSync('digraph { a -> b }', 'dot') ?? '';
    expect(svg).not.toContain('<?xml');
    expect(svg).not.toContain('<!DOCTYPE');
    expect(svg).not.toContain('Generated by graphviz');
  });

  it('asks for a transparent background and nothing else', () => {
    // Without `bgcolor: transparent` the SVG opens with an opaque white backing
    // polygon. Ink colours are NOT set here but in CSS: a `fontname` or a
    // colour passed to the engine would change the metrics it lays the graph
    // out with, and therefore the label positions it computed.
    const svg = renderGraphvizSync('digraph { a -> b }', 'dot') ?? '';
    expect(svg).not.toContain('fill="white"');
  });

  it('fails soft on an unknown layout program', () => {
    // Refused before it is asked, so no WASM compile is provoked for a request
    // that cannot succeed — `renderString` would throw
    // `Layout type: "bogus" not recognized`.
    expect(renderGraphvizSync('digraph { a }', 'bogus')).toBeNull();
    expect(renderGraphvizSync('digraph { a }', 'DOT')).toBeNull();
  });

  it('fails soft on a diagram that does not parse', () => {
    // `null` means "leave the source visible", which is Graphviz's failure
    // mode in md. Half-written diagrams are the normal state of a document
    // being typed, so nothing is logged.
    expect(renderGraphvizSync('digraph {', 'dot')).toBeNull();
    expect(renderGraphvizSync('not a graph at all', 'dot')).toBeNull();
  });

  it('lays out every layout program md exposes', () => {
    for (const engine of new Set(Object.values(graphvizEngines))) {
      expect(renderGraphvizSync('digraph { a -> b }', engine), engine).not.toBeNull();
    }
  });

  it('accepts the three layout names md does not expose', () => {
    // A caller addressing this API directly — the `.gv` diagram preview, an
    // export — is not restricted to the fence vocabulary.
    expect(vizEngines).toContain('nop');
    expect(Object.values(graphvizEngines)).not.toContain('nop');
  });

  it('shares its instance and its memo with the async entry point', async () => {
    const sync = renderGraphvizSync('digraph { a -> b }', 'dot');
    await expect(renderGraphviz('digraph { a -> b }', 'dot')).resolves.toBe(sync);
  });
});

describe('the hooks object', () => {
  it('omits a disabled engine rather than wiring a hook that returns null', () => {
    // The two are identical by the hooks rule, and absence says what was meant:
    // the feature is off, so the container is emitted untouched and the reader
    // sees the LaTeX, the plain code or the DOT source.
    expect(Object.keys(engineHooks()).sort()).toEqual(['graphviz', 'highlight', 'math']);
    expect(Object.keys(engineHooks({ math: false, graphviz: false }))).toEqual(['highlight']);
    expect(Object.keys(engineHooks({ math: false, highlight: false, graphviz: false }))).toEqual([]);
  });

  it('renders a whole document through the real engines', () => {
    const { html, needs } = renderBody(
      ['$\\ce{H2O}$', '', '```dot', 'digraph { a -> b }', '```', '', '```swift', 'let x = 1', '```'].join('\n'),
      { title: 't', dark: false, engines: engineHooks() },
    );
    expect(html).toContain('class="katex"');
    expect(html).toContain('<div class="graphviz" data-engine="dot"><svg');
    expect(html).toContain('hljs-keyword');
    // The containers are *filled*, never replaced, so the gate still sees the
    // same document it would have without the hooks.
    expect(needs).toEqual({
      math: true,
      mermaid: false,
      plantuml: false,
      graphviz: true,
      highlight: true,
    });
  });
});

describe('the memo', () => {
  it('length-prefixes its parts, so no two part lists can collide', () => {
    // A code block whose language is part of the key would otherwise be
    // confusable with a longer one, and a collision would silently show one
    // author's diagram in another's place.
    expect(digest(['ab', 'c'])).not.toBe(digest(['a', 'bc']));
    expect(digest(['a'])).toBe(digest(['a']));
    expect(digest([])).toHaveLength(64);
  });

  it('computes once per distinct key and caches null as a real answer', () => {
    // `null` is how every engine says "leave the block's source visible", and
    // repeating that answer is free. A half-typed diagram is a syntax error on
    // most keystrokes; re-running Graphviz to be told so again buys nothing.
    const cache = new MemoCache(4);
    let calls = 0;
    const produce = (): string | null => {
      calls++;
      return null;
    };
    expect(cache.memo(['k'], produce)).toBeNull();
    expect(cache.memo(['k'], produce)).toBeNull();
    expect(calls).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('evicts least-recently-used at the bound', () => {
    const cache = new MemoCache(2);
    cache.memo(['a'], () => 'A');
    cache.memo(['b'], () => 'B');
    // Touching `a` moves it to the young end, so `b` is the one that goes.
    cache.memo(['a'], () => 'recomputed');
    cache.memo(['c'], () => 'C');
    expect(cache.size).toBe(2);
    // `a` survived the eviction and still answers from the memo…
    expect(cache.memo(['a'], () => 'wrong')).toBe('A');
    // …while `b` has to be produced again.
    let recomputed = false;
    cache.memo(['b'], () => {
      recomputed = true;
      return 'B';
    });
    expect(recomputed).toBe(true);
  });
});
