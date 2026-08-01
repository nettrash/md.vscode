//
//  md-preview.ts
//  md.vscode — the client half of the preview, bundled to
//  `media/preview/md-preview.js` and contributed through
//  `markdown.previewScripts`.
//
//  This is the fourth copy of `md/md/rich/md-init.js`'s orchestration, and the
//  first one that does not get to run all five engines. md's own preview is a
//  WebView the app owns end to end: it stands up a private origin, sets its own
//  policy, loads every engine and re-runs the whole page on each edit. Here VS
//  Code owns the shell, and its Strict (default) policy is
//
//      default-src 'none'; script-src 'nonce-…';
//
//  with no `'wasm-unsafe-eval'`, no `connect-src` and no `frame-src`. Measured
//  in real Chromium against that exact string (specs/12-CSP-GROUND-TRUTH.md),
//  the facts this file is built on are:
//
//    * `document.currentScript.nonce` is readable — it is the only key we have;
//    * an injected `<script nonce=N src=…>` runs, and the same tag without the
//      nonce is blocked, so the policy really is live;
//    * `import()` from inside a nonce'd classic script is allowed: the nonce
//      propagates, so md-init's `import('./plantuml.js')` pattern works
//      verbatim;
//    * `canvas.getContext('2d').measureText()` works — which is the whole
//      reason PlantUML belongs on this side;
//    * WebAssembly is BLOCKED, both `instantiate` and the sync constructor.
//
//  So the five phases are split:
//
//    KaTeX + mhchem, highlight.js, Graphviz   → the extension host (Node).
//        All three have pure string APIs there, and Graphviz *must* be there:
//        `viz-global.js` compiles WebAssembly, which this page cannot do and
//        cannot delegate to an iframe either (no `frame-src`, and `default-src
//        'none'` covers frames). By the time the markup reaches us, formulas
//        are KaTeX markup, code is `hljs` spans and every `div.graphviz` holds
//        an inline `<svg>`. There is nothing left here to do for them, and
//        NOTHING in this file may reach for `viz-global.js`.
//
//    Mermaid, PlantUML                        → here.
//        Mermaid needs real text metrics; headless it lays a diagram out at
//        `viewBox="-8 -8 30998 32"` with no `<text>` at all. PlantUML needs a
//        real `measureText` for its box sizes. Both are pure JavaScript, so the
//        nonce covers them.
//
//  Consequences of the split that are visible to a reader of the page:
//
//    * PlantUML's Graphviz-backed layouts (class, activity, state, component)
//      call the global `Viz` from inside the TeaVM engine. That global cannot
//      exist here, so those diagrams never produce an SVG: they exhaust the
//      20 s budget and fall back to their source text, exactly as a failed
//      diagram does in the apps. Sequence, mindmap, gantt and json diagrams use
//      PlantUML's own Smetana layout and are unaffected. This is a property of
//      the built-in preview's policy, not something to work around here.
//    * Byte parity lives in the *export* path, which we generate ourselves.
//      What this file owes is visual parity inside a shell VS Code owns.
//
//  House rules for this file, each learned the hard way:
//
//    * No imports at module scope. This bundles to an IIFE that must run with
//      nothing else loaded; the only way to get anything else is the nonce.
//    * Never call `acquireVsCodeApi()`. It may be called once per webview and
//      the preview's own `index.js` has already called it — a second call
//      throws and takes VS Code's preview down with it.
//    * Never use a relative URL. The preview's `<head>` carries
//      `<base href="…the Markdown document's URI…">`, so a relative specifier
//      resolves next to the user's document, not next to our assets. Everything
//      is resolved against `document.currentScript.src` instead.
//    * Never throw out of the top level. A failed engine must leave the block's
//      source visible and the rest of the page alone.
//

// ---------------------------------------------------------------------------
//  MARK: - Bootstrap
// ---------------------------------------------------------------------------

/**
 * Our own `<script>` element, captured synchronously.
 *
 * VS Code emits contributed preview scripts as
 * `<script async src="…" nonce="…" charset="UTF-8">` at the end of `<body>`.
 * `document.currentScript` is set for a classic script while it executes —
 * including an `async` one — and this is the only moment it is readable, so it
 * is read at module evaluation time and never again.
 *
 * The `querySelector` fallback exists for one specific accident: declaring the
 * contribution as `{ path, type: "module" }` in package.json would make
 * `currentScript` null inside the module and silently cost us both the nonce
 * and the base URI. Keep the contribution a plain string path; the fallback is
 * insurance, not a licence to change it.
 */
