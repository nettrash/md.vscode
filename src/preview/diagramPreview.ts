//
//  diagramPreview.ts
//  md.vscode — the live preview panel for a standalone `.puml` / `.gv` file.
//
//  WHAT THIS IS, AND WHY IT IS NOT AN EXPORT
//  -----------------------------------------
//  Everything else that opens a webview here does it to *take something out* —
//  an SVG, a self-contained page, a set of PNGs — and disposes the panel the
//  moment it has it. This one is the opposite: the panel is the deliverable. It
//  stays open, follows the file as it is typed, follows the workbench theme, and
//  is closed only when the author closes it.
//
//  It exists because a `.puml` or `.gv` file is not Markdown and so never
//  reaches the built-in Markdown preview at all. `renderBody` already knows what
//  to do with one — `isRawPlantUML` / `isRawGraphviz` recognise a bare diagram
//  document and emit a single `.plantuml` / `.graphviz` container instead of
//  parsing the file as prose — so what this file owes is the surface, not the
//  rendering.
//
//  THE SURFACE IS RenderHost'S, NOT A SECOND ONE
//  ---------------------------------------------
//  The page shape comes from `instrument()` in `../export/renderHost`: the same
//  `default-src 'none'` CSP with `'wasm-unsafe-eval'` (Viz.js *is* WebAssembly,
//  which the built-in preview's policy forbids and this one permits), the same
//  rewrite of `"rich/` to webview URIs so md-init.js's dynamic
//  `import('./plantuml.js')` resolves, and the same capture client — whose
//  `{type:'ready'}` message, sent when md-init.js raises
//  `data-md-render-complete`, is exactly the "this render has finished" signal
//  the debounce below needs. What is *not* shared is `RenderHost` itself: it
//  owns a panel per call and disposes it after one capture, which is the right
//  shape for an export and the wrong one for a panel that has to live.
//
//  That is why this file reaches sideways into `src/export` for `instrument`.
//  The layering rule points the other way, and the alternative was a second copy
//  of the CSP string and the URL rebase — two things that must never drift apart
//  and would have had no reason not to. `instrument` builds a page; it is only
//  filed under `export/` because until now every page we built was one.
//
//  THE DOCUMENT IS ASSEMBLED HERE, AND THE PALETTE IS THE EDITOR'S
//  --------------------------------------------------------------
//  This panel used to call `renderDocument`, which is the *apps'* page: its
//  `<head>` carries `src/render/css-text.ts`, md's product identity, and the
//  panel showed that page entire — nothing appended, nothing overridden.
//  Reported as "diagram preview looks old like the md app".
//
//  Measured against the call the shipping panel actually made, which was
//  `renderDocument(text, { title, dark: false, export: true })`:
//
//    * the frame rule was `html, body { background: #FFFFFF; }`. Note the
//      colour: NOT the cream `#F4EFE2` that sheet draws on screen. `export:
//      true` selects md's *print* palette, so a reader in a dark workbench was
//      handed a sheet of hard white — which is the complaint, and rather worse
//      than paper cream would have been.
//    * the ink was `#2B2620` and the face American Typewriter, on a page whose
//      every other colour was md's too.
//    * `dark` was hard-coded `false`, so the page carried
//      `<body data-md-dark="0">` whatever the workbench was set to. That
//      attribute is the only channel to the engines — see below — so PlantUML
//      and Mermaid *also* drew light diagrams into a dark editor. Passing the
//      workbench's own polarity is one half of the fix; the stylesheet is the
//      other.
//
//  If you are checking these figures, check them against `css(false, true)`.
//  The cream `#F4EFE2` and the carbon `#241E18` are real, and they are what the
//  Markdown preview's sheet still ladders between, but neither was ever on this
//  panel: reading them off `css(false, false)` and attributing them here is the
//  mistake this paragraph was written to correct.
//
//  A webview of our own is the one place in this extension where that is
//  trivially fixable, because we own the whole page: `renderBody` gives us md's
//  markup without md's sheet, `diagramDocument` below puts a skeleton of our own
//  around it, and every `--vscode-*` colour is available to style it with. The
//  Markdown preview reaches the same place by a much longer road — it does not
//  own its `<body>`, so it remaps a palette through a wrapper element — but the
//  variables and the ladders are the same ones, and `media/preview/md-preview.css`
//  is the file to keep this consistent with.
//
//  What did NOT move into CSS: the diagram engines' own colours. PlantUML takes
//  a light/dark flag through `data-md-dark`, Mermaid reads the same attribute,
//  and Graphviz draws in plain black and is recoloured here by rule. Nothing is
//  ever passed *into* Graphviz, because a colour or a `fontname` handed to the
//  engine changes the metrics it lays the graph out with — the label positions
//  would move on a change of theme.
//
//  WHY A RE-RENDER IS A WHOLE PAGE RELOAD
//  --------------------------------------
//  Assigning `webview.html` tears the document down and builds a new one. That
//  is deliberate and it is what the three apps do: md's WKWebView reloads on
//  every edit behind its own 350 ms debounce, and md-init.js is written for a
//  page that runs once. The alternative — keeping the page and re-driving the
//  engines from a message — would be a fourth copy of md-init's orchestration
//  (there are already three), and it would have to reproduce PlantUML's
//  single-slot bookkeeping by hand. A reload gets that for free: the old
//  JavaScript realm, and every module-level slot in it, goes away with the old
//  document.
//
//  What a reload does cost is real, though — up to 7.4 MB of PlantUML parsed
//  again — which is why the debounce is 300 ms rather than a keystroke, why a
//  reload never starts while one is still in flight, and why an edit that leaves
//  the rendered document byte-identical does not reload at all.
//

