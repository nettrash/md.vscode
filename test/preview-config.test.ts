//
//  preview-config.test.ts
//  md.vscode — the settings layer, and the one element the preview lets us own.
//
//  WHY THIS FILE EXISTS
//  --------------------
//  Everything else in `test/` covers `src/render/**`, the parity core, and does
//  it very well. Nothing covered `src/preview/**` at all, because it imports
//  `vscode` — and the bug this suite was written after lived in exactly that gap:
//  `md.preview.theme: "editor"` did nothing whatever, for two reasons at once
//  (the stylesheet keyed the mode off a selector nothing could match, and the two
//  font stacks were emitted as an inline style that no rule can outrank). Neither
//  was a rendering bug in the sense the golden tests understand. Both were
//  invisible to a suite that stops at the layering boundary.
//
//  The stylesheet half is proved in a browser, because a cascade is the only
//  thing that can answer a question about a cascade — see the harness under
//  `scratchpad/probe/harness`. This file pins the other half: the markup and the
//  settings that feed it, which is where a regression would be reintroduced.
//
//  `vscode` is aliased to `test/vscode-stub.ts` by `vitest.config.ts`.
//

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { changeEvent, ColorThemeKind, stub } from './vscode-stub';
import {
  affectsPreview,
  isDarkTheme,
  readConfig,
  wrapperAttributes,
  type MdConfig,
} from '../src/preview/config';
import {
  formatEngineList,
  RENDER_ATTRIBUTE,
  wantedEngines,
  type ClientEngine,
} from '../src/preview/engines';
import { extendMarkdownIt } from '../src/preview/markdownItHook';
import { setRichRoot } from '../src/engines/paths';
import { warmUp } from '../src/engines/graphviz';

// The stub's event and Uri shapes are structurally what the functions read, but
// not the full editor interfaces, so the two call sites below take a cast. It is
// confined to these helpers rather than sprayed through the assertions.
const affects = (...sections: readonly string[]): boolean =>
  affectsPreview(changeEvent(...sections) as never);

describe('readConfig — defaults', () => {
  beforeEach(() => stub());

  // The headline change: md's own paper is now the opt-in and the editor's
  // clothes are what a reader gets without asking. If this flips back, the
  // extension has quietly stopped looking like the editor it lives in.
  it('defaults the theme to editor, not paper', () => {
    expect(readConfig().theme).toBe('editor');
  });

  // Empty means "follow the theme", and it is load-bearing rather than tidy:
  // `wrapperAttributes` turns a non-empty value into an INLINE custom property,
  // which outranks every rule in the stylesheet on the element the mode rules
  // target. A non-empty default would therefore pin md's typewriter faces over
  // the top of editor mode with no way for CSS to undo it.
  it('defaults both font stacks to the empty string', () => {
    expect(readConfig().bodyFont).toBe('');
    expect(readConfig().codeFont).toBe('');
  });

  it('defaults every engine to on and the page size to A4', () => {
    const c = readConfig();
    // Six, not five: `plot` joined them, and it is the odd one out — there is
    // no engine behind it, so switching it off loads nothing less. It is a
    // setting because the other four are, and because a reader who wants the
    // source of a figure should be able to see it.
    expect([c.math, c.mermaid, c.graphviz, c.plantuml, c.plot, c.highlight]).toEqual([
      true, true, true, true, true, true,
    ]);
    expect(c.pageSize).toBe('A4');
  });

  it('reads md.diagrams.plot', () => {
    stub({ 'diagrams.plot': false });
    expect(readConfig().plot).toBe(false);
    stub({ 'diagrams.plot': true });
    expect(readConfig().plot).toBe(true);
  });
});

describe('readConfig — the theme id', () => {
  it('round-trips paper now that it is no longer the default', () => {
    // The regression this guards: with `editor` as the default, the shorter
    // `raw === 'editor' ? 'editor' : DEFAULT` form maps `paper` onto `editor`
    // too, and the setting reads as ignored rather than as wrong.
    stub({ 'preview.theme': 'paper' });
    expect(readConfig().theme).toBe('paper');
  });

  it('round-trips editor', () => {
    stub({ 'preview.theme': 'editor' });
    expect(readConfig().theme).toBe('editor');
  });

  it('falls back to the default for a value that is not a theme id', () => {
    stub({ 'preview.theme': 'sepia' });
    expect(readConfig().theme).toBe('editor');
    stub({ 'preview.theme': 42 });
    expect(readConfig().theme).toBe('editor');
  });
});