const ownScript: HTMLScriptElement | null =
  (document.currentScript as HTMLScriptElement | null) ??
  document.querySelector<HTMLScriptElement>('script[src*="md-preview.js"]');

/**
 * The nonce this page will accept on injected scripts.
 *
 * Read from the IDL property rather than the attribute: Chromium hides the
 * `nonce` *content attribute* from `getAttribute()` once the element is
 * parsed (so that a CSS attribute selector cannot exfiltrate it), while the
 * property keeps the value. The `getAttribute` branch is only a fallback for
 * engines that never implemented the hiding.
 */
const NONCE: string = ownScript ? ownScript.nonce || ownScript.getAttribute('nonce') || '' : '';

/**
 * `…/media/rich/`, absolute, with a trailing slash — or `''` if we could not
 * work out where we are, in which case this file does nothing at all.
 *
 * Derived from our own `src` because there is no other way to learn an
 * extension's webview URI from inside the built-in preview: no
 * `acquireVsCodeApi` state, no `import.meta`, and the `<base href>` points
 * somewhere else entirely.
 */
const RICH: string = ownScript ? new URL('../rich/', ownScript.src).href : '';

// ---------------------------------------------------------------------------
//  MARK: - Constants
// ---------------------------------------------------------------------------

/**
 * How long to wait for the DOM to settle before rendering.
 *
 * One preview update produces a burst of signals — the body's child list
 * changes, `vscode.markdown.updateContent` fires, and Mermaid's own measuring
 * node comes and goes — and each of them lands within a few milliseconds of the
 * others. This coalesces the burst into one pass. It is deliberately much
 * shorter than the apps' 350 ms reload debounce: the host has already debounced
 * the *content*, and by the time we are called the text is on screen; only the
 * diagrams are outstanding.
 */
const COALESCE_MS = 150;

/** `waitForSvg`'s poll interval, verbatim from `md-init.js`. */
const POLL_MS = 80;

/**
 * Per-block PlantUML budget, verbatim from `md-init.js`: "Graphviz-backed
 * diagrams (class/activity/…) are slow; give them room."
 */
const PLANTUML_TIMEOUT_MS = 20000;

/**
 * How many rendered diagrams to remember. See {@link cache} — the entries are
 * SVG strings, so this is the one structure here that can grow without bound if
 * left alone, and typing inside a diagram mints a new key per keystroke.
 */
const CACHE_LIMIT = 32;

/** Marks a block this file has finished with. See {@link markerFor}. */
const MARKER = 'data-md-rendered';

/**
 * Carries a block's own source, base64-encoded, written by the host.
 *
 * See {@link sourceOf} for why the DOM cannot be asked instead. The emitter is
 * `withDiagramSources` in `render/html.ts`, behind `opts.diagramSources`; the
 * two names have to move together.
 */
const SOURCE_ATTRIBUTE = 'data-md-src';

/**
 * The cache key's field separator: NUL.
 *
 * A character no diagram source can contain, which is what stops a key from
 * being ambiguous about where the theme ends and the kind begins.
 *
 * Written as an escape, and it must stay one. As a *literal* NUL — which is how
 * it was first written, twice, inside these string literals — it makes the whole
 * file register as binary: `grep` silently finds nothing in it and `file`
 * reports "data". The character is identical either way; only the file is
 * readable.
 */
const SEPARATOR = '\u0000';

// ---------------------------------------------------------------------------
//  MARK: - Engine surfaces
// ---------------------------------------------------------------------------

/**
 * The three configuration keys md passes Mermaid — and only those three.
 * `securityLevel: 'strict'` is already Mermaid's default; the apps state it
 * explicitly, so we do too.
 */
interface MermaidConfig {
  startOnLoad: boolean;
  theme: 'dark' | 'default';
  securityLevel: 'strict';
}

interface MermaidApi {
  /** The module-level flag Mermaid's own `load` listener reads. */
  startOnLoad?: boolean;
  initialize(config: MermaidConfig): void;
  run(options: { nodes: ArrayLike<Element> }): Promise<void>;
}