import * as path from 'node:path';
import * as vscode from 'vscode';

import { richRoot } from '../engines/paths';
import { instrument, makeNonce } from '../export/renderHost';
import type { EngineNeeds } from '../render/html';
import { renderBody, isRawGraphviz, isRawPlantUML } from '../render/html';
import { escapeHTML } from '../render/inline';
import { isDarkTheme } from './config';

/**
 * How long the typing has to stop before the page is rebuilt.
 *
 * md's own preview waits 350 ms; 300 is the same order and the same reasoning.
 * A PlantUML render is not cheap — the engine is imported, the diagram is laid
 * out, and a Graphviz-backed layout is given twenty seconds before it is
 * abandoned — so re-rendering per keystroke would mean a panel permanently one
 * edit behind the file.
 */
const DEBOUNCE_MS = 300;

/**
 * How long to wait for the page to say it has finished before allowing the next
 * reload anyway.
 *
 * md-init.js gives *each* PlantUML block 20 s and then raises the completion
 * flag regardless, and a standalone file is exactly one block — so in practice
 * the handshake always arrives well inside this. The cap is only here so that a
 * page which somehow never runs its scripts cannot wedge the preview shut for
 * the rest of the session.
 */
const SETTLE_TIMEOUT_MS = 45_000;

/** Panels by `document.uri.toString()`. One per document, reused. */
const panels = new Map<string, DiagramPreview>();

/**
 * Wire up the shared listeners and make sure the panels die with the extension.
 *
 * One pair of listeners for every panel rather than a pair per panel: both
 * events are cheap to dispatch and hard to unsubscribe correctly from inside a
 * panel that may be disposed at any moment, and a single map lookup on the
 * document URI is the whole of the routing.
 */
export function registerDiagramPreviews(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      // `onDidChangeTextDocument` also fires with an empty change list — a
      // dirty-flag flip, a language change — and rebuilding a 7 MB page for one
      // of those would be pure waste.
      if (event.contentChanges.length === 0) return;
      panels.get(event.document.uri.toString())?.documentChanged(event.document);
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      // The page's own colours no longer need this: they are `--vscode-*`
      // variables, which the webview host rewrites on `<html>` the moment the
      // workbench theme changes, so the frame, the status line and the Graphviz
      // ink all follow with no help from us.
      //
      // The *engines* still do. `data-md-dark` is baked into the `<body>` tag,
      // and it is what picks PlantUML's dark flag and Mermaid's theme (the CSS
      // never decides that, on any platform); a diagram already drawn has its
      // colours inside the SVG the engine emitted. There is no live channel for
      // either, so a theme flip still has to become a re-render or a light
      // PlantUML diagram sits in a dark panel until the next keystroke.
      for (const preview of panels.values()) preview.themeChanged();
    }),
    // `context.subscriptions` is disposed on deactivation, so this is what
    // guarantees no panel outlives us. A leaked one holds a Chromium context
    // with up to 11 MB of engines in it.
    { dispose: disposeDiagramPreviews },
  );
}

/**
 * Show `document` in its diagram panel, opening one if it has none.
 *
 * Synchronous on purpose. There is nothing here worth awaiting — the panel
 * reports its own progress in its own status line — and an awaited command that
 * sits silently for the twenty seconds a class diagram can take reads as a
 * broken command.
 */
export function openDiagramPreview(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  const existing = panels.get(key);
  if (existing !== undefined) {
    // Reveal, and nothing else: the panel is already live, so it is already
    // showing this text in this theme. Re-rendering here would only throw away
    // a finished diagram and make the command feel slow every second time.
    existing.reveal(document);
    return;
  }

  const preview = new DiagramPreview(document, key);
  panels.set(key, preview);
  preview.refresh();
}

