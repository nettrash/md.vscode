//
//  graphviz.ts
//  md.vscode — DOT diagrams, laid out in the extension host.
//
//  Viz.js 3.24.0, carrying Graphviz 14.1.1 and Expat as inlined WebAssembly.
//
//  THIS ONE HAS NO CHOICE ABOUT WHERE IT RUNS
//  ------------------------------------------
//  The built-in Markdown preview's default CSP is `script-src 'nonce-…'` and
//  nothing else — no `'wasm-unsafe-eval'` — and it carries no `frame-src`, so
//  `default-src 'none'` also forbids the "render it in a sandboxed iframe"
//  escape. Measured in Chromium against the exact policy string VS Code emits:
//  `WebAssembly.instantiate()` fails with a `CompileError`, and so does the
//  synchronous `new WebAssembly.Module()`. Only the user can raise that level,
//  per workspace, through a scary prompt; no extension API does it. So Graphviz
//  runs in Node, where there is no CSP, and the preview receives finished SVG.
//
//  (Inside the preview, `viz-global.js` still has a second job: PlantUML's TeaVM
//  build calls the *global* `Viz` for its Graphviz-backed layouts — class,
//  activity, state, component. That copy is the preview's business, not this
//  file's.)
//
//  THE MODULE SHAPE, MEASURED
//  --------------------------
//  The UMD's first branch is CommonJS: `typeof exports === 'object' && typeof
//  module !== 'undefined' ? factory(exports) : …`, so `require()` populates
//  `module.exports` itself and hands back the namespace:
//
//      Object.keys(require('media/rich/viz-global.js'))
//        → [ 'engines', 'formats', 'graphvizVersion', 'instance' ]
//
//  There is **no `.Viz` property** under CommonJS — `const { Viz } = require(…)`
//  yields `undefined`. `.Viz` only exists on the browser branch, which assigns
//  the namespace to `globalThis.Viz`. Both shapes are accepted below so that
//  neither reading of the file can break this module.
//
//  Do not rename `viz-global.js`. The emscripten shim bakes in
//  `new URL("viz-global.js", document.baseURI).href` as its script-directory
//  fallback. It is inert — the WASM is a 1.4 MB inline `data:` URI and the one
//  `fetch(` in the shim is short-circuited before it is reached — but the apps
//  all ship this filename and the preview loads it by that name.
//
//  ONE INSTANCE, KEPT WARM
//  -----------------------
//  `Viz.instance()` is `C().then(A => new M(A))`: **every call compiles the
//  WASM afresh** (measured: two calls, two distinct objects). md creates exactly
//  one per page for that reason and so do we — one per extension host, held for
//  the session. Measured on this machine: 12 ms to instantiate, then 2 ms to lay
//  out a small graph, synchronously. That asymmetry is the whole design of this
//  file: `renderBody` is synchronous, so the instance is warmed on activation
//  and the render path only ever calls the synchronous `renderString`.
//
//  `bgcolor: 'transparent'` AND NOTHING ELSE
//  -----------------------------------------
//  md passes exactly `{engine, graphAttributes: {bgcolor: 'transparent'}}` and
//  writes down why: it "drops Graphviz's opaque white backing polygon so the
//  diagram sits on the paper like every other block. Ink colours are NOT set
//  here but in CSS: a `fontname` or colour passed to the engine would change
//  the metrics it lays the graph out with, and the app's typewriter face doesn't
//  exist on every platform."
//
//  Confirmed: `digraph { a -> b }` renders 1,306 bytes opening
//  `<polygon fill="white" stroke="none" points="-4,4 -4,-112 58,-112 58,4 -4,4"/>`
//  without the attribute, and 1,228 bytes with no such polygon at all with it.
//  Recolouring happens in four CSS rules scoped to the attribute values the
//  engine emits when nothing was asked for, so an author's own `fontcolor` or
//  `color` survives and the label positions Graphviz computed stay true.
//  **Never pass `fontname`, `fontcolor` or `color` to this engine.**
//

import { GRAPHVIZ_CACHE_ENTRIES, MemoCache } from './cache';
import { requireRich } from './paths';

/** The sliver of Viz.js's surface we use. */
interface VizInstance {
  renderString(
    source: string,
    options: {
      format: 'svg';
      engine: string;
      graphAttributes: { bgcolor: string };
    },
  ): string;
}

interface VizNamespace {
  instance(): Promise<VizInstance>;
  engines: string[];
  graphvizVersion: string;
  /** Present only if the file ever loads through its browser branch. */
  Viz?: VizNamespace;
}

/**
 * The layout programs Viz.js 3.24.0 accepts, read off `Viz.engines`.
 *
 * A frozen copy rather than a live read, so that an unknown engine is rejected
 * identically whether the WASM is warm, cold or unloadable — the answer to "is
 * `bogus` a layout program" must not depend on load state. It is checked
 * against the real list on load; a mismatch means the vendored file changed
 * under us, which is worth one loud line.
 *
 * `MarkdownHTML.graphvizEngines` maps ten fence words onto eight of these; md
 * deliberately exposes no `nop`/`nop1`/`nop2`. They are accepted here because a
 * caller addressing this API directly (the `.gv` diagram preview, an export)
 * is not restricted to the fence vocabulary.
 */
