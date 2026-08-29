//
//  markdownItHook.ts
//  md.vscode — how md's renderer replaces markdown-it inside a preview that
//  belongs to somebody else.
//
//  WHAT WE ARE ACTUALLY HOOKING
//  ----------------------------
//  `contributes["markdown.markdownItPlugins"] === true` earns one synchronous
//  call, `extendMarkdownIt(md)`, on the built-in preview's own markdown-it
//  instance. The obvious plan — add a few rules and let markdown-it render —
//  cannot work here: md is a hand-written, test-pinned *subset* of CommonMark
//  with deliberate divergences (no raw HTML, no reference links, no indented
//  code, flat lists, a currency guard on inline maths, a table that cannot
//  interrupt a paragraph). Expressed as markdown-it plugins it would be a
//  second implementation to keep in step with three shipping apps, which is
//  precisely the risk this family exists to avoid.
//
//  So we do not extend the renderer. We *replace* its output, from the
//  original source text, and let markdown-it keep only the jobs VS Code needs
//  it for (tokens for the outline, folding, smart select and document links).
//
//  FINDING THE SOURCE TEXT — THE PART THAT LOOKS EASY AND IS NOT
//  ------------------------------------------------------------
//  VS Code never calls `md.render(text)`. Read from the shipped 1.131 bundle,
//  `MarkdownItEngine.render` is, minification and all:
//
//      async render(t, n) {
//        let r = this.#a(…), i = await this.#i(r),
//            o = typeof t == "string" ? this.#s(t, i) : this.#o(t, r, i),
//            a = { containingImages: new Set, currentDocument: …,
//                  resourceProvider: n, slugifier: … };
//        return { html: i.renderer.render(o, {...i.options, ...r}, a), … }
//      }
//      #s(t, n) { let r = { currentDocument: void 0, containingImages: new Set,
//                           slugifier: …, resourceProvider: void 0 };
//                 return n.parse(t, r) }
//
//  Two things follow, and both are load-bearing:
//
//    1. **The parse env and the render env are different objects.** `#s`
//       builds its own literal for `parse`; `render` builds a second literal
//       `a` for `renderer.render`. Stashing `state.src` onto `state.env` in a
//       core rule therefore writes into an object the renderer never sees. We
//       still do it — it is free, and it is what works in any host that calls
//       `md.render(src, env)`, where markdown-it threads one env through —
//       but it cannot be the mechanism we rely on.
//    2. **Tokens are cached** (`#o` returns `tryGetCached(...)` when the
//       document has not changed), so on a re-render `parse` may not run at
//       all. Anything stashed during parsing must survive the cache.
//
//  What *does* survive both is the token array itself: `#o` hands the very
//  same array back on a cache hit, and it is that array which reaches
//  `renderer.render`. So we key a `WeakMap` on it. The map holds no strong
//  reference, so when VS Code drops a cached token stream the source text goes
//  with it.
//
//  WHERE THE ENGINES RUN, AND WHY THAT IS NOT A PREFERENCE
//  ------------------------------------------------------
//  KaTeX (with mhchem), highlight.js and Graphviz are pre-rendered here, in
//  the extension host, and arrive in the markup as finished HTML and SVG. The
//  first two because they have pure string APIs in Node, so the same bytes
//  serve the preview and every export; Graphviz because it has no choice —
//  the built-in preview's `script-src` is `'nonce-…'` and nothing else, with
//  no `'wasm-unsafe-eval'`, so `WebAssembly.instantiate` throws there. Mermaid
//  and PlantUML are left to the client script, which the preview injects with
//  a nonce: Mermaid needs real text metrics and PlantUML a real
//  `measureText`, and neither can be had in Node.
//
//  Byte-parity with the apps is asserted in the export path, which we generate
//  end to end. This surface aims at *visual* parity, because VS Code owns the
//  shell, the `<head>`, the body classes and the user's own `markdown.styles`.
//

import type * as vscode from 'vscode';