/** Close every panel. Idempotent; called on deactivation and safe to call twice. */
export function disposeDiagramPreviews(): void {
  // Over a copy: `dispose()` removes the entry through the panel's own
  // `onDidDispose`, and mutating the map while iterating it would skip panels.
  for (const preview of Array.from(panels.values())) preview.dispose();
  panels.clear();
}

// MARK: - One panel

/** Which container the file produced, and therefore which engine will draw it. */
type DiagramKind = 'plantuml' | 'graphviz' | null;

class DiagramPreview {
  private readonly panel: vscode.WebviewPanel;
  private readonly key: string;
  private document: vscode.TextDocument;

  /** Pending debounce timer, or undefined. */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** True between assigning `webview.html` and the page saying it has settled. */
  private rendering = false;
  /** A render was asked for while one was in flight; run again when it lands. */
  private dirty = false;
  private disposed = false;
  /** Resolves the current in-flight wait. See {@link settled}. */
  private settle: (() => void) | undefined;
  /**
   * The last document handed to the webview, before instrumentation.
   *
   * Compared before the nonce and the chrome are added, because both change on
   * every call and would make every comparison unequal. What this catches is the
   * common editing case that changes nothing visible — a trailing space, an
   * edit typed and undone — where a reload would cost the whole engine load for
   * an identical picture.
   */
  private lastDocument = '';

  constructor(document: vscode.TextDocument, key: string) {
    this.document = document;
    this.key = key;

    this.panel = vscode.window.createWebviewPanel(
      'md.diagramPreview',
      panelTitle(document),
      // Beside and unfocused: the author asked to see the diagram, not to be
      // moved out of the file they are typing. The caret stays where it was.
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        // Without this the context is thrown away whenever the panel is hidden
        // and rebuilt from `webview.html` when it comes back — which would mean
        // re-importing PlantUML and re-laying-out the diagram on every tab
        // switch, and would desynchronise the `ready` bookkeeping below. The
        // cost is that a hidden panel keeps its engines in memory; the author
        // closes the panel to get that back, which is the honest trade.
        retainContextWhenHidden: true,
        // `media/rich` and nothing else. A raw diagram document has no images
        // and no links, so no document directory belongs on this list.
        localResourceRoots: [vscode.Uri.file(richRoot())],
        enableCommandUris: false,
      },
    );

    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      // A panel closed mid-render must not leave the wait hanging: the promise
      // is what a queued re-render is chained onto.
      this.settle?.();
      panels.delete(this.key);
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      // The one message the capture client sends unprompted, when md-init.js
      // raises `data-md-render-complete`. Nothing else is spoken on this
      // channel: the diagram panel captures nothing.
      if (isReady(message)) this.settle?.();
    });
  }

  /** Bring the panel forward without stealing the caret. */
  reveal(document: vscode.TextDocument): void {
    // A document closed and reopened is a *new* `TextDocument` object for the
    // same URI; keeping the newest one means `getText()` never reads from a
    // disposed handle.
    this.document = document;
    this.panel.reveal(this.panel.viewColumn, true);
  }

  /** The file was edited. */
  documentChanged(document: vscode.TextDocument): void {
    this.document = document;
    this.schedule();
  }

  /** The workbench theme changed. */
  themeChanged(): void {
    // Through the same debounce as an edit, so a theme flip during a burst of
    // typing costs one reload rather than two.
    this.schedule();
  }

  /** Render now, without waiting for the debounce. Used for the first page. */
  refresh(): void {
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    // `onDidDispose` above does the bookkeeping, including removing this entry.
    this.panel.dispose();
  }

  // MARK: Rendering

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.render();
    }, DEBOUNCE_MS);
  }

  /**
   * Rebuild the page, unless one is already being built or nothing has changed.
   *
   * The in-flight guard is the load-bearing part. PlantUML keeps its request in
   * a single set of module-level slots, so two renders driven at once lose one
   * of them — and while a reload does give the second render a fresh realm, a
   * reload issued *into* an engine still loading its 7.4 MB module is a good way
   * to spend that download twice and show nothing for it. So a render asked for
   * while one is in flight is remembered, not started, and runs when the page
   * says it has settled.
   */
  private render(): void {
    if (this.disposed) return;
    if (this.rendering) {
      this.dirty = true;
      return;
    }
    this.dirty = false;

    const source = this.source();
    const kind = diagramKind(source);
    const name = path.basename(this.document.uri.path) || 'Untitled';
    // The light/dark flag is the workbench's own, exactly as the built-in
    // preview's is. It no longer chooses a palette — the CSS reads the theme
    // live — but it still reaches the engines through `data-md-dark`, and it is
    // part of the fingerprint below for precisely that reason: the same file in
    // the other polarity is a different page and must be rebuilt.
    const rendered = diagramDocument(source, name, isDarkTheme());
    if (rendered === this.lastDocument) return;
    this.lastDocument = rendered;

    this.rendering = true;
    this.panel.webview.html = this.page(rendered, kind);

    void this.settled().then(() => {
      this.rendering = false;
      if (this.dirty && !this.disposed) this.render();
    });
  }

  /**
   * The file's current text.
   *
   * The open document wins over the one this panel was created with, for the
   * close-and-reopen case: VS Code disposes a `TextDocument` when its editor
   * closes, and while a disposed handle still answers `getText()` with the last
   * content it knew, it will never see another edit.
   */
  private source(): string {
    const live = vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.key);
    return (live ?? this.document).getText();
  }

  /**
   * The rendered document, wrapped in our CSP, our engine URLs and our chrome.
   *
   * The stylesheet still rides `instrument`'s head extra rather than going
   * straight into {@link diagramDocument}'s skeleton, for one reason worth
   * keeping: the nonce is minted here, the client script needs it, and the two
   * halves of the chrome — the sheet and the script that drives its attributes
   * — want to leave from the same place. `data-md-host` on both is the shared
   * marker `instrument` documents; nothing in this panel ever asks for a
   * capture, so it is a label rather than a mechanism here.
   */
  private page(rendered: string, kind: DiagramKind): string {
    const webview = this.panel.webview;
    const base = webview.asWebviewUri(vscode.Uri.file(richRoot())).toString();
    const nonce = makeNonce();
    return instrument(
      rendered,
      { base, nonce, cspSource: webview.cspSource },
      {
        head: `<style data-md-host="1">\n${CHROME_CSS}\n</style>`,
        body:
          `${statusBar(kind)}\n` +
          `<script nonce="${nonce}" data-md-host="1">\n${CHROME_CLIENT}\n</script>`,
      },
    );
  }

  /**
   * Resolves when the page reports it has finished, when the cap expires, or
   * when the panel is disposed — whichever comes first, and exactly once.
   *
   * One known imprecision, left in deliberately: the `ready` message carries no
   * generation, so a very late one from a page we gave up waiting for would
   * resolve the *next* wait early. It needs a render to exceed 45 s first, and
   * the only cost when it happens is that one reload starts sooner than
   * intended — into a fresh realm either way. Threading a generation through
   * would mean changing the capture client, which every export shares.
   */
  private settled(): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.settle = undefined;
        resolve();
      };
      const timer = setTimeout(finish, SETTLE_TIMEOUT_MS);
      this.settle = finish;
    });
  }
}