describe('readConfig — the font sanitiser', () => {
  it('keeps a perfectly ordinary stack intact', () => {
    stub({ 'preview.bodyFont': '"Iowan Old Style", Georgia, serif' });
    expect(readConfig().bodyFont).toBe('"Iowan Old Style", Georgia, serif');
  });

  it('keeps a face named in a non-Latin script', () => {
    stub({ 'preview.bodyFont': 'PingFang SC, Гарнитура, serif' });
    expect(readConfig().bodyFont).toBe('PingFang SC, Гарнитура, serif');
  });

  // The setting is `resource`-scoped, so a workspace `.vscode/settings.json` —
  // which arrives with a cloned repository — can set it. The value is
  // interpolated into a `style` attribute, so the punctuation that ends one
  // declaration and begins another has to go.
  it('strips the punctuation with which one declaration becomes two', () => {
    stub({ 'preview.bodyFont': 'serif; background: url(https://evil/x)' });
    const stack = readConfig().bodyFont;
    expect(stack).not.toContain(';');
    expect(stack).not.toContain(':');
    expect(stack).not.toContain('(');
    expect(stack).not.toContain('/');
  });

  it('treats an all-punctuation value as unset rather than emitting an empty declaration', () => {
    // `--md-body-font:` with nothing after it is invalid, and an invalid
    // declaration takes its whole rule down with it.
    stub({ 'preview.bodyFont': ';;;{}', 'preview.codeFont': '   ' });
    expect(readConfig().bodyFont).toBe('');
    expect(readConfig().codeFont).toBe('');
  });

  it('treats a non-string value as unset', () => {
    stub({ 'preview.bodyFont': 12, 'preview.codeFont': null });
    expect(readConfig().bodyFont).toBe('');
    expect(readConfig().codeFont).toBe('');
  });
});

describe('wrapperAttributes', () => {
  const config = (over: Partial<MdConfig> = {}): MdConfig => {
    stub();
    return { ...readConfig(), ...over };
  };

  it('names the class the stylesheet keys the mode off', () => {
    // If this string ever changes, `media/preview/md-preview.css` changes with
    // it — every mode rule, the `:has()` frame rule and the whole hljs block
    // select on it. Grep for `md-preview-root` before touching either.
    expect(wrapperAttributes(config(), false)).toContain('class="md-preview-root"');
  });

  it('carries the mode and the light/dark state as attributes', () => {
    expect(wrapperAttributes(config({ theme: 'paper' }), true)).toBe(
      'class="md-preview-root" data-md-theme="paper" data-md-dark="1"',
    );
    expect(wrapperAttributes(config({ theme: 'editor' }), false)).toBe(
      'class="md-preview-root" data-md-theme="editor" data-md-dark="0"',
    );
  });

  // The heart of the fix. An inline declaration beats every rule in every
  // stylesheet whatever the specificity, and these are the very properties the
  // mode rules set on this very element — so emitting them unconditionally makes
  // the theme setting unreachable for ever.
  it('emits NO style attribute when the reader has set no font', () => {
    expect(wrapperAttributes(config(), false)).not.toContain('style=');
  });

  it('emits only the font the reader actually set', () => {
    expect(wrapperAttributes(config({ bodyFont: 'Charter' }), false)).toContain(
      'style="--md-body-font:Charter"',
    );
    expect(wrapperAttributes(config({ codeFont: 'Menlo' }), false)).toContain(
      'style="--md-code-font:Menlo"',
    );
  });

  it('joins two declarations with a semicolon and no trailing one', () => {
    expect(wrapperAttributes(config({ bodyFont: 'Charter', codeFont: 'Menlo' }), false)).toContain(
      'style="--md-body-font:Charter;--md-code-font:Menlo"',
    );
  });

  it('escapes the value it interpolates', () => {
    // Belt to the sanitiser's braces: the quote is what would close the
    // attribute, and it is the one unsafe character the sanitiser allows
    // through, because a font stack legitimately contains quoted family names.
    expect(wrapperAttributes(config({ bodyFont: '"Iowan Old Style", serif' }), false)).toContain(
      'style="--md-body-font:&quot;Iowan Old Style&quot;, serif"',
    );
  });
});

