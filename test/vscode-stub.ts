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

interface StubState {
  settings: StubSettings;
  themeKind: number;
  /** Section ids the pending change event claims to have touched. */
  changed: readonly string[];
}

/**
 * Read afresh on every call rather than captured, so a test may set it after the
 * module graph has been built.
 */
function state(): StubState {
  const g = globalThis as unknown as { __mdStub?: StubState };
  if (!g.__mdStub) g.__mdStub = { settings: {}, themeKind: 1, changed: [] };
  return g.__mdStub;
}

/** Point the stub at a fresh set of settings and a theme. Call it in `beforeEach`. */
export function stub(settings: StubSettings = {}, themeKind = 1, changed: readonly string[] = []): void {
  (globalThis as unknown as { __mdStub?: StubState }).__mdStub = { settings, themeKind, changed };
}

export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };

export const workspace = {
  getConfiguration: () => ({
    // No default argument and no type parameter: `get` in the real API returns
    // `T | undefined` for a key the user has not written, and that undefined is
    // the case the empty-string font defaults exist to serve.
    get: (key: string): unknown => state().settings[key],
  }),
};

export const window = {
  get activeColorTheme(): { kind: number } {
    return { kind: state().themeKind };
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
  file: (p: string): { scheme: string; path: string } => ({ scheme: 'file', path: p }),
};
