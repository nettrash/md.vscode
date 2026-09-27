//
//  plantuml-csp.test.ts
//  md.vscode — which PlantUML diagrams the built-in preview can actually draw,
//  measured in a real browser under the preview's real policy.
//
//  THE QUESTION, AND WHY IT HAD TO BE MEASURED
//  -------------------------------------------
//  Three files in this repository used to tell two stories about the same
//  engine. `src/preview/md-preview.ts` said PlantUML's Graphviz-backed layouts
//  (class, activity, state, component) call a global `Viz` that cannot exist
//  under the preview's CSP, so they burn the 20 s budget and fall back to their
//  source. `src/render/html.ts` and `src/preview/assets.ts` said the opposite —
//  that this TeaVM build carries PlantUML's own Smetana layout and never
//  reaches for Viz at all. Both were plausible from the bytes: `plantuml.js`
//  contains one unguarded `Viz.instance()` call *and* the whole `smetana.core`
//  class family.
//
//  Reading cannot settle that, and neither can Node: the engine only takes its
//  layout path once a diagram has been parsed and measured, and measuring wants
//  a real `canvas.getContext('2d').measureText`. So this file runs the engine
//  where it runs in production — in Chromium, in a document served with the
//  built-in preview's Strict CSP, with `plantuml.js` pulled in by a dynamic
//  `import()` from inside a nonce'd classic script, exactly as
//  `md-preview.ts` does it.
//
//  WHAT IT MEASURED (2026-09-23, Chrome 153.0.8010.53)
//  ---------------------------------------------------
//  The engine draws about half of what it can draw, and the split is the one
//  PlantUML itself makes: the kinds it lays out by generating DOT and handing
//  it to Graphviz cannot be drawn here; the kinds it lays out itself are fine.
//
//    * Drawn, in ~200 ms each, never touching `Viz`: sequence (221 × 140, six
//      `<text>` elements), the modern activity syntax (`start` / `if` / `stop`,
//      219 × 248), mindmap, gantt, json, yaml, wbs, salt and timing.
//    * Not drawn: class, state, component, object, use-case, deployment, ER —
//      and the *legacy* activity syntax (`(*) -->`), which is a different
//      implementation from the modern one and takes the Graphviz path. Each
//      reads the global `Viz` exactly once, about 90 ms in, and dies there: the
//      raw JS error cannot be converted into a Java one, so TeaVM's own handler
//      throws `TypeError: Cannot read properties of undefined (reading
//      '$jsException')` and the request is abandoned with the block left empty.
//      Nothing ever appears, the poll in `renderPlantUml` runs out its 20 s and
//      the block is restored to its source text.
//    * `!pragma layout smetana` does not help, and neither do
//      `!pragma graphviz_dot smetana`, `!pragma smetana` or
//      `!option smetana true`: all four still take the `Viz` path. The
//      `smetana.core` classes are in the bundle with nothing that reaches
//      them. So there is no pragma to prepend, and this file pins that too —
//      it is the obvious fix, and it does not work.
//    * Loading `viz-global.js` first does not help either, and that is the
//      third half of the story: the global then exists, and
//      `WebAssembly.instantiate()` fails with a `CompileError` because
//      `script-src 'nonce-…'` carries no `'wasm-unsafe-eval'`. The diagram then
//      fails *visibly* — the block shows `java.lang.RuntimeException:
//      RuntimeError: Aborted(CompileError: …)`.
//
//  So `md-preview.ts` was right about the mechanism, though it named activity
//  diagrams among the casualties when only the legacy syntax is one; the
//  comments in `render/html.ts` and `preview/assets.ts` were wrong outright.
//  The fix is documentation rather than code: those diagram kinds belong to the
//  diagram panel and the exports, whose webviews add `'wasm-unsafe-eval'` and
//  load Viz.js (`renderHost.ts`, `diagramPreview.ts`).
//
//  HOW IT RUNS WITHOUT A BROWSER-AUTOMATION DEPENDENCY
//  ---------------------------------------------------
//  No Playwright, no Puppeteer, no CDP client — the extension ships no runtime
//  dependencies and the test suite has none either. A `node:http` server hands
//  out one document per case with the CSP as a real response header, and each
//  page reports its own result by *navigating* to `/report?…`, which the server
//  answers with a redirect to the next case. Navigation is the one channel
//  `default-src 'none'` leaves open — `connect-src` is absent, so `fetch` and
//  `XMLHttpRequest` are blocked, which is itself part of the policy being
//  reproduced.
//
//  Each case gets a fresh document on purpose. `plantuml.js` parks a request in
//  one set of module-level slots and drives it from a TeaVM scheduler; the
//  exception above leaves that scheduler wedged, so a second diagram rendered
//  into the same page times out whatever it is — which is how the first version
//  of this experiment managed to make even the sequence diagram look broken.
//
//  The whole file skips where there is no Chrome to drive. It runs on this
//  machine and on the `ubuntu-latest` runner, both of which have one.
//

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const PLANTUML = path.resolve(__dirname, '..', 'media', 'rich', 'plantuml.js');

