//
//  package.test.ts
//  md.vscode — the manifest's language contributions, pinned.
//
//  WHY A TEST READS package.json
//  -----------------------------
//  Which files this extension opens is decided in `contributes.languages`, and
//  nothing else in the suite looks there: `vsce` validates the manifest's shape
//  but not its meaning, so a wrong extension list ships as an extension that
//  installs cleanly and then never offers itself for a `.pu` file. The lists
//  below are the family's canonical ones — every md port declares the same
//  spellings — with one exception each way that is deliberate and recorded
//  here, so that a tidy-up cannot undo it without reading why.
//
//  THE THREE LISTS
//  ---------------
//  * PlantUML: `.puml`, `.plantuml`, `.iuml`, `.pu`. The language is ours, so
//    every extension is simply claimed.
//  * Graphviz: `.gv`, `.dot`. The apps leave `.dot` alone, because macOS and
//    Windows already declare it a Word template and a system-wide claim would
//    fight Word for it. A language association inside VS Code is not a
//    system-wide file type — it decides what the editor does with a file it
//    has already been asked to open — so here `.dot` costs nothing and is
//    claimed.
//  * Markdown: `.mkdn`, `.mkdown` — and only those two. The language id is
//    VS Code's own. The built-in `markdown-basics` extension already lists
//    `.md`, `.mkd`, `.mdwn`, `.mdown`, `.markdown`, `.markdn`, `.mdtxt` and
//    `.mdtext`, and VS Code merges a second `languages` entry that names an
//    existing id into that language: the extensions are added to its list and
//    each is associated with the same id. So the entry carries the two
//    spellings the editor's list lacks and NOTHING else. `aliases` would
//    rename the language, a `configuration` would layer over the built-in's
//    bracket and comment rules, and a grammar for `markdown` would compete
//    with the built-in's — any of which would turn every `.md` file into ours
//    rather than VS Code's, which is exactly what this extension exists not to
//    do. Newer editors have lengthened their own list (1.138 carries `.mkdn`);
//    a repeated extension is harmless there and load-bearing on 1.95, the
//    oldest editor `engines.vscode` admits.
//
//  The manifest is read with `fs` rather than imported, so the assertions are
//  about the bytes vsce will package and not about whatever a module loader
//  hands back for a JSON specifier.
//

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MARKDOWN_EXTENSIONS } from '../src/export/batch';
import { DIALECT_RULES } from '../src/lint/dialect';

const ROOT = path.resolve(__dirname, '..');

interface LanguageContribution {
  readonly id: string;
  readonly extensions?: readonly string[];
  readonly aliases?: readonly string[];
  readonly configuration?: string;
}

interface GrammarContribution {
  readonly language?: string;
  readonly scopeName: string;
  readonly path: string;
  readonly injectTo?: readonly string[];
}

interface CommandContribution {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
}

interface SubmenuContribution {
  readonly id: string;
  readonly label: string;
}

interface MenuItem {
  readonly command?: string;
  readonly submenu?: string;
  readonly when?: string;
  readonly group?: string;
}

interface SettingContribution {
  readonly type: string;
  readonly default?: unknown;
  readonly scope?: string;
  readonly description?: string;
  readonly markdownDescription?: string;
  readonly properties?: Readonly<Record<string, SettingContribution>>;
  readonly additionalProperties?: boolean;
}