/**
 * `plantuml.js` is a real ES module whose last line is
 * `export{C as render,D as renderToString}`.
 *
 * `render` returns `undefined`, not a promise: it parks the request in a single
 * set of module-level slots and kicks a `setTimeout`-driven TeaVM scheduler,
 * which later resolves the element **by id** and fills it in. Two consequences
 * are load-bearing and appear again below: the target must have an id, and two
 * overlapping calls clobber one another.
 */
type PlantUmlRender = (lines: string[], elementId: string, opts: { dark: boolean }) => void;

interface PlantUmlModule {
  render: PlantUmlRender;
}

function mermaidGlobal(): MermaidApi | undefined {
  return (globalThis as unknown as { mermaid?: MermaidApi }).mermaid;
}

// ---------------------------------------------------------------------------
//  MARK: - State
// ---------------------------------------------------------------------------

/**
 * Rendered SVG by `theme + kind + source`; `null` records a diagram that has
 * already refused once.
 *
 * This exists because of how VS Code updates the preview. The apps reload the
 * page on every edit, so each render is a fresh document; VS Code instead
 * morphs the new HTML over the old DOM, and a block holding an `<svg>` is never
 * equal to the freshly-rendered block holding its source text — so the morph
 * reverts every diagram on every keystroke. Without this cache a document with
 * one class diagram would spend twenty seconds re-failing after each character
 * typed anywhere in the file.
 *
 * Re-instating identical markup duplicates Mermaid's element ids when the same
 * diagram appears twice in a document (Mermaid runs with
 * `deterministicIds: false`, so the two blocks get different ids on their first
 * render and the *same* one from here afterwards). What the two blocks draw is
 * identical, so the duplication is invisible — but it is not harmless: morphdom
 * keys nodes by id, and a duplicate id is what makes it orphan one of the two
 * `<svg>`s inside its `<pre>` on the next edit. See {@link sourceOf}. Forcing
 * the ids apart would mean rewriting the SVG on every restore; being unable to
 * be fooled by an orphan is cheaper and covers more than this one cause.
 *
 * The key is built from the block's *declared* source — see {@link cacheKey} —
 * never from what the block currently contains, so a poisoned DOM cannot mint a
 * key or reach an entry.
 */
const cache = new Map<string, string | null>();

/**
 * Bumped by every render request. A pass carries the generation it was started
 * for and abandons itself the moment a newer one exists — which is what keeps
 * PlantUML's single-slot engine from being driven by two passes at once.
 */
let generation = 0;

/** Serialises passes; a pass never overlaps another. */
let queue: Promise<void> = Promise.resolve();

/** Pending `COALESCE_MS` timer, or 0. */
let coalesceTimer = 0;

/** A render was asked for before `load`; one listener is enough. */
let waitingForLoad = false;

/** Ids handed out to PlantUML blocks that had none. Never reused. */
let plantumlSeq = 0;

/**
 * The theme the current DOM is drawn for.
 *
 * Mutated **only** at the top of a pass, never from the observer that notices
 * the theme changed. Passes are serialised, so a cache key computed during one
 * always describes the diagrams that pass is drawing. Flipping this from the
 * observer instead would let a theme change land between Mermaid's `run()` and
 * the bookkeeping that follows it — filing a light diagram under the dark key,
 * and restoring the source of a block being rendered into.
 */
let dark = isDark();

// ---------------------------------------------------------------------------
//  MARK: - Theme
// ---------------------------------------------------------------------------

/**
 * VS Code stamps exactly one of `vscode-light`, `vscode-dark`,
 * `vscode-high-contrast` and `vscode-high-contrast-light` onto `<body>`, and
 * adds `vscode-high-contrast` alongside the light high-contrast class. It
 * mutates that class list **in place** when the colour theme changes — the page
 * is not reloaded — which is why the observer below watches it.
 *
 * The mapping is the family's: high contrast counts as dark, light high
 * contrast counts as light (`ColorThemeKind.HighContrast` → dark,
 * `HighContrastLight` → light).
 */
function isDark(): boolean {
  const classes = document.body.classList;
  if (classes.contains('vscode-high-contrast')) {
    return !classes.contains('vscode-high-contrast-light');
  }
  return classes.contains('vscode-dark');
}

// ---------------------------------------------------------------------------
//  MARK: - Loading engines under the nonce
// ---------------------------------------------------------------------------

/** In-flight or settled `<script>` injections, by URL. */
const scripts = new Map<string, Promise<void>>();

