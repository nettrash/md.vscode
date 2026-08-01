//
//  renderHost.ts
//  md.vscode — the offscreen render surface every capture-based export needs.
//
//  WHY THIS EXISTS AT ALL
//  ----------------------
//  Three of the five bundled engines run in Node and are already finished
//  before an export starts: KaTeX has a pure `renderToString`, highlight.js a
//  pure `highlight`, and Graphviz a pure `renderString` once its WebAssembly is
//  warm. The other two cannot:
//
//    * **Mermaid** needs real text metrics. Measured under jsdom it lays a
//      diagram out at `viewBox="-8 -8 30998 32"` with no `<text>` element at
//      all — not degraded, unusable.
//    * **PlantUML** measures with `canvas.getContext('2d').measureText`. A shim
//      approximates it, and then every box in the diagram is the wrong size.
//
//  So any export that needs their SVG — HTML, EPUB, SVG, PDF — needs a browser.
//  This is that browser: a webview **we** create, which matters because a
//  webview we create has a CSP we choose. The built-in Markdown preview's
//  `script-src` is `'nonce-…'` and nothing else, with no `'wasm-unsafe-eval'`
//  and no `frame-src` to escape through; ours adds `'wasm-unsafe-eval'` so
//  ```dot blocks render in the page exactly as they do in the apps.
//
//  The shape is deliberately md's own: load the same document, load the same
//  `rich/` engines, and wait for md-init.js to raise the same
//  `data-md-render-complete="1"` flag before reading anything back. Apple polls
//  that attribute on an offscreen `WKWebView`; Android does the same on a
//  detached `WebView`. Here a `MutationObserver` posts the moment it appears,
//  which is the same contract with one less poll.
//
//  THE TIMEOUT IS A SUCCESS, NOT A FAILURE
//  ---------------------------------------
//  Apple gives the handshake 480 attempts at 250 ms — about two minutes — and
//  then **proceeds anyway** with whatever the DOM holds. That is not sloppiness:
//  PlantUML renders strictly sequentially and a Graphviz-backed layout can take
//  20 s on its own, so a slow document is normal, and a diagram that never
//  arrives has already restored its own source text. Aborting would throw away
//  a whole export over one figure. This class reproduces that exactly: the wait
//  resolves either way, and `timedOut` records which it was so the caller can
//  say so without failing.
//
//  VS Code has no offscreen webview. The panel is created beside the editor
//  with `preserveFocus`, never takes focus, and is disposed the moment the
//  capture lands — except on the print path, where the panel *is* the surface
//  the print dialogue belongs to and has to outlive the call.
//

import * as vscode from 'vscode';

import { richRoot } from '../engines/paths';
import { RICH_SELECTOR } from './epub';

/**
 * The diagram half of {@link RICH_SELECTOR}.
 *
 * `DiagramSVG.ordinal` is a position among *diagrams only*, so the SVG capture
 * indexes this list rather than the wider one — and the two must keep agreeing
 * about what a diagram is, which is why both are written out here beside each
 * other rather than composed from a shared fragment that would read as though
 * the order did not matter.
 */
export const DIAGRAM_SELECTOR = 'pre.mermaid, div.plantuml, div.graphviz';

/** One rasterised rich block, as the EPUB path consumes it. */
export interface RichSnapshot {
  /** PNG bytes, or null when the element had no vector to rasterise. */
  png: Uint8Array | null;
  /** The element's *layout* width in CSS pixels — not the snapshot's. */
  width: number;
}

/** How long to wait for `data-md-render-complete`, matching Apple's 480 × 250 ms. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface RenderHostOptions {
  /** Shown on the panel tab. Only ever seen if the user reveals the panel. */
  title?: string;
  /** Overrides the two-minute default. The wait always resolves; this only bounds it. */
  timeoutMs?: number;
}

