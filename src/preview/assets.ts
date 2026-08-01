//
//  assets.ts
//  md.vscode — where the vendored engines live, and how each side finds them.
//
//  This file is the single place that knows the on-disk layout of `media/`.
//  It is deliberately free of `import * as vscode`, and must stay that way,
//  for a reason that is easy to lose: `src/preview/md-preview.ts` is bundled
//  by esbuild with `platform: 'browser'`, so anything it imports is compiled
//  into the client script. The moment this module touches `vscode` — or
//  `node:path` — the client bundle stops building. Everything below is
//  therefore plain string algebra that runs correctly on both sides.
//
//  WHY THE HOST CANNOT SIMPLY EMIT ABSOLUTE URLS
//  ---------------------------------------------
//  In a webview we own, we would call `webview.asWebviewUri(...)` and write
//  the result straight into the markup. We do not own this one. Our HTML
//  reaches the built-in Markdown preview through `extendMarkdownIt`, which
//  runs in the extension host with no webview in scope, and the preview does
//  **not** rewrite arbitrary URLs in the HTML we hand it — its image renderer
//  only rewrites the `src` of image *tokens*, and we bypass the token
//  renderer entirely. A relative `src="media/rich/…"` would resolve against
//  the preview's synthetic document origin and 404, silently.
//
//  So the division of labour is:
//
//    * the HOST emits no engine URLs at all. The three engines that need a
//      URL in the apps (KaTeX, highlight.js, Graphviz) run in Node here and
//      arrive pre-rendered in the markup; the two that must run in the
//      browser (Mermaid, PlantUML) are injected by the client.
//    * the CLIENT derives its own base from its own `<script>` element's
//      `src`, which VS Code has already turned into a webview URI when it
//      injected the contributed preview script. `richBaseFromScriptUrl`
//      below is that derivation, shared by both sides so there is exactly one
//      definition of it.
//
//  Rule 128 of the port spec applies with full force: never a `<base href>`.
//  It would turn `href="#slug"` into a cross-document navigation and break
//  the one link kind the preview allows.
//

/** Extension-relative directory holding the vendored engines, byte-identical to `md/md/rich`. */
export const RICH_DIR = 'media/rich';

/** Extension-relative directory holding the client script and its stylesheet. */
export const PREVIEW_DIR = 'media/preview';

/**
 * The contributed preview script, exactly as spelled in `package.json`'s
 * `markdown.previewScripts`. Kept here so a test can assert that the manifest
 * and the code still agree about where the file is.
 */
export const PREVIEW_SCRIPT = 'media/preview/md-preview.js';

/**
 * The contributed stylesheets, in contribution order.
 *
 * `katex.min.css` is contributed rather than injected because VS Code resolves
 * a `markdown.previewStyles` path to a webview URI for us — and because that
 * keeps the stylesheet beside its own `fonts/` directory, which is the whole
 * of rule 129: KaTeX's `@font-face` rules reference `fonts/…` *relative to the
 * stylesheet*, so moving or inlining it costs every glyph.
 */
export const PREVIEW_STYLES: readonly string[] = [
  'media/preview/md-preview.css',
  'media/rich/katex.min.css',
];

/**
 * The two engines the client injects, by file name.
 *
 * Mermaid is here because it needs real text metrics — measured, not assumed:
 * under jsdom it lays a diagram out at `viewBox="-8 -8 30998 32"` with no
 * `<text>` at all. PlantUML is here because its TeaVM build measures with a
 * real `canvas.getContext('2d').measureText`, and a shim only approximates the
 * box sizes.
 *
 * `viz-global.js` is deliberately absent. Graphviz is WebAssembly, and the
 * built-in preview's `script-src` is `'nonce-…'` and nothing else — no
 * `'wasm-unsafe-eval'` — so `WebAssembly.instantiate` throws a `CompileError`
 * there. Graphviz therefore runs in the extension host and arrives as finished
 * SVG. (An older reading of the sources held that PlantUML needs the global
 * `Viz` for its class and activity layouts; measurement of the shipped bundle
 * shows it uses its own Smetana layout instead, so it stands alone here.)
 */
export const RICH_ENGINE_FILES = {
  mermaid: 'mermaid.min.js',
  plantuml: 'plantuml.js',
} as const;

/**
 * The absolute filesystem path of `media/rich`, given the extension root.
 *
 * This is what `setRichRoot` wants on activation. Named `richDirectory` rather
 * than `richRoot` on purpose: `src/engines/paths.ts` already exports a no-
 * argument `richRoot()` that reads the value back, and two functions of the
 * same name on opposite sides of the same handshake is a reader's trap.
 *
 * Joined with `/` rather than `path.join`, both because this module may not
 * import Node built-ins (see the header) and because Windows accepts a forward
 * slash everywhere it accepts a backslash — `C:\…\md.vscode/media/rich` opens
 * perfectly well.
 */
export function richDirectory(extensionRoot: string): string {
  return `${withoutTrailingSlash(extensionRoot)}/${RICH_DIR}`;
}

/**
 * Derive the webview URI of `media/rich/` from the client script's own URL.
 *
 * The client script is served from `…/media/preview/md-preview.js`, so the
 * engines are two segments up and one across. Doing it this way rather than
 * having the host pass a base string down means the two sides cannot drift:
 * whatever origin, path prefix or cache-busting query VS Code chose for the
 * contributed script, the engines are found beside it.
 *
 * Returns `null` when the URL is not shaped as expected, rather than guessing.
 * A wrong base fails as an opaque network error tens of seconds later, in the
 * middle of a diagram; a `null` lets the caller say so immediately.
 */
export function richBaseFromScriptUrl(scriptUrl: string): string | null {
  // Strip any query or fragment first: they are not part of the path, and
  // `lastIndexOf('/')` would happily find a slash inside one.
  const queryOrHash = scriptUrl.search(/[?#]/);
  const clean = queryOrHash < 0 ? scriptUrl : scriptUrl.slice(0, queryOrHash);

  const fileSlash = clean.lastIndexOf('/');
  if (fileSlash <= 0) return null;
  const previewDir = clean.slice(0, fileSlash); //  …/media/preview

  const dirSlash = previewDir.lastIndexOf('/');
  if (dirSlash <= 0) return null;
  const mediaDir = previewDir.slice(0, dirSlash); //  …/media

  return `${mediaDir}/rich/`;
}

/**
 * The webview URL of one vendored engine, derived from the client script's URL.
 *
 * `file` is a bare name from {@link RICH_ENGINE_FILES}; nothing here accepts a
 * path, because nothing outside `media/rich` may be loaded this way.
 */
export function richAssetUrl(scriptUrl: string, file: string): string | null {
  const base = richBaseFromScriptUrl(scriptUrl);
  return base === null ? null : base + file;
}

function withoutTrailingSlash(p: string): string {
  return p.endsWith('/') || p.endsWith('\\') ? p.slice(0, -1) : p;
}