/**
 * Inject a classic script carrying our nonce, once per URL.
 *
 * The promise is cached including its *rejection*: an engine that failed to
 * load will fail the same way on every later pass, and retrying a 3.5 MB file
 * on each keystroke would be worse than the degradation. Callers treat a
 * rejection as "leave the source text visible".
 *
 * The nonce is set before insertion — the policy is checked when the element is
 * inserted, not when it is created — and set both ways: the content attribute
 * is what the check reads, the property is what a later reader would find.
 */
function loadScript(url: string): Promise<void> {
  const existing = scripts.get(url);
  if (existing) return existing;

  const started = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    if (NONCE) {
      el.setAttribute('nonce', NONCE);
      el.nonce = NONCE;
    }
    el.addEventListener('load', () => resolve());
    el.addEventListener('error', () => reject(new Error('md: could not load ' + url)));
    el.src = url;
    document.head.appendChild(el);
  });
  scripts.set(url, started);
  return started;
}

/** In-flight or settled PlantUML import. Cached for the same reason. */
let plantuml: Promise<PlantUmlModule> | null = null;

/**
 * Pull in the 7.4 MB TeaVM engine, once, and only when a `.plantuml` block
 * exists — the reason md's import is dynamic in the first place.
 *
 * The specifier must be the absolute URL built from our own `src`. A relative
 * one would resolve against the preview's `<base href>`, which points at the
 * Markdown document. The nonce propagates from this script into the import, so
 * the module loads under the same policy that let us run.
 */
function loadPlantUml(): Promise<PlantUmlModule> {
  if (!plantuml) {
    plantuml = import(RICH + 'plantuml.js') as Promise<PlantUmlModule>;
  }
  return plantuml;
}

// ---------------------------------------------------------------------------
//  MARK: - The rendered-diagram cache
// ---------------------------------------------------------------------------

function cacheKey(kind: string, source: string): string {
  return (dark ? 'd' : 'l') + SEPARATOR + kind + SEPARATOR + source;
}

function cachePut(key: string, value: string | null): void {
  // Delete before setting so a repeat entry moves to the end: Map iterates in
  // insertion order, which makes the eviction below least-recently-written.
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

// ---------------------------------------------------------------------------
//  MARK: - Block bookkeeping
// ---------------------------------------------------------------------------

/**
 * A block's own source, as the host declared it — or `null` if it did not.
 *
 * WHY THE DOM IS NOT ASKED
 * ------------------------
 * This used to read `el.textContent` and remember it in a `WeakMap`. Both halves
 * of that are unsound in a page that is patched rather than reloaded, and the
 * patching is morphdom's, with rules of its own:
 *
 *   * morphdom keys nodes by `id`. When it meets an old child it cannot
 *     reconcile with the new one it does **not** remove a keyed node — it
 *     records the key and resolves it once, at the very end, through a lookup
 *     holding only the *last* element seen with that key. Two elements sharing
 *     an id therefore leave one of them behind.
 *   * Two identical Mermaid diagrams in one document are served the same cached
 *     SVG, so both hold `<svg id="mermaid-…">` with the same id. The next edit
 *     orphans one of those SVGs *inside its own `<pre>`*, next to the restored
 *     source — and the attribute sync has already taken {@link MARKER} off, so
 *     nothing says the block was ever rendered.
 *
 * Reading `textContent` there yields the SVG's stylesheet followed by the real
 * source. Mermaid then draws "Syntax error in text" — it reads
 * `element.innerHTML`, so it is handed the `<svg>` element itself — and the
 * error box is cached under that nonsense key and marked as a success.
 *
 * An attribute the host wrote cannot be fooled by any of it: morphdom syncs
 * attributes from the new element, so `data-md-src` either survives unchanged or
 * is replaced by the new source, and is never a function of what the element
 * contains.
 *
 * THE FALLBACK, AND ITS CONDITION
 * -------------------------------
 * `previewBody` always sets the attribute, so in the shipping preview it is
 * always there. It can be absent only for a body this extension did not render —
 * and reading `textContent` there is not wrong in itself; it was wrong only for
 * a block that is holding something other than its own source.
 *
 * That condition is checkable, so it is checked rather than assumed: the host
 * escapes every diagram's source, so a container written by the host holds one
 * text node and nothing else. **An element child means somebody else has been in
 * there** — a rendered `<svg>`, an orphaned one, an error box — and the DOM has
 * stopped being evidence of what the author wrote. `null` then, and every caller
 * treats it as "leave this block exactly as it is", which is the honest answer:
 * whatever it is showing beats a diagram drawn from a guess.
 */
function sourceOf(el: Element): string | null {
  const encoded = el.getAttribute(SOURCE_ATTRIBUTE);
  if (encoded === null) {
    return el.firstElementChild === null ? (el.textContent ?? '') : null;
  }
  try {
    // `atob` yields one character per byte; the source is UTF-8, so the bytes
    // have to be handed to a decoder rather than used as text. Skipping that
    // step silently mangles every diagram with a non-ASCII label in it.
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
    return new TextDecoder().decode(bytes);
  } catch {
    // Not valid base64 — so not something this file wrote, and not something to
    // guess at either.
    return null;
  }
}

/**
 * Mark a block as dealt with, so a re-run neither re-renders nor clobbers it.
 *
 * The marker deliberately lives on the element rather than in a side table.
 * VS Code updates the preview with a morph, and the morph syncs attributes from
 * the freshly-rendered element — which has no marker — onto ours. So the marker
 * disappears at exactly the moment the rendered content it described is
 * reverted to source text, and the two can never disagree. A `WeakMap` would
 * survive the morph and quietly claim a block was rendered when it is showing
 * its own source again.
 */
function markerFor(el: Element, value: 'mermaid' | 'plantuml' | 'failed'): void {
  el.setAttribute(MARKER, value);
}

/**
 * Undo every *successful* render so the next pass can redraw it in the other
 * theme.
 *
 * Blocks marked `failed` are left alone: a diagram that refused to lay out will
 * refuse again, and retrying costs the full 20 s budget. Blocks that do not
 * declare a source are also left alone — restoring one would mean putting back
 * whatever the element currently says, which for a rendered block is its own
 * SVG.
 */
function resetRendered(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll(`[${MARKER}]`))) {
    const value = el.getAttribute(MARKER);
    if (value !== 'mermaid' && value !== 'plantuml') continue;
    const source = sourceOf(el);
    if (source === null) continue;
    el.textContent = source;
    // Mermaid skips any node carrying `data-processed`, so a re-run would
    // silently do nothing if this were left behind.
    el.removeAttribute('data-processed');
    el.removeAttribute(MARKER);
  }
}

