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

import { beforeEach, describe, expect, it } from 'vitest';

import { changeEvent, ColorThemeKind, stub } from './vscode-stub';
import {
  affectsPreview,
  isDarkTheme,
  readConfig,
  wrapperAttributes,
  type MdConfig,
} from '../src/preview/config';

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
    expect([c.math, c.mermaid, c.graphviz, c.plantuml, c.highlight]).toEqual([
      true, true, true, true, true,
    ]);
    expect(c.pageSize).toBe('A4');
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