/**
 * A loaded document, rendered by the real engines, ready to be read back.
 *
 * Always `open()` → capture → `dispose()`. The panel holds a Chromium context
 * with up to 11 MB of engines in it; leaving one alive per export would be a
 * leak the user can see in Activity Monitor.
 */
export class RenderHost implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly pending = new Map<number, PendingRequest>();
  private nextID = 1;
  private disposed = false;

  /** True when the two-minute cap expired before md-init.js raised its flag. */
  readonly timedOut: boolean;

  private constructor(panel: vscode.WebviewPanel, timedOut: boolean) {
    this.panel = panel;
    this.timedOut = timedOut;
    this.panel.onDidDispose(() => {
      this.disposed = true;
      // A user who closes the panel mid-export gets an error naming what
      // happened, rather than a promise that never settles and a command that
      // appears to have hung.
      for (const request of this.pending.values()) {
        request.subscription.dispose();
        request.reject(new Error('The render surface was closed before the export finished.'));
      }
      this.pending.clear();
    });
  }

  /**
   * Load `html` and resolve once the engines have settled — or once the cap
   * expires, whichever comes first.
   *
   * `html` is a complete document from `renderDocument`, and it is loaded with
   * **no host-side engine hooks**: the whole point of this surface is that the
   * same five engines run in the same order md-init.js runs them, so an
   * exported artefact is what the apps would have produced rather than a
   * mixture of two rendering paths.
   */
  static async open(html: string, options: RenderHostOptions = {}): Promise<RenderHost> {
    const richDirectory = vscode.Uri.file(richRoot());
    const panel = vscode.window.createWebviewPanel(
      'md.renderHost',
      options.title ?? 'md — rendering…',
      // Beside and unfocused: the author asked for an export, not for a new
      // editor group to be taken over. There is no offscreen webview API, so
      // an unfocused panel disposed on completion is as close as VS Code gets.
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        // The engines are megabytes and the render is asynchronous; a hidden
        // panel that discarded its context would restart the whole thing the
        // moment the author switched tabs mid-export.
        retainContextWhenHidden: true,
        // `media/rich` and nothing else. The author's own images are not
        // resolved — they are relative links the renderer never rewrites, on
        // every platform — so no document directory belongs on this list.
        localResourceRoots: [richDirectory],
        enableCommandUris: false,
      },
    );

    const webview = panel.webview;
    const base = webview.asWebviewUri(richDirectory).toString();
    const nonce = makeNonce();

    const ready = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (timedOut: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        subscription.dispose();
        resolve(timedOut);
      };
      const timer = setTimeout(() => finish(true), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const subscription = webview.onDidReceiveMessage((message: unknown) => {
        if (isMessage(message) && message.type === 'ready') finish(false);
      });
      panel.onDidDispose(() => finish(true));
    });

    webview.html = instrument(html, { base, nonce, cspSource: webview.cspSource });
    const timedOut = await ready;
    return new RenderHost(panel, timedOut);
  }

  /**
   * The rendered document as one self-contained page, doctype and all.
   *
   * Taken *after* the handshake, so the diagrams are already inline `<svg>` and
   * the formulas already expanded. Nothing is left to run, so every `<script>`
   * and every stylesheet `<link>` is removed — the exported file must not reach
   * for an engine that will not be there — along with the two things VS Code
   * added that the apps never had: the CSP `<meta>` and this instrumentation.
   * Both are tagged `data-md-host`, so a future addition is removed by having
   * carried the same attribute rather than by being remembered here.
   */
  async selfContainedHTML(): Promise<string> {
    const markup = await this.request<string>('selfContainedHTML');
    if (markup.length === 0) {
      throw new Error('The rendered page came back empty; nothing was exported.');
    }
    // `outerHTML` omits the doctype, and without one every browser renders the
    // page in quirks mode — so it is put back by hand, exactly as on Apple.
    return '<!DOCTYPE html>\n' + markup;
  }

  /**
   * The rendered root `<svg>` of the diagram at `index` (0-based, in document
   * order among `pre.mermaid, div.plantuml, div.graphviz`), or null.
   *
   * Null is the honest answer for a block whose engine threw or timed out:
   * md-init.js restores its source text and leaves no `<svg>`, so there is no
   * vector to export and the caller says so rather than writing an empty file.
   */
  async diagramSVG(index: number): Promise<string | null> {
    return this.request<string | null>('diagramSVG', { index });
  }

  /**
   * Every rich element rasterised to a PNG, in the same document order
   * {@link RICH_SELECTOR} reports and `richElementRanges` scans — so the two
   * pair up index-for-index and a replacement can never land on the wrong
   * element.
   *
   * An element with no `<svg>` comes back with `png: null` and keeps its source
   * text in the EPUB. In practice that means **every formula**: KaTeX lays a
   * formula out as HTML and CSS, so there is no vector to draw into a canvas.
   * The alternative would be a DOM rasterizer (a dependency) or shipping KaTeX
   * markup and its stylesheet into the EPUB (a documented parity break for math
   * documents); until that product decision is taken, a formula degrades to the
   * LaTeX the author wrote, which is at least readable in every reader.
   */
  async snapshots(scale = 2): Promise<RichSnapshot[]> {
    const raw = await this.request<{ png: string | null; width: number }[]>('snapshots', { scale });
    return raw.map((entry) => ({
      png: entry.png === null ? null : Buffer.from(entry.png, 'base64'),
      width: entry.width,
    }));
  }

  /**
   * Reveal the panel and ask the page to print itself.
   *
   * This is the whole of the PDF story, and it is worth being blunt about what
   * it is: `window.print()` hands the rendered page to the host's own print
   * pipeline, from which the user picks a printer or "Save as PDF" and chooses
   * the destination there. We never see the bytes, so nothing is written by us
   * and there is nothing to save-dialogue.
   *
   * The panel has to be visible and must **outlive this call** — the print
   * dialogue belongs to it — so `dispose()` is the caller's to time, not this
   * method's.
   */
  async print(): Promise<void> {
    this.panel.reveal(this.panel.viewColumn, false);
    await this.request<null>('print');
  }

  /** Close the panel and drop its Chromium context. */
  dispose(): void {
    if (!this.disposed) this.panel.dispose();
  }

  private request<T>(verb: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('The render surface was closed before the export finished.'));
    }
    const id = this.nextID++;
    return new Promise<T>((resolve, reject) => {
      const subscription = this.panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!isMessage(message) || message.id !== id) return;
        subscription.dispose();
        this.pending.delete(id);
        if (message.type === 'result') {
          resolve(message.value as T);
        } else if (message.type === 'error') {
          reject(new Error(typeof message.message === 'string' ? message.message : 'capture failed'));
        }
      });
      this.pending.set(id, { reject, subscription });
      void this.panel.webview.postMessage({ type: 'capture', id, verb, args });
    });
  }
}