// ---------------------------------------------------------------------------
//  MARK: - Mermaid
// ---------------------------------------------------------------------------

/**
 * Render every `pre.mermaid` block that still holds its source.
 *
 * Two departures from `md-init.js`, both forced by living in a page that is
 * never reloaded:
 *
 *  1. **The `startOnLoad` race is fixed here, not reproduced.** In the apps
 *     `mermaid.min.js` is a blocking `<head>` script, so it registers its own
 *     `window.addEventListener('load', …)` before md-init registers its. Its
 *     auto-run then claims the first block and snapshots the configuration
 *     *before* `initialize({theme:'dark'})` is called, so the first diagram of a
 *     dark document renders in the light theme, and the completion flag can be
 *     set while auto-run renders are still queued. We inject the engine
 *     ourselves and turn `startOnLoad` off in the microtask that follows its
 *     evaluation: the script element's own `load` event is fired in the same
 *     task that evaluated it, so the continuation below runs at that task's
 *     microtask checkpoint — before any *other* task, the window's `load`
 *     among them, can be dispatched. Both the module flag and the configuration
 *     key are set, because Mermaid's listener tests both.
 *  2. Blocks are marked from `data-processed`, which Mermaid stamps on every
 *     node it claims — including one it turns into its own error box. Mermaid's
 *     failure mode is that error box, not a restored source, and marking from
 *     its own bookkeeping keeps the two in step.
 */