/**
 * The browser, or `null` — in which case the suite skips rather than lies.
 *
 * `MD_CHROME` first, so a machine with Chromium somewhere unusual can still
 * run the experiment.
 */
function findChrome(): string | null {
  const candidates = [
    process.env.MD_CHROME,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  return candidates.find((c) => existsSync(c)) ?? null;
}

const CHROME = findChrome();

/**
 * The nonce. Any value does; what matters is that it is the *only* thing
 * `script-src` allows, so an injected script without it cannot run and neither
 * can `eval`, `new Function` or WebAssembly.
 */
const NONCE = 'mdPreviewNonce';

/**
 * VS Code's Strict (default) policy for the built-in Markdown preview, as
 * `specs/12-CSP-GROUND-TRUTH.md` measured it: nonce-only scripts, no
 * `'unsafe-eval'`, no `'wasm-unsafe-eval'`, no `connect-src`, no `frame-src`.
 */
const CSP =
  `default-src 'none'; ` +
  `img-src 'self' data: https:; ` +
  `media-src 'self' data: https:; ` +
  `script-src 'nonce-${NONCE}'; ` +
  `style-src 'self' 'unsafe-inline' https:; ` +
  `font-src 'self' data: https:;`;

/** How long one diagram may take before the page gives up and reports. */
const CASE_BUDGET_MS = 8000;

interface Probe {
  /** Case id, and the element id the engine renders into. */
  readonly id: string;
  /** The diagram source, `@startuml` and all. */
  readonly source: string;
  /** What the browser was measured to do with it. */
  readonly draws: boolean;
  /**
   * Install a getter for the global `Viz` that counts reads and returns
   * `undefined`.
   *
   * It changes the *shape* of the failure — a `TypeError` where an undeclared
   * identifier would have raised a `ReferenceError` — and nothing else: the
   * engine still has no Viz and still produces no SVG. What it buys is the one
   * fact reading the bundle cannot give, which layout path the diagram took.
   */
  readonly probeViz: boolean;
}

interface Outcome {
  readonly id: string;
  /** Did an `<svg>` appear in the block? */
  readonly ok: boolean;
  /** Reads of the global `Viz`, or `null` when the probe was not installed. */
  readonly viz: number | null;
  /** `<text>` elements in the SVG — a drawing with no text is not a drawing. */
  readonly texts: number;
  readonly width: string | null;
  readonly height: string | null;
  /** Everything `window.onerror` and `unhandledrejection` saw, joined. */
  readonly errors: string;
  readonly ms: number;
}

const CLASS_DIAGRAM = `@startuml
class Document {
  +text: String
  +save()
}
class Editor
Editor --> Document : edits
@enduml`;

/**
 * The map of the boundary, measured rather than assumed.
 *
 * `draws: false` is not a wish — every one of them reads the global `Viz`
 * exactly once, about 90 ms in, and stops there. `draws: true` means the
 * diagram appeared, with its labels in it, in roughly a fifth of a second.
 *
 * The split is PlantUML's own: the kinds it lays out by generating DOT and
 * handing it to Graphviz are the kinds that cannot be drawn here, and the
 * kinds it lays out itself are fine. That is why the modern activity syntax
 * (`start` / `if` / `stop`) draws and the legacy one (`(*) -->`) does not:
 * they are two different diagram implementations wearing one name.
 */
const CASES: readonly Probe[] = [
  // ---- the kinds that draw, which are also the harness's controls. If one of
  // these ever stops, suspect the harness before the engine.
  {
    id: 'sequence',
    draws: true,
    probeViz: true,
    source: `@startuml
Alice -> Bob: Authentication Request
Bob --> Alice: Authentication Response
@enduml`,
  },
  {
    id: 'activity',
    draws: true,
    probeViz: true,
    source: `@startuml
start
:read the document;
if (has diagrams?) then (yes)
  :render them;
else (no)
  :show the text;
endif
stop
@enduml`,
  },
  {
    id: 'mindmap',
    draws: true,
    probeViz: true,
    source: `@startmindmap
* md
** preview
** export
@endmindmap`,
  },
  {
    id: 'json',
    draws: true,
    probeViz: true,
    source: `@startjson
{"engine": "plantuml", "layout": "smetana"}
@endjson`,
  },

  // ---- the kinds that cannot be drawn here, each because it is laid out by
  // Graphviz and Graphviz is not reachable from this page.
  { id: 'class', draws: false, probeViz: true, source: CLASS_DIAGRAM },
  {
    id: 'state',
    draws: false,
    probeViz: true,
    source: `@startuml
[*] --> Idle
Idle --> Running : start
Running --> Idle : stop
Running --> [*] : quit
@enduml`,
  },
  {
    id: 'component',
    draws: false,
    probeViz: true,
    source: `@startuml
package "extension" {
  [preview] --> [engine]
}
[engine] --> [renderer]
@enduml`,
  },
  {
    id: 'usecase',
    draws: false,
    probeViz: true,
    source: `@startuml
User -> (Preview a document)
User -> (Export a document)
@enduml`,
  },
  {
    // The legacy activity syntax, beside the modern one above. Same diagram
    // word, different implementation, opposite answer — which is exactly the
    // kind of detail a README gets wrong when nobody has measured it.
    id: 'activity-legacy',
    draws: false,
    probeViz: true,
    source: `@startuml
(*) --> "read the document"
"read the document" --> "render diagrams"
"render diagrams" --> (*)
@enduml`,
  },

  // ---- and the two that answer "yes, but what about…".
  {
    // The tempting fix, pinned as no fix at all. `!pragma graphviz_dot
    // smetana`, `!pragma smetana` and `!option smetana true` were measured
    // too, and all three behave identically to this one.
    id: 'class-pragma-smetana',
    draws: false,
    probeViz: true,
    source: CLASS_DIAGRAM.replace('@startuml\n', '@startuml\n!pragma layout smetana\n'),
  },
  {
    // What actually ships: no `Viz` declared anywhere, so the engine's own
    // error handling is what a reader meets. Kept because the failure it
    // produces is the one the preview has to survive.
    id: 'class-faithful',
    draws: false,
    probeViz: false,
    source: CLASS_DIAGRAM,
  },
];

/**
 * One case's document.
 *
 * The client half of the preview in miniature: a classic script carrying the
 * nonce, `import()` for the engine, `render(lines, id, {dark})`, and
 * `md-init.js`'s own 80 ms poll for the `<svg>`. The one addition is the
 * settle condition — an uncaught error ends the wait too, so a diagram that
 * has already died does not hold the suite for the full budget.
 */
function pageFor(probe: Probe, index: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${probe.id}</title></head>
<body class="vscode-light">
<div class="markdown-body"><div class="plantuml" id="${probe.id}"></div></div>
<script nonce="${NONCE}">
(function () {
  var errors = [];
  var viz = ${probe.probeViz ? '0' : 'null'};
  ${probe.probeViz
    ? `Object.defineProperty(window, 'Viz', { get: function () { viz++; return undefined; } });`
    : ''}
  window.addEventListener('error', function (e) { errors.push(String(e.message)); });
  window.addEventListener('unhandledrejection', function (e) {
    errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason));
  });
  var SOURCE = ${JSON.stringify(probe.source)};
  var ID = ${JSON.stringify(probe.id)};

  function settle(el) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function poll() {
        if (el.querySelector('svg')) { resolve(); return; }
        if (errors.length) { resolve(); return; }
        if (Date.now() - start > ${CASE_BUDGET_MS}) { resolve(); return; }
        window.setTimeout(poll, 80);
      })();
    });
  }

  function report(out) {
    window.location.href = '/report?i=${index}&r=' + encodeURIComponent(JSON.stringify(out));
  }

  (async function () {
    var el = document.getElementById(ID);
    var t0 = Date.now();
    var render;
    try {
      render = (await import('/rich/plantuml.js')).render;
    } catch (err) {
      report({ id: ID, ok: false, viz: viz, texts: 0, width: null, height: null,
               errors: 'import failed: ' + err, ms: Date.now() - t0 });
      return;
    }
    try {
      render(SOURCE.split('\\n'), ID, { dark: false });
    } catch (err) {
      errors.push('threw: ' + err);
    }
    await settle(el);
    var svg = el.querySelector('svg');
    report({
      id: ID,
      ok: !!svg,
      viz: viz,
      texts: svg ? svg.querySelectorAll('text').length : 0,
      width: svg ? svg.getAttribute('width') : null,
      height: svg ? svg.getAttribute('height') : null,
      errors: errors.join(' | '),
      ms: Date.now() - t0,
    });
  })();
})();
</script>
</body></html>`;
}

const outcomes = new Map<string, Outcome>();
let server: Server | undefined;
let chrome: ChildProcess | undefined;
let profile = '';

/** Resolves when the last case has reported. Set by {@link startServer}. */
let allReported: Promise<void> = Promise.resolve();

/** Serve the cases, collect the reports, and chain each page to the next. */
function startServer(): Promise<number> {
  const engine = readFileSync(PLANTUML);
  let done: () => void = () => {};
  allReported = new Promise<void>((resolve) => (done = resolve));

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/rich/plantuml.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Security-Policy': CSP,
      });
      res.end(engine);
      return;
    }

    if (url.pathname === '/report') {
      const index = Number(url.searchParams.get('i'));
      try {
        const outcome = JSON.parse(url.searchParams.get('r') ?? '{}') as Outcome;
        outcomes.set(outcome.id, outcome);
      } catch {
        /* a malformed report shows up as a missing outcome, and the assertions say so */
      }
      const next = index + 1;
      if (next < CASES.length) {
        res.writeHead(302, { Location: `/case/${next}` }).end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>done</title>');
        done();
      }
      return;
    }

    const match = /^\/case\/(\d+)$/.exec(url.pathname);
    if (match) {
      const index = Number(match[1]);
      const probe = CASES[index];
      if (!probe) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': CSP,
      });
      res.end(pageFor(probe, index));
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise<number>((resolve) => {
    // Port 0: the OS picks a free one, so two suites — or a developer's own
    // server — can never collide.
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

beforeAll(async () => {
  if (!CHROME) return;

  const port = await startServer();
  profile = mkdtempSync(path.join(tmpdir(), 'md-plantuml-csp-'));

  let stderr = '';
  chrome = spawn(
    CHROME,
    [
      // `--headless=new` is Chrome 112 and later; nothing older is going to be
      // on a machine running this suite.
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      // A profile of our own, in the system temp directory and removed
      // afterwards: this must never touch the developer's own Chrome.
      `--user-data-dir=${profile}`,
      // Containers run as root, where Chrome's own sandbox refuses to start.
      // Only ever relaxed there — never on a developer's machine.
      ...(process.env.CI || process.getuid?.() === 0
        ? ['--no-sandbox', '--disable-dev-shm-usage']
        : []),
      `http://127.0.0.1:${port}/case/0`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  chrome.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

  // Two ways for this to end badly, and both say why rather than hanging: the
  // browser exits before it has reported (it could not start at all, or died),
  // or it is simply still going long after the cases' own budgets could have
  // expired. Chrome's stderr is carried into either message, because on a
  // machine where this fails that is the only evidence there is.
  const died = new Promise<never>((_, reject) => {
    chrome!.once('exit', (code) =>
      reject(
        new Error(
          `the browser exited (code ${code}) before the cases finished; ` +
            `${outcomes.size} of ${CASES.length} reported.\nchrome said:\n${stderr}`,
        ),
      ),
    );
  });
  const watchdog = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`the browser never finished the cases.\nchrome said:\n${stderr}`)),
      CASE_BUDGET_MS * CASES.length + 60000,
    ).unref(),
  );
  await Promise.race([allReported, died, watchdog]);

  // The measurements themselves, on request. An assertion says which
  // expectation broke; this says what the browser actually reported, which is
  // what anyone re-opening this question will want first.
  if (process.env.MD_CSP_DUMP) {
    console.log(JSON.stringify([...outcomes.values()], null, 2));
  }
}, 180_000);

