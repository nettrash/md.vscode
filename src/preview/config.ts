//
//  config.ts
//  md.vscode — the `md.*` settings, read once per render, and the handful of
//  attributes by which they reach a preview we do not own.
//
//  THE CONSTRAINT THAT SHAPES THIS FILE
//  ------------------------------------
//  Everywhere else in the family the host talks to its web view: macOS calls
//  `evaluateJavaScript`, Android calls `evaluateJavascript`, and a setting
//  change is a message. VS Code's built-in Markdown preview belongs to
//  another extension. We have no `WebviewPanel`, no `postMessage`, and no
//  handle on the document object. The *only* channel from the host to that
//  page is the HTML we return from `extendMarkdownIt`.
//
//  So every preference that the client script or the stylesheet needs must be
//  written into the markup itself, on the one wrapper element we emit:
//
//      <div class="md-preview-root"
//           data-md-theme="paper"      which palette the sheet should draw
//           data-md-dark="1"           the apps' own light/dark switch
//           style="--md-body-font:…;--md-code-font:…">
//
//  `data-md-dark` deserves its name: in the apps it sits on `<body>` and it is
//  what picks Mermaid's theme and PlantUML's dark flag (port spec rule 74) —
//  the CSS never decides that. `<body>` is VS Code's, so the attribute moves
//  to our wrapper and the client reads it from there.
//
//  WHY THE FONT STACKS ARE SANITISED AND NOT MERELY ESCAPED
//  -------------------------------------------------------
//  `md.preview.bodyFont` is a `resource`-scoped setting, which means a
//  repository can set it in its own `.vscode/settings.json`. That string ends
//  up inside a `style="…"` attribute, and the built-in preview ships
//  `style-src … 'unsafe-inline'` together with `img-src … https:`. A stack of
//  `serif; background: url(https://…)` would therefore be a working
//  exfiltration channel opened by a cloned repository. HTML-escaping alone
//  does not help — the parser un-escapes before CSS ever sees the value.
//  So the value is first reduced to characters that cannot start a new
//  declaration or a `url()`, and only then escaped for the attribute.
//

import * as vscode from 'vscode';

import { escapeHTML } from '../render/inline';

/** Which palette the preview draws in. Mirrors `md.preview.theme`. */
export type PreviewTheme = 'paper' | 'editor';

/** Mirrors `md.export.pageSize`; the ids are shared verbatim with the apps. */
export type PageSizeId = 'A4' | 'A5' | 'Letter' | 'Legal' | '6x9' | '5x8' | '5.5x8.5';

/**
 * Every `md.*` setting, resolved for one resource.
 *
 * Read afresh on each render rather than cached: `getConfiguration` is cheap,
 * the scope is `resource`, and a cache would have to be invalidated on
 * `onDidChangeConfiguration`, on folder changes and on language-override
 * changes — three chances to serve a stale palette.
 */
export interface MdConfig {
  readonly theme: PreviewTheme;
  /** Already sanitised and safe to interpolate into a `style` attribute. */
  readonly bodyFont: string;
  /** Already sanitised and safe to interpolate into a `style` attribute. */
  readonly codeFont: string;
  readonly math: boolean;
  readonly mermaid: boolean;
  readonly graphviz: boolean;
  readonly plantuml: boolean;
  readonly highlight: boolean;
  readonly pageSize: PageSizeId;
}

/** The configuration section. One constant so a rename is one edit. */
export const CONFIG_SECTION = 'md';

/**
 * The defaults, which must stay identical to `contributes.configuration` in
 * `package.json`.
 *
 * They are repeated here rather than trusted to `getConfiguration`, because
 * `get<T>(key)` returns `undefined` for a key the running manifest does not
 * declare — which is exactly what happens to a user mid-upgrade, and a
 * `undefined` font stack renders the whole document in the browser default.
 */
const DEFAULTS = {
  theme: 'paper' as PreviewTheme,
  bodyFont: '"American Typewriter", Georgia, "Times New Roman", serif',
  codeFont: '"Courier New", ui-monospace, monospace',
  pageSize: 'A4' as PageSizeId,
} as const;

