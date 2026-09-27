//
//  vscode-stub.ts
//  The `vscode` module, as much of it as `src/preview/config.ts` actually
//  touches, so that the real module can be unit-tested outside an editor.
//
//  WHY A STUB AND NOT A REFACTOR
//  ----------------------------
//  The obvious alternative is to split `config.ts` into a pure half and a thin
//  `vscode`-reading half, and test only the pure one. That would move the very
//  code most worth testing — "what does an unset setting mean?" — into the half
//  nothing covers. The interesting behaviour of `readConfig` *is* its reading of
//  the host: `undefined` means unset, `!== false` means "on unless switched off",
//  and a misspelt theme id must not be mistaken for an unset one. All three are
//  only observable through a host, so the host is what gets faked.
//
//  Wired in by `test.alias` in `vitest.config.ts`. It is a stub of the editor and
//  not of anything of ours: `readConfig`, `wrapperAttributes`, `isDarkTheme` and
//  their private helpers are the shipping functions.
//
//  The state lives on `globalThis` rather than in module scope because Vitest
//  gives each test file its own module registry: a helper exported from here and
//  imported by the test would be a *different* instance from the one the aliased
//  import inside `config.ts` sees, and every write would land in the wrong copy.
//

/** Settings by key, exactly as `getConfiguration('md').get(key)` asks for them — no `md.` prefix. */
export type StubSettings = Record<string, unknown>;

/**
 * As much of a `TextDocument` as the argument-resolution rules read: which
 * file it is, and what language the editor thinks it is in.
 */
export interface StubDocument {
  readonly uri: { readonly scheme: string; readonly path: string; readonly fsPath: string };
  readonly languageId: string;
}

interface StubState {
  settings: StubSettings;
  themeKind: number;
  /** Section ids the pending change event claims to have touched. */
  changed: readonly string[];
  /** What `workspace.openTextDocument` will hand back, keyed by path. */
  documents: Record<string, StubDocument>;
  /** What `window.activeTextEditor` reports — null for "the focus is in a webview". */
  active: StubDocument | null;
  /** What `window.visibleTextEditors` reports, in the order the editor would. */
  visible: readonly StubDocument[];
  /** Every path `openTextDocument` was asked for, in order. */
  opened: string[];
}

/**
 * Read afresh on every call rather than captured, so a test may set it after the
 * module graph has been built.
 */
function state(): StubState {
  const g = globalThis as unknown as { __mdStub?: StubState };
  if (!g.__mdStub) g.__mdStub = empty();
  return g.__mdStub;
}

function empty(): StubState {
  return {
    settings: {},
    themeKind: 1,
    changed: [],
    documents: {},
    active: null,
    visible: [],
    opened: [],
  };
}

/** Point the stub at a fresh set of settings and a theme. Call it in `beforeEach`. */
export function stub(settings: StubSettings = {}, themeKind = 1, changed: readonly string[] = []): void {
  (globalThis as unknown as { __mdStub?: StubState }).__mdStub = {
    ...empty(),
    settings,
    themeKind,
    changed,
  };
}

/**
 * Point the stub at a set of editors: which documents exist on disk or in
 * memory, which one is focused, and which are on screen.
 *
 * Separate from `stub` rather than folded into it because the two halves are
 * read by different code — the settings half by `src/preview/config.ts`, this
 * half by `src/commands.ts` — and a test that cares about one should not have
 * to spell the other. It resets the editor half and leaves the settings alone.
 */
export function stubEditors(editors: {
  documents?: readonly StubDocument[];
  active?: StubDocument | null;
  visible?: readonly StubDocument[];
} = {}): void {
  const current = state();
  current.documents = {};
  for (const document of editors.documents ?? []) {
    current.documents[document.uri.path] = document;
  }
  current.active = editors.active ?? null;
  current.visible = editors.visible ?? [];
  current.opened = [];
}

/** A document for `stubEditors`, with the shape the real API gives a file uri. */
export function stubDocument(filePath: string, languageId = 'markdown'): StubDocument {
  return { uri: { scheme: 'file', path: filePath, fsPath: filePath }, languageId };
}