// MARK: - Instrumentation

/** One capture in flight: enough to fail it cleanly if the panel goes away. */
interface PendingRequest {
  reject(err: Error): void;
  subscription: vscode.Disposable;
}

interface HostMessage {
  type: string;
  id?: number;
  value?: unknown;
  message?: unknown;
}

function isMessage(value: unknown): value is HostMessage {
  return typeof value === 'object' && value !== null && typeof (value as HostMessage).type === 'string';
}

/**
 * A per-render nonce.
 *
 * `Math.random` is fine here and a `crypto` import would be theatre: the value
 * guards nothing an attacker can reach — the page is our own generated markup,
 * loaded from disk, in a webview with no network — it only distinguishes our
 * one inline script from anything a document might somehow contribute.
 */
function makeNonce(): string {
  let out = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * The VS Code-only post-pass: rewrite the engine base, add the CSP, add the
 * capture client.
 *
 * It is a **post-pass on the generated string**, never a change to the
 * generator: the golden tests diff `renderDocument`'s own bytes, and everything
 * this adds is tagged `data-md-host` so the capture can take it straight back
 * out again.
 *
 * Never a `<base href>`: it would turn `href="#slug"` into a cross-document
 * navigation and change how relative images resolve. The engine URLs are
 * rewritten in place instead — the same `"rich/` → `"<webview URI>/` pass the
 * preview does — which keeps `md-init.js` and `plantuml.js` siblings under one
 * prefix, and that is what makes md-init's dynamic `import('./plantuml.js')`
 * resolve: a module specifier is resolved against its own module's URL and
 * nothing else. (`renderDocument` also takes an `assetBase`; doing it here
 * instead keeps every export rendering the one document the golden tests diff.)
 */
function instrument(
  html: string,
  context: { base: string; nonce: string; cspSource: string },
): string {
  const { base, nonce, cspSource } = context;

  // The generated document asks for `rich/…`; point that at the webview URIs.
  // A plain string replace of the quoted prefix, so nothing in the author's own
  // content — where the sequence would be escaped anyway — can be caught by it.
  // Function replacements, here and below: the webview URI carries a query
  // string, and `$&`, `` $` ``, `$'` and `$1` are all interpreted inside a
  // *string* replacement. One `$` in an origin would rewrite the engine URL to
  // something that 404s tens of seconds later, in the middle of a diagram.
  const rebased = html.replaceAll('"rich/', () => `"${base}/`);

  // `default-src 'none'` and then exactly what the engines need:
  //   * `'wasm-unsafe-eval'` because viz-global.js *is* WebAssembly, and this is
  //     the whole reason exports do not run in the built-in preview;
  //   * NEVER `'unsafe-eval'` — it overrides `'wasm-unsafe-eval'` and grants far
  //     more — and never `'strict-dynamic'`, which would disable the host
  //     allow-list the engine `<script src>` tags depend on;
  //   * `'unsafe-inline'` styles because Mermaid injects a `<style>` into every
  //     SVG it draws;
  //   * `data:` fonts for KaTeX and `data:` images for the EPUB rasterizer,
  //     which loads each diagram as a `data:image/svg+xml` before drawing it;
  //   * no `connect-src`, so `default-src 'none'` stands and the page cannot
  //     reach the network. The family is offline by design and this is where
  //     that is enforced rather than merely intended.
  const csp =
    `<meta http-equiv="Content-Security-Policy" data-md-host="1" content="` +
    `default-src 'none'; ` +
    `script-src ${cspSource} 'wasm-unsafe-eval' 'nonce-${nonce}'; ` +
    `style-src ${cspSource} 'unsafe-inline'; ` +
    `font-src ${cspSource} data:; ` +
    `img-src ${cspSource} data:;">`;

  const client = `<script nonce="${nonce}" data-md-host="1">\n${CAPTURE_CLIENT}\n</script>`;

  return rebased
    .replace('<head>', () => `<head>\n${csp}`)
    .replace('</body>', () => `${client}\n</body>`);
}

/**
 * The capture client, injected into the rendered page.
 *
 * Written as a string rather than bundled because it is 60 lines with no
 * imports, and because keeping it beside the host half is what stops the two
 * drifting: the verb names, the selectors and the message shape are all read in
 * this one file.
 *
 * `acquireVsCodeApi()` is called exactly once, at the top, and never put on
 * `window` — calling it twice throws, and a page that has both `md-init.js` and
 * this script in it is precisely where somebody would try.
 */
const CAPTURE_CLIENT = `(function () {
  var api = acquireVsCodeApi();
  var RICH = ${JSON.stringify(RICH_SELECTOR)};
  var DIAGRAMS = ${JSON.stringify(DIAGRAM_SELECTOR)};

  // The handshake. md-init.js raises the flag when math, highlighting and all
  // three diagram engines have settled; it may already have done so if this
  // document needed no engine at all, so the attribute is checked before the
  // observer is installed.
  function complete() {
    return document.documentElement.getAttribute('data-md-render-complete') === '1';
  }
  function announce() { api.postMessage({ type: 'ready' }); }
  if (complete()) {
    announce();
  } else {
    var observer = new MutationObserver(function () {
      if (!complete()) return;
      observer.disconnect();
      announce();
    });
    observer.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-md-render-complete'],
    });
  }

  function selfContainedHTML() {
    document.querySelectorAll('script, link[rel="stylesheet"], [data-md-host]').forEach(
      function (el) { el.remove(); });
    // A stale completion flag would be misleading in a file that has nothing
    // left to complete.
    document.documentElement.removeAttribute('data-md-render-complete');
    return document.documentElement.outerHTML;
  }

  function diagramSVG(index) {
    var el = document.querySelectorAll(DIAGRAMS)[index];
    if (!el) return null;
    var svg = el.querySelector('svg');
    return svg ? svg.outerHTML : null;
  }

  // Rasterise one rendered <svg> through a canvas. Serialising the element and
  // loading it as a data: URL is what makes this work without a dependency —
  // and it works only for the three diagram engines, since a KaTeX formula is
  // HTML and CSS with no vector to draw.
  function rasterise(svg, rect, scale) {
    return new Promise(function (resolve, reject) {
      var clone = svg.cloneNode(true);
      clone.setAttribute('width', String(rect.width));
      clone.setAttribute('height', String(rect.height));
      if (!clone.getAttribute('xmlns')) {
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      }
      var text = new XMLSerializer().serializeToString(clone);
      var image = new Image();
      image.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(rect.width * scale));
        canvas.height = Math.max(1, Math.round(rect.height * scale));
        var context = canvas.getContext('2d');
        if (!context) { reject(new Error('no 2d context')); return; }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        var url = canvas.toDataURL('image/png');
        resolve(url.slice(url.indexOf(',') + 1));
      };
      image.onerror = function () { reject(new Error('the diagram could not be rasterised')); };
      // btoa takes Latin-1, so the UTF-8 bytes are spelled out first; a diagram
      // with a non-ASCII label would otherwise throw here and lose its picture.
      // One byte at a time rather than String.fromCharCode.apply over the whole
      // array: a large PlantUML diagram is hundreds of kilobytes, and spreading
      // that many arguments overflows the call stack.
      var bytes = new TextEncoder().encode(text);
      var latin1 = '';
      for (var b = 0; b < bytes.length; b++) latin1 += String.fromCharCode(bytes[b]);
      image.src = 'data:image/svg+xml;base64,' + btoa(latin1);
    });
  }

  async function snapshots(scale) {
    var out = [];
    var nodes = document.querySelectorAll(RICH);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var rect = el.getBoundingClientRect();
      var svg = el.querySelector('svg');
      if (!svg || rect.width < 1 || rect.height < 1) {
        out.push({ png: null, width: rect.width });
        continue;
      }
      try {
        out.push({ png: await rasterise(svg, rect, scale), width: rect.width });
      } catch (e) {
        // A capture that fails leaves the element as its readable source text.
        out.push({ png: null, width: rect.width });
      }
    }
    return out;
  }

  window.addEventListener('message', async function (event) {
    var request = event.data;
    if (!request || request.type !== 'capture') return;
    try {
      var value = null;
      if (request.verb === 'selfContainedHTML') value = selfContainedHTML();
      else if (request.verb === 'diagramSVG') value = diagramSVG(request.args.index);
      else if (request.verb === 'snapshots') value = await snapshots(request.args.scale);
      else if (request.verb === 'print') window.print();
      else throw new Error('unknown capture verb: ' + request.verb);
      api.postMessage({ type: 'result', id: request.id, value: value });
    } catch (e) {
      api.postMessage({ type: 'error', id: request.id, message: String(e && e.message || e) });
    }
  });
})();`;