import { highlightCode } from '../engines/highlight';
import { renderMath } from '../engines/katex';
import { renderGraphvizSync } from '../engines/graphviz';
import { renderBody, type EngineHooks } from '../render/html';
import { escapeHTML } from '../render/inline';
import { isDarkTheme, readConfig, wrapperAttributes, type MdConfig } from './config';

/**
 * Source text by token array.
 *
 * Weak on purpose: the key is VS Code's cached token stream, whose lifetime we
 * neither know nor should extend. When the cache evicts the array the entry
 * goes with it, so a long editing session does not accumulate one copy of
 * every document it has ever previewed.
 */
const sourceByTokens = new WeakMap<object, string>();

/**
 * The secondary stash, on the parse env.
 *
 * Unused by VS Code (see the header) but correct for any caller that threads a
 * single env through `md.render`, and free to maintain. A string key rather
 * than a symbol so it survives an env that has been spread or shallow-copied.
 */
const ENV_SOURCE_KEY = '__mdVSCodeSource';

/**
 * VS Code's entry point. Must be synchronous, must return the engine, and must
 * not throw: the caller wraps this in a `try` whose `catch` writes one line —
 * `Could not load markdown it plugin` — to a log nobody reads, and then
 * carries on with a plain markdown-it. A failure here is therefore invisible
 * unless we make it visible ourselves.
 */
export function extendMarkdownIt(md: any): any {
  try {
    captureSource(md);
    replaceRenderer(md);
  } catch (err) {
    // Deliberately not rethrown: a broken hook must degrade to VS Code's own
    // preview, not to no preview at all.
    console.error('[md] extendMarkdownIt failed; the built-in renderer stays in place.', err);
  }
  return md;
}

/**
 * Remember the source text of every parse, against both the token array and
 * the env (see the header for why it takes two).
 */
function captureSource(md: any): void {
  md.core.ruler.push('md_capture_source', (state: any) => {
    if (!state || typeof state.src !== 'string') return;
    if (state.env && typeof state.env === 'object') {
      state.env[ENV_SOURCE_KEY] = state.src;
    }
    if (Array.isArray(state.tokens)) {
      sourceByTokens.set(state.tokens, state.src);
    }
  });

  // The core rule sees `state.tokens` as it stands when our rule runs, and our
  // rules run *first* — VS Code appends its own afterwards, including the
  // source-map ruler. A later rule is at liberty to hand back a different
  // array, and then the one the renderer receives would not be the one we
  // keyed on. Wrapping `parse` closes that gap: whatever array comes out is
  // the array that goes in.
  const parse = md.parse.bind(md);
  md.parse = (src: string, env: any): any => {
    const tokens = parse(src, env);
    if (typeof src === 'string' && Array.isArray(tokens)) {
      sourceByTokens.set(tokens, src);
    }
    return tokens;
  };
}

/**
 * Render md's body from the remembered source, falling back to markdown-it
 * whenever we cannot prove which source produced these tokens.
 *
 * The fallback matters more than it looks. `renderer.render` is also how VS
 * Code renders fragments for other features and how `markdown.api.render`
 * serves other extensions; returning our body for a token stream we did not
 * see parsed would hand them somebody else's document.
 */
function replaceRenderer(md: any): void {
  const render = md.renderer.render.bind(md.renderer);

  md.renderer.render = (tokens: any, options: any, env: any): string => {
    const source = sourceFor(tokens, env);
    if (source === null) return render(tokens, options, env);

    try {
      return previewBody(source, env);
    } catch (err) {
      // Show the failure and still show the document. Nothing the author
      // wrote is dropped in silence — including when it is our fault.
      console.error('[md] preview render failed; falling back to markdown-it.', err);
      return errorBanner(err) + render(tokens, options, env);
    }
  };
}

function sourceFor(tokens: unknown, env: any): string | null {
  if (tokens && typeof tokens === 'object') {
    const remembered = sourceByTokens.get(tokens as object);
    if (typeof remembered === 'string') return remembered;
  }
  const stashed = env?.[ENV_SOURCE_KEY];
  return typeof stashed === 'string' ? stashed : null;
}

/**
 * The body of the preview: md's own markup, wrapped in the one element that
 * carries our settings into a page we cannot otherwise talk to.
 */