const PAGE_SIZES: readonly PageSizeId[] = ['A4', 'A5', 'Letter', 'Legal', '6x9', '5x8', '5.5x8.5'];

/**
 * Characters a font stack may contain.
 *
 * Letters, marks and digits from *any* script, so a Chinese or Cyrillic face
 * can be named; plus space, comma, full stop, hyphen, underscore and both
 * quote marks, which is everything CSS needs for a font-family list. Notably
 * absent: `;` `:` `{` `}` `(` `)` `/` `\` `<` `>` `@` — the punctuation with
 * which one declaration becomes two.
 */
const UNSAFE_IN_FONT_STACK = /[^\p{L}\p{M}\p{N} ,._'"-]/gu;

/** Read every `md.*` setting for `resource` (a document URI, when there is one). */
export function readConfig(resource?: vscode.Uri): MdConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION, resource ?? null);

  return {
    theme: c.get<string>('preview.theme') === 'editor' ? 'editor' : DEFAULTS.theme,
    bodyFont: sanitiseFontStack(c.get<string>('preview.bodyFont'), DEFAULTS.bodyFont),
    codeFont: sanitiseFontStack(c.get<string>('preview.codeFont'), DEFAULTS.codeFont),
    math: c.get<boolean>('math.enabled') !== false,
    mermaid: c.get<boolean>('diagrams.mermaid') !== false,
    graphviz: c.get<boolean>('diagrams.graphviz') !== false,
    plantuml: c.get<boolean>('diagrams.plantuml') !== false,
    highlight: c.get<boolean>('highlight.enabled') !== false,
    pageSize: pageSize(c.get<string>('export.pageSize')),
  };
}

/**
 * The apps' two-state light/dark switch, derived from the workbench theme.
 *
 * Four kinds map onto two states, and the mapping is the apps' (F-34):
 * `HighContrast` is the *dark* high-contrast theme, `HighContrastLight` the
 * light one. Getting that pair the wrong way round is the classic bug — the
 * enum reads as though `HighContrast` were neutral.
 */
export function isDarkTheme(): boolean {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
}

/**
 * Does this configuration change affect what the preview renders?
 *
 * Deliberately narrower than `affectsConfiguration('md')`: `md.export.*`
 * changes nothing on screen, and a refresh costs a full re-render of every
 * open preview plus, on a diagram-heavy document, another Mermaid pass.
 */
export function affectsPreview(e: vscode.ConfigurationChangeEvent): boolean {
  return (
    e.affectsConfiguration('md.preview') ||
    e.affectsConfiguration('md.math') ||
    e.affectsConfiguration('md.diagrams') ||
    e.affectsConfiguration('md.highlight')
  );
}

/**
 * The attribute list for the wrapper element, without the angle brackets.
 *
 * Returned as a string rather than a record because the caller is building
 * markup by concatenation, exactly as `MarkdownHTML.swift` does, and an
 * intermediate object would only invite someone to reorder the attributes —
 * which changes the bytes for no gain.
 */
export function wrapperAttributes(config: MdConfig, dark: boolean): string {
  const style = `--md-body-font:${config.bodyFont};--md-code-font:${config.codeFont}`;
  return (
    `class="md-preview-root"` +
    ` data-md-theme="${config.theme}"` +
    ` data-md-dark="${dark ? '1' : '0'}"` +
    ` style="${escapeHTML(style)}"`
  );
}

function sanitiseFontStack(raw: string | undefined, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(UNSAFE_IN_FONT_STACK, '').trim();
  // An empty result means the user wrote something that was entirely
  // punctuation. Falling back is kinder than emitting `--md-body-font:` with
  // nothing after it, which is an invalid declaration the whole rule dies on.
  return cleaned.length > 0 ? cleaned : fallback;
}

function pageSize(raw: string | undefined): PageSizeId {
  return PAGE_SIZES.find((id) => id === raw) ?? DEFAULTS.pageSize;
}