interface Manifest {
  readonly engines: { readonly vscode: string };
  readonly contributes: {
    readonly languages: readonly LanguageContribution[];
    readonly grammars: readonly GrammarContribution[];
    readonly commands: readonly CommandContribution[];
    readonly submenus: readonly SubmenuContribution[];
    readonly menus: Readonly<Record<string, readonly MenuItem[]>>;
    readonly configuration: {
      readonly properties: Readonly<Record<string, SettingContribution>>;
    };
  };
  readonly activationEvents: readonly string[];
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Manifest;
const { commands, configuration, grammars, languages, menus, submenus } = manifest.contributes;

/** One menu's rows, or a failure naming the menu rather than `undefined is not iterable`. */
const menu = (id: string): readonly MenuItem[] => {
  const rows = menus[id];
  expect(rows, `contributes.menus["${id}"]`).toBeDefined();
  return rows;
};

/** The commands a menu offers, in the order it offers them. */
const commandIds = (id: string): readonly string[] =>
  menu(id).flatMap((row) => (row.command === undefined ? [] : [row.command]));

/** The one row in `id` that offers `what` — a command id or, with `submenu:`, a submenu id. */
const row = (id: string, what: string): MenuItem => {
  const found = menu(id).filter((entry) => entry.command === what || entry.submenu === what);
  expect(found, `${what} in ${id}`).toHaveLength(1);
  return found[0];
};

/** The one `languages` entry for `id` — one, because two would be merged by the editor and read as one here. */
const language = (id: string): LanguageContribution => {
  const found = languages.filter((entry) => entry.id === id);
  expect(found, `exactly one languages entry for ${id}`).toHaveLength(1);
  return found[0];
};

describe('contributes.languages — the file types', () => {
  it('claims the four PlantUML spellings, in the canonical order', () => {
    expect(language('plantuml').extensions).toEqual(['.puml', '.plantuml', '.iuml', '.pu']);
  });

  it('claims .gv and — here alone in the family — .dot', () => {
    expect(language('graphviz').extensions).toEqual(['.gv', '.dot']);
  });

  it('adds only the two Markdown spellings the built-in language lacks', () => {
    expect(language('markdown').extensions).toEqual(['.mkdn', '.mkdown']);
  });

  it('contributes to the built-in markdown language without shadowing it', () => {
    // id and extensions, nothing more — see the header for what each of the
    // other keys would do to every `.md` file in the editor.
    expect(Object.keys(language('markdown')).sort()).toEqual(['extensions', 'id']);
    // No grammar may name the language either. The one Markdown grammar here
    // is an injection into `text.html.markdown`, the built-in's own scope, and
    // an injection has no `language` of its own.
    expect(grammars.filter((grammar) => grammar.language === 'markdown')).toEqual([]);
    const injection = grammars.find((grammar) => grammar.injectTo !== undefined);
    expect(injection).toBeDefined();
    expect(injection?.language).toBeUndefined();
    expect(injection?.injectTo).toEqual(['text.html.markdown']);
  });

  it('declares each language once', () => {
    const ids = languages.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('spells every extension as a lowercase dotted suffix, and claims each once', () => {
    const all = languages.flatMap((entry) => entry.extensions ?? []);
    expect(all.length).toBeGreaterThan(0);
    for (const extension of all) {
      expect(extension).toMatch(/^\.[a-z0-9]+$/);
    }
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('contributes — the files the manifest points at', () => {
  // A configuration or grammar path that does not resolve ships silently:
  // vsce packages what it finds, and the editor drops the language without a
  // word. `.vscodeignore` keeps `language/**`, so the check is against disk.
  it('resolves every language configuration and grammar path', () => {
    for (const entry of languages) {
      if (entry.configuration !== undefined) {
        expect(existsSync(path.join(ROOT, entry.configuration)), entry.configuration).toBe(true);
      }
    }
    for (const grammar of grammars) {
      expect(existsSync(path.join(ROOT, grammar.path)), grammar.path).toBe(true);
    }
  });

  it('gives the two languages of our own a configuration and a grammar each', () => {
    for (const id of ['plantuml', 'graphviz']) {
      expect(language(id).configuration, id).toBeDefined();
      expect(grammars.filter((grammar) => grammar.language === id), id).toHaveLength(1);
    }
  });
});

describe('activationEvents', () => {
  it('still covers markdown, plantuml and graphviz by name', () => {
    expect(manifest.activationEvents).toEqual(
      expect.arrayContaining(['onLanguage:markdown', 'onLanguage:plantuml', 'onLanguage:graphviz']),
    );
  });

  it('activates on exactly the contributed languages', () => {
    // Order is not meaningful in either list, so both are compared sorted.
    const expected = languages.map((entry) => `onLanguage:${entry.id}`).sort();
    expect([...manifest.activationEvents].sort()).toEqual(expected);
  });
});

// MARK: - The menus

//
//  WHAT THESE PIN, AND WHY
//  -----------------------
//  A menu contribution is the one half of a command that cannot be unit-tested
//  by running it: the `when` clause is evaluated by the editor, the submenu is
//  assembled by the editor, and a row with a misspelt command id is dropped by
//  the editor without a word — the command simply is not there, which reads as
//  "the extension does not do that". The manifest is the whole specification,
//  so the manifest is what is asserted.
//
//  The batch rule shows up here as one `when` clause: `md.exportPdf` carries
//  `!listMultiSelection`, because PDF writes no bytes of its own — it hands a
//  page to the host's print dialogue, once per document — so it is the one
//  export that must not be offered for a selection of many.
//

describe('contributes.submenus — the export submenu', () => {
  it('declares md.export, once, with a label', () => {
    expect(submenus.map((entry) => entry.id)).toEqual(['md.export']);
    expect(submenus[0].label.length).toBeGreaterThan(0);
  });

  it('offers the four document exports, in the order the family lists them', () => {
    expect(commandIds('md.export')).toEqual([
      'md.exportHtml',
      'md.exportPdf',
      'md.exportEpub',
      'md.exportLatex',
    ]);
  });

  it('keeps PDF out of a multi-selection, and nothing else', () => {
    expect(row('md.export', 'md.exportPdf').when).toBe('!listMultiSelection');
    for (const id of ['md.exportHtml', 'md.exportEpub', 'md.exportLatex']) {
      expect(row('md.export', id).when, id).toBeUndefined();
    }
  });

  it('holds no diagram command: the submenu is for the document', () => {
    // SVG picks *which* diagram per document and Preview Diagram is not an
    // export at all; both are contributed beside the submenu, not inside it.
    expect(commandIds('md.export')).not.toContain('md.exportSvg');
    expect(commandIds('md.export')).not.toContain('md.showDiagramPreview');
  });
});

describe('contributes.menus — where the commands are offered', () => {
  const contextMenus = ['explorer/context', 'editor/context', 'editor/title/context'];

  it('puts the export submenu in all three context menus', () => {
    for (const id of contextMenus) {
      expect(row(id, 'md.export').submenu, id).toBe('md.export');
    }
  });

  it('shows it for Markdown only, by the key each menu actually sets', () => {
    // `resourceLangId` is the file the row is about — the one clicked in the
    // explorer, the one on the tab. `editorLangId` is the editor the body
    // context menu belongs to. Using the other key in either place shows the
    // rows for every file type or for none.
    expect(row('explorer/context', 'md.export').when).toBe('resourceLangId == markdown');
    expect(row('editor/title/context', 'md.export').when).toBe('resourceLangId == markdown');
    expect(row('editor/context', 'md.export').when).toBe('editorLangId == markdown');
  });

  it('offers the two diagram commands for diagram files in all three', () => {
    for (const id of contextMenus) {
      for (const command of ['md.exportSvg', 'md.showDiagramPreview']) {
        const when = row(id, command).when ?? '';
        expect(when, `${command} in ${id}`).toContain('plantuml');
        expect(when, `${command} in ${id}`).toContain('graphviz');
        expect(when, `${command} in ${id}`).not.toContain('markdown');
      }
    }
  });

  it('does not offer a per-document choice to a multi-selection', () => {
    // Both of these ask a question about one document — which diagram, which
    // panel — so neither is offered when several files are selected.
    for (const command of ['md.exportSvg', 'md.showDiagramPreview']) {
      expect(row('explorer/context', command).when, command).toContain('!listMultiSelection');
    }
  });

  it('keeps the diagram button on the editor toolbar', () => {
    // The one menu contribution that predates all of this.
    expect(menu('editor/title')).toEqual([
      {
        command: 'md.showDiagramPreview',
        when: 'editorLangId == plantuml || editorLangId == graphviz',
        group: 'navigation',
      },
    ]);
  });

  it('still offers every command in the palette, with its own when clause', () => {
    expect(menu('commandPalette')).toEqual([
      { command: 'md.exportHtml', when: 'editorLangId == markdown' },
      { command: 'md.exportPdf', when: 'editorLangId == markdown' },
      { command: 'md.exportEpub', when: 'editorLangId == markdown' },
      { command: 'md.exportLatex', when: 'editorLangId == markdown' },
      {
        command: 'md.exportSvg',
        when: 'editorLangId == markdown || editorLangId == plantuml || editorLangId == graphviz',
      },
      {
        command: 'md.showDiagramPreview',
        when: 'editorLangId == plantuml || editorLangId == graphviz',
      },
    ]);
  });
});

describe('contributes.menus — nothing dangling', () => {
  it('names only commands that are declared', () => {
    const declared = new Set(commands.map((entry) => entry.command));
    for (const [id, rows] of Object.entries(menus)) {
      for (const entry of rows) {
        if (entry.command === undefined) continue;
        expect(declared.has(entry.command), `${entry.command} in ${id}`).toBe(true);
      }
    }
  });

  it('names only submenus that are declared, and declares none it does not use', () => {
    const declared = new Set(submenus.map((entry) => entry.id));
    const used = new Set<string>();
    for (const [id, rows] of Object.entries(menus)) {
      for (const entry of rows) {
        if (entry.submenu === undefined) continue;
        expect(declared.has(entry.submenu), `${entry.submenu} in ${id}`).toBe(true);
        used.add(entry.submenu);
      }
    }
    expect([...declared].sort()).toEqual([...used].sort());
    // And every declared submenu has rows of its own, or it appears as an
    // empty cascade the author cannot open.
    for (const id of declared) expect(menu(id).length, id).toBeGreaterThan(0);
  });

  it('gives every row a command or a submenu, never both and never neither', () => {
    for (const [id, rows] of Object.entries(menus)) {
      for (const entry of rows) {
        const offered = [entry.command, entry.submenu].filter((value) => value !== undefined);
        expect(offered.length, `${id}: ${JSON.stringify(entry)}`).toBe(1);
      }
    }
  });
});

describe('the batch filter and the manifest agree', () => {
  it('settles every Markdown spelling this manifest adds without asking the host', () => {
    // `MARKDOWN_EXTENSIONS` is the cheap yes in front of `batchTargets`: a
    // spelling on it is taken as Markdown without opening the file. A
    // spelling this manifest contributes and that list lacks would still be
    // exported — the host is asked about anything the list cannot settle —
    // but it would cost an open per file to find out, so the two are pinned
    // together. What the list may *not* be is the last word: the editor's own
    // language claims more spellings than this, which is why `batchTargets`
    // ends at `languageId` and not here.
    for (const extension of language('markdown').extensions ?? []) {
      expect(MARKDOWN_EXTENSIONS, extension).toContain(extension);
    }
  });
});

// MARK: - The lint settings

//
//  WHY THE MANIFEST IS PINNED AGAINST THE CODE HERE
//  ------------------------------------------------
//  `src/lint/dialect.ts` owns the list of rules and `package.json` owns the
//  switches a reader sees. Nothing connects the two at build time: add a rule
//  and forget the manifest and it can never be switched off; rename one and
//  the old key silently stops doing anything, which is the worse of the two
//  because the setting is still there in `settings.json` looking effective.
//  So the one list is asserted against the other.
//

describe('contributes.configuration — the dialect lint', () => {
  it('offers the lint as one boolean, on by default', () => {
    const setting = configuration.properties['md.lint.dialect'];
    expect(setting).toBeDefined();
    expect(setting.type).toBe('boolean');
    expect(setting.default).toBe(true);
    // `resource`, like every other md setting: a repository may hold its own
    // answer in `.vscode/settings.json`.
    expect(setting.scope).toBe('resource');
  });

  it('offers exactly the rules the lint implements, each on by default', () => {
    const setting = configuration.properties['md.lint.rules'];
    expect(setting).toBeDefined();
    expect(setting.type).toBe('object');
    expect(Object.keys(setting.properties ?? {})).toEqual([...DIALECT_RULES]);
    // `additionalProperties: false` is what makes a misspelt rule name show
    // up as a squiggle in settings.json rather than as a switch that does
    // nothing.
    expect(setting.additionalProperties).toBe(false);
    for (const [name, rule] of Object.entries(setting.properties ?? {})) {
      expect(rule.type, name).toBe('boolean');
      expect(rule.default, name).toBe(true);
      // Every rule says, in the settings UI, what md does instead. That
      // sentence is the whole value of an Information-level diagnostic.
      expect((rule.description ?? '').length, name).toBeGreaterThan(40);
    }
  });

  it('defaults the map to every rule on, so the two halves cannot drift', () => {
    const setting = configuration.properties['md.lint.rules'];
    const expected: Record<string, boolean> = {};
    for (const rule of DIALECT_RULES) expected[rule] = true;
    expect(setting.default).toEqual(expected);
  });

  it('describes both settings for the settings UI', () => {
    for (const key of ['md.lint.dialect', 'md.lint.rules']) {
      const setting = configuration.properties[key];
      const text = setting.markdownDescription ?? setting.description ?? '';
      expect(text.length, key).toBeGreaterThan(40);
    }
  });
});