// MARK: - The document

/**
 * md's body for this file, in a skeleton of our own.
 *
 * The skeleton is deliberately `renderDocument`'s, minus one thing: there is no
 * `<style>` carrying `src/render/css-text.ts`. That sheet is the apps' paper
 * look and it has no business in a VS Code panel (see the header); everything
 * this page needs instead is in {@link CHROME_CSS}, written against the
 * workbench's own colours.
 *
 * Everything else is kept because something reads it:
 *
 *   * `data-md-dark` on `<body>` — md-init.js reads it as
 *     `document.body.dataset.mdDark` and it is what picks PlantUML's dark flag
 *     and Mermaid's theme. It is the *only* channel to those engines, on every
 *     platform, and dropping it here would have left every diagram light.
 *   * the `rich/` URLs, quoted exactly as `renderDocument` writes them, because
 *     `instrument` rebases the `"rich/` prefix onto webview URIs and md-init's
 *     dynamic `import('./plantuml.js')` then resolves beside it.
 *   * `<script type="module" src="rich/md-init.js">` last in the body, which is
 *     what runs the engines and raises `data-md-render-complete`.
 *
 * The returned string is also the panel's change fingerprint, so it must be
 * stable for a file that has not changed: nothing here is randomised, and the
 * nonce is added afterwards by {@link DiagramPreview.page}.
 */