export const vizEngines: readonly string[] = Object.freeze([
  'circo', 'dot', 'fdp', 'neato', 'nop', 'nop1', 'nop2',
  'osage', 'patchwork', 'sfdp', 'twopi',
]);

const cache = new MemoCache(GRAPHVIZ_CACHE_ENTRIES);

/** The one instance for the whole session, once the WASM has compiled. */
let instance: VizInstance | null = null;

/** In-flight warm-up, so concurrent callers share one WASM compile. */
let warming: Promise<void> | null = null;

/** Sticky failure: a missing or unloadable engine does not get better by retrying. */
let unavailable = false;

/** True once `renderGraphvizSync` can actually answer. */
export function isWarm(): boolean {
  return instance !== null;
}

/**
 * Compile the WASM and hold the instance.
 *
 * Never rejects. Called on activation; called again, harmlessly, by a cold
 * synchronous render. `renderBody` is synchronous, so the intended flow is:
 * `warmUp()` on activate → `renderGraphvizSync` during render → if still cold,
 * emit the plain container and refresh the preview when this promise settles.
 */
export function warmUp(): Promise<void> {
  if (instance !== null || unavailable) return Promise.resolve();
  if (warming !== null) return warming;

  warming = (async () => {
    try {
      const loaded = requireRich('viz-global.js') as VizNamespace;
      // Accept both module shapes — see the header. The CommonJS branch hands
      // back the namespace itself; `.Viz` would only appear on the browser one.
      const viz: VizNamespace = loaded.Viz ?? loaded;

      const actual = viz.engines.join(',');
      if (actual !== vizEngines.join(',')) {
        console.warn(
          `[md] vendored Viz.js reports a different engine list (${actual}); ` +
            'the frozen list in graphviz.ts needs updating',
        );
      }

      instance = await viz.instance();
    } catch (error) {
      unavailable = true;
      console.warn('[md] Graphviz unavailable, DOT blocks will stay as source:', error);
    } finally {
      warming = null;
    }
  })();

  return warming;
}

/**
 * Lay out one DOT source, if the engine is already warm.
 *
 * `null` means "leave the source visible", which is Graphviz's failure mode in
 * md — a syntax error throws with a message and the untouched DOT stays on
 * screen. Three roads lead there and they are deliberately not distinguished by
 * the return value:
 *
 *   * an unknown layout program — `renderString` would throw
 *     `Layout type: "bogus" not recognized`, so it is refused before it is
 *     asked, and no WASM compile is provoked for a request that cannot succeed;
 *   * a cold (or unloadable) engine — the caller emits the plain container and
 *     the preview refreshes once `warmUp()` settles;
 *   * a diagram that does not parse.
 */
export function renderGraphvizSync(source: string, engine: string): string | null {
  if (!vizEngines.includes(engine)) return null;

  if (instance === null) {
    // Fire and forget: the render must stay synchronous. This matters when the
    // first document is already open at activation and a render beats the
    // warm-up to the punch.
    if (!unavailable) void warmUp();
    return null;
  }

  const viz = instance;
  return cache.memo([source, engine], () => {
    try {
      const document = viz.renderString(source, {
        format: 'svg',
        engine,
        graphAttributes: { bgcolor: 'transparent' },
      });
      return inlineSVG(document);
    } catch {
      // A syntax error throws with a message. Nothing to log: half-written
      // diagrams are the normal state of a document being typed, and md shows
      // the source for exactly this case.
      return null;
    }
  });
}

/**
 * Lay out one DOT source, warming the engine first if need be.
 *
 * For the export writers and the standalone diagram preview, which are async
 * and can afford to wait. Shares the instance and the memo with the synchronous
 * path — the two differ only in whether they are willing to block.
 */
export async function renderGraphviz(source: string, engine: string): Promise<string | null> {
  await warmUp();
  return renderGraphvizSync(source, engine);
}

/**
 * Cut the `<svg>` element out of the XML document Viz.js returns.
 *
 * `renderString` hands back a standalone document: an `<?xml?>` declaration, a
 * two-line SVG 1.1 DOCTYPE, and Graphviz's `<!-- Generated by graphviz … -->`
 * and `<!-- Pages: 1 -->` comments, before the root element. None of that may
 * be embedded inline in HTML — a DOCTYPE mid-body is a parse error.
 *
 * Slicing to the root element is also what md ends up with: it calls
 * `renderSVGElement`, which parses the same document and appends only
 * `documentElement`, so everything above the root never reaches the page there
 * either. Same bytes, same reason.
 */
function inlineSVG(document: string): string | null {
  const start = document.indexOf('<svg');
  if (start < 0) return null;
  const end = document.lastIndexOf('</svg>');
  if (end < 0) return null;
  return document.slice(start, end + '</svg>'.length);
}