async function renderMermaid(gen: number, root: ParentNode): Promise<void> {
  // Tag-qualified, like the export paths' `pre.mermaid, div.plantuml,
  // div.graphviz` and unlike md-init's bare `.mermaid`. The host emits
  // `<pre class="mermaid">` and nothing else can: author HTML is escaped, never
  // passed through. Keeping one selector shape across the port means one thing
  // to reason about when a container ever changes.
  const pending = Array.from(root.querySelectorAll<HTMLElement>(`pre.mermaid:not([${MARKER}])`));
  if (!pending.length) return;

  // Anything the cache can answer needs no engine at all, and a document whose
  // diagrams are all cached never pays the 3.5 MB.
  //
  // The source travels alongside the element from here on. Re-reading it later
  // would be re-reading the DOM, which is the whole thing this is avoiding, and
  // it would also be *wrong*: the block is about to be filled with an SVG.
  const fresh: { el: HTMLElement; source: string }[] = [];
  for (const el of pending) {
    const source = sourceOf(el);
    // A block that does not declare its source is one this file cannot reason
    // about. Leave it exactly as it is: whatever it is showing, that is more
    // honest than a diagram drawn from a guess.
    if (source === null) continue;
    const cached = cache.get(cacheKey('mermaid', source));
    if (typeof cached === 'string') {
      el.innerHTML = cached;
      markerFor(el, 'mermaid');
    } else {
      fresh.push({ el, source });
    }
  }
  if (!fresh.length) return;

  try {
    await loadScript(RICH + 'mermaid.min.js');
  } catch {
    return; // The blocks keep their source text.
  }
  if (gen !== generation) return;

  const mermaid = mermaidGlobal();
  if (!mermaid) return;

  // THE BLOCK IS PUT BACK TO ITS DECLARED SOURCE BEFORE THE ENGINE SEES IT.
  //
  // Mermaid reads `element.innerHTML` — not `textContent` — decodes the entities
  // and parses the result. So whatever else is sitting in the block goes into
  // the diagram: an `<svg>` orphaned there by a morph (see {@link sourceOf}) is
  // handed straight back to the engine that drew it, and Mermaid renders
  // "Syntax error in text" over the top of it.
  //
  // Writing the source back costs one text node per block per pass and makes
  // that impossible to arrange, whatever the host has done to the page. It is
  // also what makes the redraw use the source the *document* now has rather
  // than whatever the element happens to be showing.
  for (const block of fresh) block.el.textContent = block.source;

  try {
    mermaid.startOnLoad = false;
    mermaid.initialize({
      startOnLoad: false,
      theme: dark ? 'dark' : 'default',
      securityLevel: 'strict',
    });
    // One try/catch around the whole run, as in md: Mermaid annotates a failing
    // block with its own error box, so there is nothing per-block to rescue.
    //
    // md hands `run()` the live NodeList of every `.mermaid` on the page; we
    // hand it the array of blocks that still hold their source. Mermaid does
    // `Array.from(nodes)` either way, and it would skip the rendered ones
    // anyway (they carry `data-processed`) — but being explicit is what stops a
    // second pass from reaching into a diagram it already drew.
    await mermaid.run({ nodes: fresh.map((block) => block.el) });
  } catch {
    /* handled by Mermaid, in the block itself */
  }

  for (const block of fresh) {
    const el = block.el;
    if (!el.hasAttribute('data-processed') && !el.querySelector('svg')) continue;
    markerFor(el, 'mermaid');
    cachePut(cacheKey('mermaid', block.source), el.innerHTML);
  }
}

// ---------------------------------------------------------------------------
//  MARK: - PlantUML
// ---------------------------------------------------------------------------

/**
 * `md-init.js`'s poll, unchanged: 80 ms, never rejects, and the timeout is
 * tested *after* the SVG so a synchronously-produced diagram resolves at once.
 * The comparison is `>` rather than `>=`, so the effective budget is the
 * timeout plus up to one tick — reproduced rather than tidied.
 *
 * It is the only way to know a render finished: `render()` offers no completion
 * callback.
 */
function waitForSvg(el: Element, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const start = Date.now();
    (function poll(): void {
      if (el.querySelector('svg')) {
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve(false);
        return;
      }
      window.setTimeout(poll, POLL_MS);
    })();
  });
}

/**
 * Give a block an id, because `render()` addresses its target by id string and
 * silently does nothing when `getElementById` returns null.
 *
 * An author-supplied id is respected, as in md. Unlike md, the counter is
 * monotonic across the life of the page and the id is checked for collisions:
 * md re-numbers from zero on every render because every render is a fresh
 * document, whereas here a `md-puml-0` from an earlier pass may still be in the
 * DOM — and `getElementById` returns the *first* match, so a duplicate would
 * quietly draw one block's diagram into another.
 */
function assignPlantUmlId(el: HTMLElement): void {
  if (el.id) return;
  let id = '';
  do {
    id = 'md-puml-' + plantumlSeq++;
  } while (document.getElementById(id));
  el.id = id;
}