function diagramDocument(source: string, title: string, dark: boolean): string {
  // No `engines` hooks and no `sourceLines`. The host-side engines are for the
  // built-in preview, which cannot run WebAssembly; this page can, so every
  // engine runs in it exactly as it does in the apps. `sourceLines` is scroll
  // sync, which belongs to a preview that has an editor to sync with.
  const { html, needs } = renderBody(source, { title, dark });

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHTML(title)}</title>`,
    engineTags(needs),
    '</head>',
    `<body data-md-dark="${dark ? '1' : '0'}">`,
    html,
    '<script type="module" src="rich/md-init.js"></script>',
    '</body>',
    '</html>',
  ]
    // A document that needs no engine at all — the Markdown fallback over a file
    // with nothing rich in it — would otherwise leave a blank line in the head.
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * The `<head>` scripts and stylesheets `needs` calls for.
 *
 * **A deliberate second copy of `renderDocument`'s head, and it must track it.**
 * The original cannot be shared: its bytes are diffed against
 * `MarkdownHTML.document` by the golden corpus, so factoring it out would put a
 * parity-pinned function at the mercy of this file. Two rules keep the copy
 * honest — the tag order is load-bearing and is reproduced exactly, and the
 * gate is `needs`, which `renderBody` computes from the markup it actually
 * emitted rather than from a scan of the source.
 *
 * The order, from that original: KaTeX's stylesheet, then KaTeX, then mhchem,
 * which registers its macros onto the global KaTeX defines and silently no-ops
 * against a mismatched build; both are classic `defer` scripts, so they run in
 * document order and ahead of md-init.js, which is a module at the end of the
 * body. Viz.js is Graphviz and is included for PlantUML too — inherited from md
 * and kept for parity with the three apps, though this TeaVM build carries
 * PlantUML's own Smetana layout and never reaches for it.
 *
 * In practice a `.puml` or `.gv` file reaches only the Viz line: `renderBody`
 * hard-codes `needs` for a raw diagram document, and there is no Markdown in it
 * to want maths or highlighting. The rest is for the fallback — a file that
 * opens no diagram is parsed as Markdown, and a Markdown file may want any of
 * them.
 */
function engineTags(needs: EngineNeeds): string {
  const tags: string[] = [];
  if (needs.math) {
    tags.push(
      '<link rel="stylesheet" href="rich/katex.min.css">',
      '<script defer src="rich/katex.min.js"></script>',
      '<script defer src="rich/mhchem.min.js"></script>',
    );
  }
  if (needs.mermaid) tags.push('<script src="rich/mermaid.min.js"></script>');
  if (needs.plantuml || needs.graphviz) tags.push('<script src="rich/viz-global.js"></script>');
  if (needs.highlight) tags.push('<script defer src="rich/highlight.min.js"></script>');
  return tags.join('\n');
}

// MARK: - The page's chrome

/** The panel tab's name: the file's own, extension and all. */
function panelTitle(document: vscode.TextDocument): string {
  return `md — ${path.basename(document.uri.path) || 'Untitled'}`;
}

/**
 * Which container `renderBody` will emit for this text — asked here so the
 * status line can name the right engine before the page has drawn anything.
 *
 * Deliberately the same two predicates `renderBody` itself consults, in the
 * same order, rather than a look at the file extension: an `.iuml` include
 * fragment has no `@start…` line and really is not a diagram, and a `.txt` file
 * that opens `digraph {` really is one.
 */
function diagramKind(source: string): DiagramKind {
  if (isRawPlantUML(source)) return 'plantuml';
  if (isRawGraphviz(source)) return 'graphviz';
  return null;
}

/**
 * The status line at the foot of the panel.
 *
 * Three states, and the client below moves between them:
 *
 *   * *pending* — the engine is loading or drawing. Worth saying: the first
 *     PlantUML render of a session pulls in 7.4 MB before it draws a line, and
 *     an empty panel for those seconds reads as a failure.
 *   * *drawn* — the line is removed outright. A diagram that worked needs no
 *     furniture around it.
 *   * *failed* — the engine refused. md's rule is that a diagram which will not
 *     render leaves its source text on screen rather than a hole, and md-init.js
 *     already does that; this only says out loud what the reader is looking at.
 *     Where the engine draws its own error picture — PlantUML does, for a syntax
 *     error — that picture *is* an `<svg>`, so this never fires and the author
 *     gets the engine's own words.
 *   * and the fourth, which never moves: a file that opens no diagram at all.
 */
function statusBar(kind: DiagramKind): string {
  if (kind === null) {
    return (
      `<div class="md-diagram-status" data-md-host="1" data-state="note">` +
      escapeHTML(
        'No diagram here: a PlantUML file opens with @startuml, a DOT file with ' +
          'digraph { … }. The file is shown as text.',
      ) +
      `</div>`
    );
  }

  const engine = kind === 'plantuml' ? 'PlantUML' : 'Graphviz';
  const pending =
    kind === 'plantuml' ? 'Drawing with PlantUML…' : 'Laying the graph out with Graphviz…';
  const failed = `${engine} could not draw this file. Its source is shown above, unchanged.`;
  return (
    `<div class="md-diagram-status" data-md-host="1" data-state="pending"` +
    ` data-failed="${escapeHTML(failed)}">${escapeHTML(pending)}</div>`
  );
}

/**
 * The panel's whole stylesheet. There is no other one in the page.
 *
 * Since the document arrives from `renderBody` rather than `renderDocument`,
 * this sheet is not an appendix to md's paper sheet — it *is* the page's
 * appearance, and every colour in it comes from the `--vscode-*` set, which a
 * webview we create is given in full. The panel therefore dresses as the rest
 * of the workbench, which is what the built-in Markdown preview does and what a
 * reader who opened a `.puml` file beside their editor expects to see.
 *
 * Two things the webview host contributes, and which this sheet is written
 * around rather than against:
 *
 *   * the colours arrive as **inline custom properties on `<html>`** —
 *     `documentStyle.setProperty('--vscode-…', …)` in the host's `applyStyles`
 *     — so they are read here and never redeclared. An inline declaration on
 *     that element beats any rule this file could write for it, so a `:root`
 *     block trying to set one would simply be ignored; and because they are
 *     inline, the host can rewrite them on a theme change and the page follows
 *     without a reload.
 *   * the host's own defaults sit in `@layer vscode-default` (a transparent
 *     body, `padding: 0 20px`, `--vscode-editor-foreground` ink, themed
 *     scrollbars). **Any unlayered rule beats a layered one whatever the
 *     specificity**, so nothing below needs to fight them and nothing depends
 *     on load order. Only the frame is restated, because a transparent body
 *     over the browser's default canvas is a white page in a dark theme.
 *
 * The layout keys off `data-md-diagram` on `<body>`, set by the client below.
 * A `:has(> div.plantuml)` selector would say the same thing without a script,
 * but keying off an attribute keeps the rule working in any engine and lets the
 * *state* — pending, drawn, failed — ride the same mechanism.
 *
 * **No literal tag text below, not even in a comment.** A browser reads a
 * `<style>` element as raw text and would not care, but this sheet is spliced
 * into a page by string surgery — `instrument` matches `<head>` and `</body>`,
 * and the harness that drives this panel matches the opening `<body …>` tag —
 * and it lands in the head, *ahead* of the real markup. A stylesheet comment
 * saying "on `<body>`" is therefore the first thing such a pass finds, and it
 * gets spliced into the middle of a CSS comment. Measured, once, by writing it.
 */
const CHROME_CSS = `
/* ── The palette ───────────────────────────────────────────────────────────
   Named once, on the element the host's own variables are declared on, so that
   the ladders below are written out in one place rather than five. The names
   are the panel's own; the values are all VS Code's. Keep them consistent with
   the editor-mode block in media/preview/md-preview.css, which walks the same
   ladders for the built-in preview. */
:root {
    --md-panel-paper: var(--vscode-editor-background);
    --md-panel-ink: var(--vscode-editor-foreground, var(--vscode-foreground));
    --md-panel-muted: var(--vscode-descriptionForeground, var(--vscode-foreground));
    /* --vscode-widget-border is undefined in a good many themes, hence the
       ladder down to the neutral the built-in preview's own sheet falls back
       to. */
    --md-panel-border: var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(127, 127, 127, 0.35)));
    --md-panel-link: var(--vscode-textLink-foreground);
    --md-panel-code-font: var(--vscode-editor-font-family, "SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace);
    --md-panel-code-size: var(--vscode-editor-font-size, 13px);
}
/* High contrast, either polarity: those themes promise a visible edge on every
   box, and a 35 % grey does not deliver one. Declared on the body element,
   which is where the host writes the theme class; a value declared lower down
   beats the one inherited from the root. A high-contrast *light* theme carries both classes —
   the host adds \`vscode-high-contrast\` to it for backwards compatibility — so
   this one selector covers both. */