describe('isDarkTheme', () => {
  // The classic bug: the enum reads as though `HighContrast` were neutral, when
  // it is specifically the *dark* high-contrast theme. The apps map it the same
  // way (port spec F-34), and Mermaid's theme and PlantUML's dark flag both
  // follow this one boolean.
  it('maps the four theme kinds onto the apps two states', () => {
    stub({}, ColorThemeKind.Light);
    expect(isDarkTheme()).toBe(false);
    stub({}, ColorThemeKind.Dark);
    expect(isDarkTheme()).toBe(true);
    stub({}, ColorThemeKind.HighContrast);
    expect(isDarkTheme()).toBe(true);
    stub({}, ColorThemeKind.HighContrastLight);
    expect(isDarkTheme()).toBe(false);
  });
});

describe('affectsPreview', () => {
  it('fires for every setting the preview draws from', () => {
    expect(affects('md.preview.theme')).toBe(true);
    expect(affects('md.preview.bodyFont')).toBe(true);
    expect(affects('md.math.enabled')).toBe(true);
    expect(affects('md.diagrams.mermaid')).toBe(true);
    expect(affects('md.highlight.enabled')).toBe(true);
  });

  it('stays quiet for the export settings, which change nothing on screen', () => {
    // A refresh costs a full re-render of every open preview, plus another
    // Mermaid pass on a diagram-heavy document. `md.export.pageSize` is worth
    // none of that.
    expect(affects('md.export.pageSize')).toBe(false);
    expect(affects('editor.fontFamily')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  The settings channel: what the host writes, and what the preview reads back
// ---------------------------------------------------------------------------
//
//  Everything above this line is the host's half. The two halves below are the
//  bug the file was extended for: `md.diagrams.mermaid` and
//  `md.diagrams.plantuml` are read in the extension host, and the engines they
//  switch off run in a page the host cannot speak to. The wanted engines
//  therefore travel as `data-md-render` on the wrapper — which the host wrote
//  from the first version and the client never read, so for two releases both
//  settings did nothing in the preview while the README said they did.
//
//  So both ends are pinned here: `wantedEngines` against a fake element (no
//  DOM, no browser — it is a pure function over one attribute), and the markup
//  the hook actually emits, driven through `extendMarkdownIt` with a
//  markdown-it stub, because the value is built from the settings *and* from
//  what the document turned out to contain.
//

describe('wantedEngines — reading the settings back in the page', () => {
  /** An element, as much of one as the reader touches. */
  const element = (value: string | null) => ({
    getAttribute: (name: string) => (name === RENDER_ATTRIBUTE && value !== null ? value : null),
  });

  /** A root whose wrapper is a descendant — the shape the pass really meets. */
  const root = (value: string | null) => ({
    querySelector: (selector: string) =>
      selector === `[${RENDER_ATTRIBUTE}]` && value !== null ? element(value) : null,
  });

  it('reads both engines off the wrapper itself', () => {
    const wanted = wantedEngines(element('mermaid plantuml'));
    expect([...wanted]).toEqual(['mermaid', 'plantuml']);
  });

  it('finds the wrapper below the root it is given', () => {
    expect([...wantedEngines(root('plantuml'))]).toEqual(['plantuml']);
  });

  // The empty value is a statement, not a missing one: "this document has no
  // diagram you should draw". It is what stops the client fetching 3.5 MB of
  // Mermaid or 7.4 MB of PlantUML for a document that contains neither.
  it('treats an empty value as no engines at all', () => {
    expect([...wantedEngines(element(''))]).toEqual([]);
    expect(wantedEngines(element('   ')).size).toBe(0);
  });

  // Absent means the markup is not ours — VS Code renders fragments for its own
  // features and for `markdown.api.render`, and our renderer hands those back to
  // markdown-it untouched. Rendering into one of those would be drawing in
  // somebody else's document.
  it('treats an absent attribute, and no root at all, as no engines', () => {
    expect(wantedEngines(element(null)).size).toBe(0);
    expect(wantedEngines(root(null)).size).toBe(0);
    expect(wantedEngines(null).size).toBe(0);
    expect(wantedEngines(undefined).size).toBe(0);
  });

  it('ignores a word it does not know, and keeps the ones it does', () => {
    // A newer host writing an engine this build has never heard of must not
    // take the two it does know down with it.
    expect([...wantedEngines(element('mermaid typst plantuml'))]).toEqual(['mermaid', 'plantuml']);
    expect([...wantedEngines(element('typst'))]).toEqual([]);
  });

  it('round-trips every combination through the emitter and the reader', () => {
    for (const combination of [[], ['mermaid'], ['plantuml'], ['plantuml', 'mermaid']] as const) {
      const value = formatEngineList(combination as readonly ClientEngine[]);
      expect([...wantedEngines(element(value))].sort()).toEqual([...combination].sort());
    }
    // The emitter's order is the canonical one whatever order it is handed.
    expect(formatEngineList(['plantuml', 'mermaid'])).toBe('mermaid plantuml');
  });
});

describe('the markup the hook emits, per switch', () => {
  // A document with one of everything, so a single render answers all six
  // questions. Assembled from lines rather than a template literal because it
  // is full of fences.
  const DOCUMENT = [
    '# Everything',
    '',
    'An inline formula $x^2$ in a sentence.',
    '',
    '```mermaid',
    'graph TD; A-->B;',
    '```',
    '',
    '```plantuml',
    '@startuml',
    'Alice -> Bob: hi',
    '@enduml',
    '```',
    '',
    '```dot',
    'digraph { a -> b }',
    '```',
    '',
    '```plot',
    'sin(x)',
    '```',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
  ].join('\n');

  /**
   * Enough of markdown-it for the hook to hook.
   *
   * `extendMarkdownIt` pushes a core rule and replaces `renderer.render`; the
   * source is remembered against the token array the rule sees, so the fake has
   * to hand the same array back from `parse` — which is the very property the
   * real VS Code cache has and the reason the WeakMap is keyed that way.
   */
  function render(source: string): string {
    const rules: ((state: { src: string; env: unknown; tokens: unknown[] }) => void)[] = [];
    const md = {
      core: { ruler: { push: (_name: string, rule: (typeof rules)[number]) => rules.push(rule) } },
      parse(src: string, env: unknown): unknown[] {
        const tokens: unknown[] = [];
        for (const rule of rules) rule({ src, env, tokens });
        return tokens;
      },
      renderer: {
        // The three parameters are markdown-it's own, and they have to be
        // declared even though this stub ignores them: `extendMarkdownIt`
        // wraps this function and calls it with all three on the fallback
        // path, which is the path a token stream we did not parse must take.
        render: (_tokens: unknown, _options: unknown, _env: unknown) =>
          'MARKDOWN-IT WOULD HAVE RENDERED THIS',
      },
    };
    extendMarkdownIt(md);
    const env = {};
    const tokens = md.parse(source, env);
    return md.renderer.render(tokens, {}, env);
  }

  /** The `data-md-render` value the wrapper carries, or `null` if it has none. */
  const engineAttribute = (html: string): string | null => {
    const match = new RegExp(`${RENDER_ATTRIBUTE}="([^"]*)"`).exec(html);
    return match ? match[1] : null;
  };

  beforeAll(async () => {
    setRichRoot(path.resolve(__dirname, '..'));
    // Graphviz compiles ~1.4 MB of WebAssembly on first use and
    // `renderGraphvizSync` returns null until it has. Without this the
    // "graphviz on" case would look exactly like the "graphviz off" one, and
    // the test would pass for the wrong reason.
    await warmUp();
  });

  it('renders md own body rather than markdown-it, and wraps it', () => {
    stub();
    const html = render(DOCUMENT);
    expect(html).not.toContain('MARKDOWN-IT WOULD HAVE RENDERED THIS');
    expect(html).toContain('class="md-preview-root"');
  });

  // --- the two the client runs, which is where the bug was ------------------

  it('names both client engines when the document has both and neither is off', () => {
    stub();
    expect(engineAttribute(render(DOCUMENT))).toBe('mermaid plantuml');
  });

  it('drops mermaid from the attribute when md.diagrams.mermaid is off', () => {
    stub({ 'diagrams.mermaid': false });
    const html = render(DOCUMENT);
    expect(engineAttribute(html)).toBe('plantuml');
    // And the block is still there with its source in it, which is what "off"
    // has to look like: readable, never blank and never an error box. The
    // class carries VS Code's `code-line` too — hence the pattern rather than
    // an exact string, so a scroll-sync change cannot fail this for no reason.
    expect(html).toMatch(/<pre class="mermaid[^>]*>graph TD; A--&gt;B;<\/pre>/);
  });

  it('drops plantuml from the attribute when md.diagrams.plantuml is off', () => {
    stub({ 'diagrams.plantuml': false });
    const html = render(DOCUMENT);
    expect(engineAttribute(html)).toBe('mermaid');
    expect(html).toMatch(/<div class="plantuml[^>]*>@startuml\nAlice -&gt; Bob: hi\n@enduml<\/div>/);
  });

  it('emits an empty attribute when both are off, and when the document has neither', () => {
    stub({ 'diagrams.mermaid': false, 'diagrams.plantuml': false });
    expect(engineAttribute(render(DOCUMENT))).toBe('');
    stub();
    expect(engineAttribute(render('# Just prose\n\nNothing to draw.\n'))).toBe('');
  });

  // The end-to-end shape of the fix: what the host writes is what the client
  // will act on, through the same pair of functions.
  it('hands the client exactly the engines the settings left on', () => {
    stub({ 'diagrams.mermaid': false });
    const value = engineAttribute(render(DOCUMENT));
    const wrapper = { getAttribute: (name: string) => (name === RENDER_ATTRIBUTE ? value : null) };
    expect([...wantedEngines(wrapper)]).toEqual(['plantuml']);
  });

  // --- the four that are rendered in the host, checked in both directions ---

  it('honours md.math.enabled', () => {
    stub();
    expect(render(DOCUMENT)).toContain('class="katex"');
    stub({ 'math.enabled': false });
    const off = render(DOCUMENT);
    expect(off).not.toContain('class="katex"');
    expect(off).toContain('<span class="md-mathi">x^2</span>');
  });

  it('honours md.highlight.enabled', () => {
    stub();
    expect(render(DOCUMENT)).toContain('hljs-keyword');
    stub({ 'highlight.enabled': false });
    const off = render(DOCUMENT);
    expect(off).not.toContain('hljs-keyword');
    expect(off).toMatch(/<code class="language-js[^>]*>const a = 1;<\/code>/);
  });

  it('honours md.diagrams.graphviz', () => {
    stub();
    expect(render(DOCUMENT)).toMatch(/<div class="graphviz[^>]*data-engine="dot"[^>]*><svg/);
    stub({ 'diagrams.graphviz': false });
    const off = render(DOCUMENT);
    expect(off).toMatch(/<div class="graphviz[^>]*>digraph \{ a -&gt; b \}<\/div>/);
    // The plot is still drawn, so `<svg` on its own would prove nothing: what
    // must be gone is the one inside the Graphviz container.
    expect(off).not.toMatch(/<div class="graphviz[^>]*><svg/);
  });

  it('honours md.diagrams.plot', () => {
    stub();
    expect(render(DOCUMENT)).toMatch(/<div class="plot[^>]*><svg/);
    stub({ 'diagrams.plot': false });
    expect(render(DOCUMENT)).toMatch(/<div class="plot[^>]*><pre>sin\(x\)<\/pre><\/div>/);
  });
});