function previewBody(source: string, env: any): string {
  const resource = documentUri(env);
  const config = readConfig(resource);
  const dark = isDarkTheme();

  const { html, needs } = renderBody(source, {
    // `renderBody` emits no `<head>`, so the title is inert here; the export
    // path is where it is real.
    title: '',
    dark,
    // The whole of VS Code's scroll sync, in both directions, keys off
    // `class="code-line" data-line="N"` on block elements — its client walks
    // `getElementsByClassName('code-line')` and reads the attribute. Emitting
    // them is all it takes; there is no message protocol to implement. They
    // stay behind this flag because they are VS Code-only and must never
    // appear in the bytes the parity tests diff.
    sourceLines: true,
    // Each Mermaid and PlantUML block carries its own source in `data-md-src`.
    // The preview is patched in place rather than reloaded, so the client
    // cannot trust what it finds inside a diagram container: a morph can leave
    // a stale `<svg>` there with the client's own marker stripped off, and an
    // engine handed that draws a syntax error instead of a diagram. Same gate
    // as `sourceLines` — additive, VS Code-only, never in the parity bytes.
    diagramSources: true,
    // The plot renderer is not an engine and has no hook: it draws in the
    // renderer itself, so its off switch is a plain flag rather than an absent
    // hook. Passing `true` explicitly would be identical; passing the setting
    // is what makes `md.diagrams.plot` mean anything.
    plot: config.plot,
    engines: engineHooks(config),
  });

  const clientEngines = clientEngineList(config, needs);

  return (
    `<div ${wrapperAttributes(config, dark)} data-md-render="${clientEngines}">\n` +
    `${html}\n` +
    `</div>`
  );
}

/**
 * The host-side engines, each gated on its own setting.
 *
 * A hook that is absent leaves the container exactly as the no-hook path emits
 * it — a maths span keeps its TeX, a code block stays plain, a Graphviz block
 * keeps its DOT source — which is what "turn this engine off" should mean.
 * That is also what happens when Graphviz is still cold: `renderGraphvizSync`
 * returns `null` until the WebAssembly module has compiled, and activation
 * asks every open preview to refresh once it has.
 */
function engineHooks(config: MdConfig): EngineHooks | undefined {
  const hooks: EngineHooks = {};
  if (config.math) hooks.math = renderMath;
  if (config.highlight) hooks.highlight = highlightCode;
  if (config.graphviz) hooks.graphviz = renderGraphvizSync;

  // Pass `undefined` rather than an empty object when everything is off, so
  // the renderer takes the literal no-hook path the parity contract describes.
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

/**
 * Which client-side engines this document should load, as a space-separated
 * list for `data-md-render`.
 *
 * Two questions, one answer: does the document contain such a block (`needs`,
 * which the emitter derives from the markup it actually produced, so a diagram
 * nested inside a block quote counts), and has the user left that engine on.
 * The client cannot see the settings, so a DOM scan alone would render a
 * Mermaid diagram the user had switched off. An empty value is meaningful and
 * is emitted: it says "no engine, do not fetch 3.5 MB".
 */
function clientEngineList(config: MdConfig, needs: { mermaid: boolean; plantuml: boolean }): string {
  const wanted: string[] = [];
  if (needs.mermaid && config.mermaid) wanted.push('mermaid');
  if (needs.plantuml && config.plantuml) wanted.push('plantuml');
  return wanted.join(' ');
}

/**
 * `env.currentDocument` is the previewed document's `Uri` — VS Code sets it to
 * `typeof t == "string" ? void 0 : t.uri`, so it is absent when an extension
 * asked for a bare string to be rendered. Every `md.*` preview setting is
 * `resource`-scoped, so passing it through is what makes a per-folder or
 * per-file override work.
 */
function documentUri(env: any): vscode.Uri | undefined {
  const candidate = env?.currentDocument;
  return candidate && typeof candidate === 'object' && typeof candidate.scheme === 'string'
    ? (candidate as vscode.Uri)
    : undefined;
}

function errorBanner(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `<div class="md-error" role="alert">md: the renderer failed — ${escapeHTML(message)}</div>\n`;
}