body.vscode-high-contrast {
    --md-panel-border: var(--vscode-contrastBorder, var(--md-panel-ink));
}
/* The UA's own light/dark switch, for the form controls and scrollbars of
   anything inside the page — the stage is a scroll container, and a dark panel
   with light scrollbars reads as a rendering fault. It sits on the body element
   because that is what the host puts the theme class on; the viewport's own
   scrollbars are the host's to paint, and it does, in its default layer.

   The dark selector excludes \`vscode-high-contrast-light\` explicitly rather
   than relying on source order, since that theme matches both classes. */
body.vscode-light,
body.vscode-high-contrast-light {
    color-scheme: light;
}
body.vscode-dark,
body.vscode-high-contrast:not(.vscode-high-contrast-light) {
    color-scheme: dark;
}

/* ── The page frame ────────────────────────────────────────────────────────
   \`html\` as well as \`body\`, so that the colour is the canvas's and not merely
   the body box's: in the fallback path the document can be shorter than the
   panel, and a page that ends in the browser's white halfway down is the very
   fault this change exists to remove.

   md's own \`* { box-sizing: border-box }\` is kept: the markup below is the
   markup the three apps emit, it was written under that reset, and three
   shipping apps have proved it safe over KaTeX and the diagram SVGs. */
* {
    box-sizing: border-box;
}
html,
body {
    background: var(--md-panel-paper);
}
body {
    color: var(--md-panel-ink);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    line-height: 1.5;
    margin: 0;
    padding: 16px 20px;
}