afterAll(() => {
  chrome?.kill('SIGKILL');
  server?.close();
  if (profile) {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* a leftover temp profile is not worth failing a suite over */
    }
  }
});

const outcome = (id: string): Outcome => {
  const found = outcomes.get(id);
  if (!found) throw new Error(`no report for "${id}" — the harness did not get that far`);
  return found;
};

describe.skipIf(!CHROME)('PlantUML under the built-in preview CSP', () => {
  // The kinds that draw are as load-bearing as the kinds that do not: they are
  // what proves the engine loads, measures real text and draws, in this very
  // page, under this very policy. Without them a broken harness would read as
  // a damning finding about PlantUML.
  for (const probe of CASES.filter((c) => c.draws)) {
    it(`draws a ${probe.id} diagram, without ever reading the global Viz`, () => {
      const o = outcome(probe.id);
      expect(o.ok).toBe(true);
      expect(o.viz).toBe(0);
      // A drawing with no text is not a drawing — that is exactly what a
      // headless Mermaid produces. Assert the labels are really in there
      // rather than trusting the element's existence.
      expect(o.texts).toBeGreaterThan(0);
      expect(o.errors).toBe('');
    });
  }

  // The finding itself.
  for (const probe of CASES.filter((c) => !c.draws && c.probeViz && c.id !== 'class-pragma-smetana')) {
    it(`cannot draw a ${probe.id} diagram: it reads the global Viz, once, and dies`, () => {
      const o = outcome(probe.id);
      expect(o.viz).toBe(1);
      expect(o.ok).toBe(false);
      expect(o.texts).toBe(0);
    });
  }

  // The tempting fix, pinned as no fix at all, so that "why not just prepend
  // the pragma?" has an answer that is a measurement rather than an opinion.
  it('is not rescued by !pragma layout smetana', () => {
    const o = outcome('class-pragma-smetana');
    expect(o.viz).toBe(1);
    expect(o.ok).toBe(false);
  });

  // What ships: no `Viz` declared anywhere, so the engine's own error handling
  // is what a reader meets. It fails inside TeaVM's exception conversion, which
  // is why nothing is drawn *and* nothing is written into the block — the
  // restore in `renderPlantUml` is what puts the source back on screen.
  it('fails the same way with no Viz declared at all, and says so uncaught', () => {
    const o = outcome('class-faithful');
    expect(o.ok).toBe(false);
    expect(o.viz).toBe(null);
    expect(o.errors).toContain('$jsException');
  });

  // The two halves of the same engine, in one assertion, because it is the
  // sentence the README has to be able to write: the boundary is the layout
  // engine, not the diagram's age or its complexity.
  it('splits exactly along PlantUML own layout versus Graphviz', () => {
    const drew = [...outcomes.values()].filter((o) => o.ok).map((o) => o.id);
    const did_not = [...outcomes.values()].filter((o) => !o.ok).map((o) => o.id);
    expect(drew).toEqual(['sequence', 'activity', 'mindmap', 'json']);
    expect(did_not).toEqual([
      'class',
      'state',
      'component',
      'usecase',
      'activity-legacy',
      'class-pragma-smetana',
      'class-faithful',
    ]);
  });
});

// A machine with no browser must not report a green PlantUML story it never
// tested. This one always runs, and says which it was.
describe('the PlantUML CSP experiment itself', () => {
  it('ran in a real browser, or skipped for the absence of one', () => {
    if (!CHROME) {
      console.warn(
        '[md] PlantUML/CSP experiment skipped: no Chrome or Chromium found. ' +
          'Set MD_CHROME to run it.',
      );
    }
    expect(CHROME === null || outcomes.size === CASES.length).toBe(true);
  });
});