/** Every path `workspace.openTextDocument` has been asked for since `stubEditors`. */
export function openedPaths(): readonly string[] {
  return state().opened;
}

export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };

export const workspace = {
  getConfiguration: () => ({
    // No default argument and no type parameter: `get` in the real API returns
    // `T | undefined` for a key the user has not written, and that undefined is
    // the case the empty-string font defaults exist to serve.
    get: (key: string): unknown => state().settings[key],
  }),
  /**
   * The real call resolves to the **open** document when there is one and
   * reads the file otherwise, and rejects for a path it cannot read. All three
   * are observable here: a registered document comes back, an unregistered one
   * rejects, and every call is recorded so a test can prove that a command
   * given a uri never consulted the active editor.
   */
  openTextDocument: async (uri: { path: string }): Promise<StubDocument> => {
    const current = state();
    current.opened.push(uri.path);
    const document = current.documents[uri.path];
    if (document === undefined) throw new Error(`cannot open ${uri.path}`);
    return document;
  },
};

export const window = {
  get activeColorTheme(): { kind: number } {
    return { kind: state().themeKind };
  },
  get activeTextEditor(): { document: StubDocument } | undefined {
    const active = state().active;
    return active === null ? undefined : { document: active };
  },
  get visibleTextEditors(): readonly { document: StubDocument }[] {
    return state().visible.map((document) => ({ document }));
  },
};

/** A `ConfigurationChangeEvent` that admits to having touched the given sections. */
export function changeEvent(...sections: readonly string[]): {
  affectsConfiguration(section: string): boolean;
} {
  return {
    // Prefix matching, like the real implementation: a change to
    // `md.preview.theme` affects `md.preview` and `md`, and nothing else.
    affectsConfiguration: (section: string) =>
      sections.some((s) => s === section || s.startsWith(`${section}.`)),
  };
}

export const Uri = {
  file: (p: string): { scheme: string; path: string; fsPath: string; toString(): string } => ({
    scheme: 'file',
    path: p,
    fsPath: p,
    toString: () => `file://${p}`,
  }),
};

//
//  The diagnostic half of the editor.
//
//  `src/lint/diagnostics.ts` turns findings into `vscode.Diagnostic`s and
//  quick fixes into a `vscode.WorkspaceEdit`, and both of those are *classes*
//  the host provides — there is nothing to fake about the arithmetic, but
//  there is no way to construct one outside an editor either. So the shapes
//  below are the real ones, as much of them as that file touches, which is
//  what lets a test assert the thing that would actually be wrong: the
//  severity, the range, and the text a fix writes back.
//

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  // The real class takes either two Positions or four numbers. Both forms are
  // used in `src/`, so both are accepted here.
  constructor(startLine: Position | number, startCharacter?: Position | number, endLine?: number, endCharacter?: number) {
    if (startLine instanceof Position && startCharacter instanceof Position) {
      this.start = startLine;
      this.end = startCharacter;
      return;
    }
    this.start = new Position(startLine as number, startCharacter as number);
    this.end = new Position(endLine as number, endCharacter as number);
  }
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export class Diagnostic {
  source?: string;
  code?: string;

  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity: number,
  ) {}
}

export class CodeActionKind {
  private constructor(readonly value: string) {}
  static readonly QuickFix = new CodeActionKind('quickfix');
}

/** One `replace` call, as a test wants to read it back. */
export interface StubEdit {
  readonly uri: { readonly path: string };
  readonly range: Range;
  readonly newText: string;
}

export class WorkspaceEdit {
  readonly edits: StubEdit[] = [];

  replace(uri: { path: string }, range: Range, newText: string): void {
    this.edits.push({ uri, range, newText });
  }
}

export class CodeAction {
  edit?: WorkspaceEdit;
  diagnostics?: Diagnostic[];

  constructor(
    readonly title: string,
    readonly kind: CodeActionKind,
  ) {}
}

export const EndOfLine = { LF: 1, CRLF: 2 };