/* ── The file shown as text ────────────────────────────────────────────────
   The fourth state: a file that opens no diagram is parsed as Markdown, and
   what it gets is the workbench's own furniture rather than a second copy of
   md's document sheet. That is a decision, not an omission — this panel exists
   to draw one diagram, the status line says in as many words that the file is
   being shown as text, and a reader who wants md's page for a Markdown file has
   the Markdown preview, which is a whole stylesheet devoted to exactly that.
   Only what the markup structurally depends on is set here: the renderer emits
   a flat run of \`.md-item\` rows with no list element and no list-style, so
   without the flex rule a list loses its markers' alignment entirely. */
a {
    color: var(--md-panel-link);
}
code,
pre {
    font-family: var(--md-panel-code-font);
    font-size: var(--md-panel-code-size);
}
pre {
    padding: 12px 14px;
    border: 1px solid var(--md-panel-border);
    border-radius: 4px;
    overflow-x: auto;
}
th,
td {
    border: 1px solid var(--md-panel-border);
    padding: 6px 12px;
}
.md-item {
    display: flex;
    gap: 0.5em;
}
.md-marker {
    color: var(--md-panel-muted);
    min-width: 1.5em;
    text-align: right;
}
img,
.mermaid svg,
.plantuml svg,
.graphviz svg {
    max-width: 100%;
    height: auto;
}

/* ── The diagram ink ───────────────────────────────────────────────────────
   Graphviz draws in plain black on a transparent ground (md-init.js asks for
   \`bgcolor=transparent\`, and for nothing else), so on a dark editor background
   it would be a black graph on a near-black page. It is recoloured here, in
   CSS, and never by passing colours to the engine: these are presentation
   attributes, which any CSS rule outranks, and leaving the engine's own
   attributes alone keeps the layout metrics — and so the label positions it
   computed — exactly as Graphviz intended. A \`fontname\` or a colour handed to
   the engine would change those metrics, and would relay the whole graph on
   every change of theme; now that the ink is the editor's, that would be a
   relayout every time the reader switched theme.

   An author's own \`fontcolor\` / \`color\` survives: Graphviz writes those out as
   attributes too, so each rule is scoped to the value the engine emits when
   nothing was asked for — text with no fill of its own, and explicit black.

   Do not merge these four into \`[fill="black"], [stroke="black"]\`. Graphviz
   writes no \`fill\` at all for a default label, so \`text:not([fill])\` has no
   black to match; it is the rule that carries every unstyled node label.

   Mermaid and PlantUML get no equivalent and want none: both take the
   light/dark state through \`data-md-dark\` and write their own colours into the
   SVG they draw. A CSS rule over their output would fight a stylesheet we do
   not own, and would differ from the apps. */
.graphviz svg text:not([fill]) { fill: var(--md-panel-ink); }
.graphviz svg text[fill="black"] { fill: var(--md-panel-ink); }
.graphviz svg [stroke="black"] { stroke: var(--md-panel-ink); }
.graphviz svg [fill="black"]:not(text) { fill: var(--md-panel-ink); }

/* ── The stage ─────────────────────────────────────────────────────────────
   Only when the file really did produce one diagram container. A file that fell
   through to the Markdown path keeps the ordinary page above, padding and all. */
body[data-md-diagram="plantuml"],
body[data-md-diagram="graphviz"] {
    margin: 0;
    padding: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
}
/* The single diagram container, filling the panel and scrolling on its own so
   that the status line below it never scrolls away.

   Until the engine has drawn — and if it never does — this holds the file's own
   text, and it is set as the source it is, in the editor's own face and size,
   rather than as prose. md's rule centres the container and leaves white-space
   alone, which reads a diagram's twenty lines as one long collapsed sentence;
   that is defensible for a figure in the middle of a document, and no use at
   all when the whole panel is that one block. */