/**
 * Render every `div.plantuml` block, strictly one at a time.
 *
 * Sequential is not a style preference. The engine passes a request through a
 * single set of module-level slots which its worker coroutine reads and nulls;
 * a second `render()` issued before the worker has consumed the first
 * overwrites them, and the first diagram's source and target are simply lost —
 * or worse, the first diagram's SVG lands in the second block. Nothing throws.
 *
 * The generation check sits at the top of the loop, never inside a block's
 * wait: abandoning a pass mid-render would leave a request in those slots for
 * the next pass to trample. Waiting for the current block to settle first
 * leaves the engine idle.
 */
async function renderPlantUml(gen: number, root: ParentNode): Promise<void> {
  const pending = Array.from(root.querySelectorAll<HTMLElement>(`div.plantuml:not([${MARKER}])`));
  if (!pending.length) return;

  // Same shape as Mermaid's, and for the same reason: the source rides along
  // with the element rather than being read back out of it later. PlantUML is
  // handed a `string[]` rather than an element, so it cannot be fed an orphaned
  // `<svg>` the way Mermaid can — but the *cache key* is built from the same
  // text, and a key computed from a poisoned DOM would file the diagram under a
  // name nothing will ever look up again.
  const fresh: { el: HTMLElement; source: string }[] = [];
  for (const el of pending) {
    const source = sourceOf(el);
    if (source === null) continue;
    const cached = cache.get(cacheKey('plantuml', source));
    if (typeof cached === 'string') {
      el.innerHTML = cached;
      markerFor(el, 'plantuml');
    } else if (cached === null) {
      // Already refused once, in this theme, for this source: leave the source
      // text on screen rather than spending the budget to fail again.
      markerFor(el, 'failed');
    } else {
      fresh.push({ el, source });
    }
  }
  if (!fresh.length) return;

  let render: PlantUmlRender;
  try {
    ({ render } = await loadPlantUml());
  } catch {
    return; // Leave the raw source visible if the engine cannot load.
  }

  for (const block of fresh) {
    const el = block.el;
    if (gen !== generation) return;
    // A morph may have taken the block out of the document while we were
    // waiting; the engine would not find it, and we would burn 20 s learning so.
    if (!el.isConnected) continue;

    assignPlantUmlId(el);
    const source = block.source;
    // The engine wants an array of lines, split on bare "\n" — the host has
    // already normalised line endings.
    const lines = source.split('\n');
    const key = cacheKey('plantuml', source);
    // Cleared *before* the render, as in md. The engine clears the element
    // itself, so this is belt and braces; what it costs is a moment of blank
    // block, which is why the restore below matters.
    el.textContent = '';
    try {
      // `dark` must be a real boolean: the engine tests `opts.dark === true`,
      // so `{dark: 1}` would silently render light.
      render(lines, el.id, { dark });
      const ok = await waitForSvg(el, PLANTUML_TIMEOUT_MS);
      // The double check is deliberate: the poll may have timed out on the very
      // tick the SVG appeared. A failed or timed-out render must never leave the
      // block blank.
      if (!ok && !el.querySelector('svg')) {
        el.textContent = lines.join('\n');
        markerFor(el, 'failed');
        cachePut(key, null);
      } else {
        markerFor(el, 'plantuml');
        cachePut(key, el.innerHTML);
      }
    } catch {
      el.textContent = lines.join('\n');
      markerFor(el, 'failed');
      cachePut(key, null);
    }
  }
}

// ---------------------------------------------------------------------------
//  MARK: - The pass
// ---------------------------------------------------------------------------

/**
 * One render pass over the current content.
 *
 * Mermaid before PlantUML, as in md: cheapest first, so the page becomes
 * legible while the slow engine works. There is no math, highlight or Graphviz
 * phase — all three arrived finished from the extension host.
 */
