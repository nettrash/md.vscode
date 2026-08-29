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
//           data-md-theme="editor"     which palette and faces the sheet draws
//           data-md-dark="1"           the apps' own light/dark switch
//           style="--md-body-font:…">  ONLY when the reader overrode a font
//
//  `data-md-dark` deserves its name: in the apps it sits on `<body>` and it is
//  what picks Mermaid's theme and PlantUML's dark flag (port spec rule 74) —
//  the CSS never decides that. `<body>` is VS Code's, so the attribute moves
//  to our wrapper and the client reads it from there.
//
//  `data-md-theme` is on the wrapper for the same reason, and the stylesheet
//  keys both of its modes off it there. It used to key them off
//  `body[data-md-theme]`, which nothing could ever set, so `"editor"` did
//  precisely nothing until this was fixed. If either name changes, both files
//  change together; grep for `md-preview-root` before touching this string.
//
//  WHY THE STYLE ATTRIBUTE IS CONDITIONAL
//  --------------------------------------
//  An inline declaration beats every rule in every stylesheet, whatever the
//  specificity on either side. `--md-body-font` and `--md-code-font` are also
//  exactly what the stylesheet's mode rules set, on exactly this element. So
//  emitting them unconditionally — as this did — pins md's typewriter faces
//  over the top of the editor theme for ever, and no rule in the sheet can
//  reach past them. The settings therefore default to the empty string,
//  meaning "follow the chosen theme", the per-mode defaults live in the
//  stylesheet where they belong, and the attribute appears only when the
//  reader has actually asked for a face of their own.
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

/**
 * Which palette *and* typography the preview draws in. Mirrors
 * `md.preview.theme`.
 *
 * `editor` is the default: colours from the current VS Code colour theme, and
 * the built-in preview's own fonts and metrics. `paper` is the opt-in that
 * makes the page match the iOS, macOS and Android apps.
 */
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
  /**
   * Already sanitised and safe to interpolate into a `style` attribute.
   * Empty when the reader has set no face of their own, which means "follow
   * the theme" and must be emitted as no declaration at all.
   */
  readonly bodyFont: string;
  /** As `bodyFont`: empty means "follow the theme". */
  readonly codeFont: string;
  readonly math: boolean;
  readonly mermaid: boolean;
  readonly graphviz: boolean;
  readonly plantuml: boolean;
  /**
   * `md.diagrams.plot`. Unlike its four neighbours this gates no engine —
   * the plot renderer is a pure function in `src/render/**` — so switching it
   * off costs nothing and only leaves the fence's source visible.
   */
  readonly plot: boolean;
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
  theme: 'editor' as PreviewTheme,
  // Empty, and emphatically not md's typewriter stack: see "why the style
  // attribute is conditional" above. The two stacks these used to hold now
  // live in `media/preview/md-preview.css`, one per mode.
  bodyFont: '',
  codeFont: '',
  pageSize: 'A4' as PageSizeId,
} as const;

const PREVIEW_THEMES: readonly PreviewTheme[] = ['paper', 'editor'];

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
    theme: previewTheme(c.get<string>('preview.theme')),
    bodyFont: sanitiseFontStack(c.get<string>('preview.bodyFont'), DEFAULTS.bodyFont),
    codeFont: sanitiseFontStack(c.get<string>('preview.codeFont'), DEFAULTS.codeFont),
    math: c.get<boolean>('math.enabled') !== false,
    mermaid: c.get<boolean>('diagrams.mermaid') !== false,
    graphviz: c.get<boolean>('diagrams.graphviz') !== false,
    plantuml: c.get<boolean>('diagrams.plantuml') !== false,
    plot: c.get<boolean>('diagrams.plot') !== false,
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
  // Built as a list so that "the reader set neither font" produces no `style`
  // attribute rather than an empty one — see the header. An empty attribute
  // would be harmless today, but it invites the next hand to write the
  // declarations back in unconditionally, which is the bug.
  const declarations: string[] = [];
  if (config.bodyFont) declarations.push(`--md-body-font:${config.bodyFont}`);
  if (config.codeFont) declarations.push(`--md-code-font:${config.codeFont}`);

  return (
    `class="md-preview-root"` +
    ` data-md-theme="${config.theme}"` +
    ` data-md-dark="${dark ? '1' : '0'}"` +
    (declarations.length > 0 ? ` style="${escapeHTML(declarations.join(';'))}"` : '')
  );
}

function previewTheme(raw: string | undefined): PreviewTheme {
  // A `find` over the known ids rather than `raw === 'editor' ? … : default`:
  // with `editor` now the default, that shorter form silently maps a
  // misspelt value *and the perfectly good `paper`* onto the default, which
  // is how a fixed default quietly becomes an ignored setting.
  return PREVIEW_THEMES.find((id) => id === raw) ?? DEFAULTS.theme;
}

function sanitiseFontStack(raw: string | undefined, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(UNSAFE_IN_FONT_STACK, '').trim();
  // An empty result means either an unset setting or a value that was entirely
  // punctuation. Both fall back to the empty string, i.e. "follow the theme":
  // emitting `--md-body-font:` with nothing after it would be an invalid
  // declaration that takes its whole rule down with it.
  return cleaned.length > 0 ? cleaned : fallback;
}

function pageSize(raw: string | undefined): PageSizeId {
  return PAGE_SIZES.find((id) => id === raw) ?? DEFAULTS.pageSize;
}