body[data-md-diagram] > div.plantuml,
body[data-md-diagram] > div.graphviz {
    flex: 1 1 auto;
    /* Without this a flex item refuses to shrink below its content, and the
       scrolling would happen on the page instead of inside the stage. */
    min-height: 0;
    margin: 0;
    padding: 24px;
    overflow: auto;
    display: block;
    text-align: left;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--md-panel-code-font);
    font-size: var(--md-panel-code-size);
    line-height: 1.5;
}
/* Drawn: a figure, centred in whatever room there is. */
body[data-md-diagram-state="drawn"] > div.plantuml,
body[data-md-diagram-state="drawn"] > div.graphviz {
    display: flex;
}
body[data-md-diagram-state="drawn"] > div.plantuml > svg,
body[data-md-diagram-state="drawn"] > div.graphviz > svg {
    /* Centred by auto margins rather than by align-items / justify-content. A
       flex item centred by alignment overflows its scroll container in BOTH
       directions, and the top and left of an oversized diagram then cannot be
       scrolled to at all. Auto margins collapse to zero when there is no room,
       which is exactly the wanted behaviour. */
    margin: auto;
    flex: 0 0 auto;
    /* The figure rule above caps a diagram at the panel's width, which is right
       for a figure on a page and wrong here: this panel opens beside the
       editor, so half the window wide, and shrinking a class diagram to fit it
       makes the labels unreadable. Natural size, and scroll to the rest. */
    max-width: none;
    height: auto;
}

/* ── The status line ───────────────────────────────────────────────────────
   Editor chrome rather than part of the picture, so it takes the workbench's UI
   font and not the editor's mono — the source text on the stage above is the
   thing that is code, and it is the thing set in the editor's face. */
.md-diagram-status {
    flex: 0 0 auto;
    padding: 6px 12px;
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    line-height: 1.4;
    color: var(--md-panel-muted);
    background: var(--vscode-editorWidget-background, var(--md-panel-paper));
    border-top: 1px solid var(--md-panel-border);
}
/* The note has no flex parent to sit at the foot of, so it needs a little room
   of its own after the document it is talking about. */
body[data-md-diagram="none"] .md-diagram-status {
    margin-top: 1.5em;
}
.md-diagram-status[data-state="failed"] {
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
    background: var(--vscode-inputValidation-errorBackground, var(--vscode-editorWidget-background));
    border-top-color: var(--vscode-inputValidation-errorBorder, var(--md-panel-border));
}
`.trim();

/**
 * The panel's own client, injected ahead of the capture client.
 *
 * **It must never call `acquireVsCodeApi()`.** The capture client alongside it
 * already has, a second call throws, and the two scripts share this page — so
 * this one talks to nobody and only reads and writes its own DOM. Everything
 * the host needs to know already arrives on the capture client's `ready`
 * message.
 *
 * Written as a string rather than bundled for the same reason `CAPTURE_CLIENT`
 * is: it is thirty lines with no imports, and keeping it beside the CSS and the
 * status markup it drives is what stops the three drifting apart.
 */
const CHROME_CLIENT = `(function () {
  var body = document.body;
  var stage = document.querySelector('body > div.plantuml, body > div.graphviz');
  var status = document.querySelector('.md-diagram-status');

  if (!stage) {
    // The Markdown fallback: no container, so no layout to impose and nothing
    // to wait for. The host's note stays exactly as it was written.
    body.setAttribute('data-md-diagram', 'none');
    return;
  }
  body.setAttribute('data-md-diagram',
    stage.classList.contains('plantuml') ? 'plantuml' : 'graphviz');
  body.setAttribute('data-md-diagram-state', 'pending');

  // md-init.js raises this when every engine has settled — the same flag every
  // export waits on. It cannot be up yet: this script runs while the document is
  // still parsing, and md-init.js is a module, deferred until after. It is still
  // tested before the observer goes in, because that is the shape the capture
  // client uses and the two want reading together.
  function complete() {
    return document.documentElement.getAttribute('data-md-render-complete') === '1';
  }

  function settle() {
    if (!complete()) return false;
    // The one honest test of whether a diagram rendered: md-init.js restores the
    // block's source text when an engine throws or times out, and leaves no
    // <svg> behind.
    var drawn = !!stage.querySelector('svg');
    body.setAttribute('data-md-diagram-state', drawn ? 'drawn' : 'failed');
    if (status) {
      if (drawn) {
        status.remove();
      } else {
        status.textContent = status.getAttribute('data-failed') || '';
        status.setAttribute('data-state', 'failed');
      }
    }
    return true;
  }

  if (!settle()) {
    var observer = new MutationObserver(function () {
      if (settle()) observer.disconnect();
    });
    observer.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-md-render-complete'],
    });
  }
})();`;

/** The capture client's unprompted "the engines have settled" message. */
function isReady(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'ready'
  );
}