async function pass(gen: number): Promise<void> {
  if (gen !== generation) return;
  if (!RICH) return;

  // VS Code wraps the rendered document in `.markdown-body`. Falling back to
  // `<body>` keeps us working if that class is ever renamed; scoping to it when
  // it exists keeps us off the preview's own furniture.
  const root: ParentNode = document.querySelector('.markdown-body') ?? document.body;

  // The theme switch is handled here, inside the queue, where no render is in
  // flight. VS Code mutates the body class in place rather than reloading, so
  // the diagrams already on screen are the only record of the old theme.
  const nowDark = isDark();
  if (nowDark !== dark) {
    dark = nowDark;
    resetRendered(root);
  }

  // The family's completion contract: the capture paths poll
  // `<html data-md-render-complete="1">`. Nothing in the built-in preview
  // listens for it today, but keeping it truthful costs two lines and makes the
  // page testable from outside.
  document.documentElement.removeAttribute('data-md-render-complete');

  await renderMermaid(gen, root);
  if (gen !== generation) return;
  await renderPlantUml(gen, root);
  if (gen !== generation) return;

  document.documentElement.setAttribute('data-md-render-complete', '1');
}

/**
 * Request a pass. Every path into rendering goes through here.
 *
 * Nothing renders before `load`, which is md-init's rule and its reason:
 * fonts and images must have settled before a diagram engine measures text,
 * and both of these measure text for a living. `DOMContentLoaded` is not good
 * enough — the preview's own script appends the first content then, with the
 * stylesheets still in flight.
 *
 * The generation is bumped when the pass is actually queued rather than when it
 * is scheduled, so a burst of signals produces one pass rather than one
 * abandoned pass per signal. Errors are swallowed at the tail of the chain: an
 * unhandled rejection here would leave `queue` rejected and stop the preview
 * updating for the rest of the session.
 */
function schedule(): void {
  if (document.readyState !== 'complete') {
    if (!waitingForLoad) {
      waitingForLoad = true;
      window.addEventListener(
        'load',
        () => {
          waitingForLoad = false;
          schedule();
        },
        { once: true },
      );
    }
    return;
  }
  if (coalesceTimer) window.clearTimeout(coalesceTimer);
  coalesceTimer = window.setTimeout(() => {
    coalesceTimer = 0;
    const gen = ++generation;
    queue = queue.then(() => pass(gen)).catch(() => undefined);
  }, COALESCE_MS);
}

/**
 * Notice a theme change; the redraw itself belongs to {@link pass}.
 *
 * The class list is rewritten wholesale on every theme *and* on unrelated
 * changes (reduced motion, screen-reader mode), so the comparison against the
 * theme we drew for is what keeps this from scheduling passes for nothing.
 */
function themeChanged(): void {
  if (isDark() !== dark) schedule();
}

// ---------------------------------------------------------------------------
//  MARK: - Wiring
// ---------------------------------------------------------------------------

/**
 * The built-in preview replaces the content of `<body>` on every update without
 * reloading the page, in one of two shapes:
 *
 *   * a different document — the whole `.markdown-body` element is replaced,
 *     which is a child-list change on `<body>`;
 *   * the same document edited — the new HTML is *morphed* over the existing
 *     `.markdown-body`, which touches nothing at body level but does dispatch
 *     `vscode.markdown.updateContent` on `window` afterwards.
 *
 * Both are covered below, and the initial content — appended by the preview's
 * own script, with no event of any kind — is covered by the first shape.
 *
 * The observer is deliberately **not** `subtree: true`. Everything this file
 * does happens inside `.markdown-body`, so a subtree observer would watch
 * itself work, and Mermaid's temporary measuring node (appended to `<body>` and
 * removed again) would feed it too. Watching only the body's own children and
 * its class attribute means no signal we generate can come back to us.
 */
if (RICH) {
  const observer = new MutationObserver((records) => {
    let content = false;
    let theme = false;
    for (const record of records) {
      if (record.type === 'attributes') theme = true;
      else content = true;
    }
    if (theme) themeChanged();
    if (content) schedule();
  });
  observer.observe(document.body, {
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  window.addEventListener('vscode.markdown.updateContent', () => schedule());

  // The content may already be in place: this script is injected `async`, so it
  // can just as easily run after the preview's own script as before it.
  // `schedule` holds the first pass back until `load` on its own.
  schedule();
} else {
  // No `src` to derive from means no nonce and no asset base: there is nothing
  // safe to do, and every diagram keeps its source text. Say so once — the
  // preview's console is forwarded to the developer tools.
  console.warn('md: could not locate the preview script; diagrams will show their source.');
}

// This file is a module only so that its top-level declarations do not land in
// the page's global scope, where they would collide with the DOM's own names.
// esbuild erases the marker when it wraps the bundle in an IIFE.
export {};
