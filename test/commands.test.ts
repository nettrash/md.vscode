//
//  commands.test.ts
//  md.vscode — which file a command was actually asked to act on.
//
//  WHY THIS IS A TEST AND NOT A COMMENT
//  ------------------------------------
//  Every export command used to be registered as `registerCommand(id, () =>
//  runOnDocument(id, run))`. That arrow takes no arguments; VS Code passes two
//  to a command invoked from a menu. While the Command Palette was the only
//  way in, dropping them was correct behaviour by accident — the palette
//  passes nothing and the active editor *is* the answer. Contributing these
//  commands to the explorer and editor context menus turns the same line into
//  a silent bug of the worst kind: right-click `notes.md`, choose *Export as
//  EPUB*, and get an EPUB of whatever document happened to be focused, under
//  a name taken from that other document, with no error anywhere.
//
//  There is no assertion an editor could make about that — it is a shape
//  mismatch between a callback and its caller, and it type-checks. So the rule
//  is written as two pure-ish functions and pinned here:
//
//    * `classifyInvocation` reads `(uri, uris)` and answers "one file or many,
//      and which";
//    * `resolveDocument` turns the chosen uri into a document with
//      `workspace.openTextDocument` — which returns the **dirty buffer** for a
//      file that is open, and which is not `showTextDocument`: nothing is
//      brought on screen, because a twenty-file batch must not open twenty
//      editors.
//
//  `vscode` is aliased to `test/vscode-stub.ts` by `vitest.config.ts`.
//

import type { Uri } from 'vscode';

import { beforeEach, describe, expect, it } from 'vitest';

import { batchTargets, classifyInvocation, resolveDocument, targetDocument } from '../src/commands';
import { openedPaths, stub, stubDocument, stubEditors } from './vscode-stub';

/** A `Uri` as much as the rules read one: a scheme and a path. */
const uri = (filePath: string): Uri =>
  ({ scheme: 'file', path: filePath, fsPath: filePath }) as unknown as Uri;

beforeEach(() => {
  stub();
  stubEditors();
});

describe('classifyInvocation — one file or many', () => {
  it('is the active editor when the palette passes nothing', () => {
    expect(classifyInvocation()).toEqual({ kind: 'single', uri: undefined });
  });

  it('is the clicked file when an editor menu passes one uri', () => {
    const clicked = uri('/notes/trip.md');
    expect(classifyInvocation(clicked)).toEqual({ kind: 'single', uri: clicked });
  });

  it('is one file when the explorer passes a selection of one', () => {
    // The explorer passes `uris` even for a single click, so the presence of
    // the array cannot be what decides — only its length.
    const clicked = uri('/notes/trip.md');
    expect(classifyInvocation(clicked, [clicked])).toEqual({ kind: 'single', uri: clicked });
  });

  it('falls back to the selection when only uris is given', () => {
    const only = uri('/notes/trip.md');
    expect(classifyInvocation(undefined, [only])).toEqual({ kind: 'single', uri: only });
  });

  it('treats an empty selection as no selection', () => {
    expect(classifyInvocation(undefined, [])).toEqual({ kind: 'single', uri: undefined });
  });

  it('is a batch from two files up, and keeps the selection order', () => {
    const one = uri('/notes/a.md');
    const two = uri('/notes/b.md');
    const three = uri('/notes/c.md');
    expect(classifyInvocation(two, [one, two, three])).toEqual({
      kind: 'batch',
      // The file under the pointer, not the first in selection order: it is
      // what a single-file command falls back to and what a message names.
      primary: two,
      uris: [one, two, three],
    });
  });

  it('takes the first of the selection as primary when no uri is passed', () => {
    const one = uri('/notes/a.md');
    const two = uri('/notes/b.md');
    expect(classifyInvocation(undefined, [one, two])).toEqual({
      kind: 'batch',
      primary: one,
      uris: [one, two],
    });
  });
});

describe('resolveDocument — uri given', () => {
  it('opens the file that was clicked, not the one that is focused', () => {
    const clicked = stubDocument('/notes/trip.md');
    const focused = stubDocument('/notes/other.md');
    stubEditors({ documents: [clicked, focused], active: focused, visible: [focused] });

    return resolveDocument(uri('/notes/trip.md')).then((document) => {
      expect(document).toBe(clicked);
      expect(openedPaths()).toEqual(['/notes/trip.md']);
    });
  });

  it('propagates a uri it cannot open rather than falling back to the editor', () => {
    // A fallback here would be the same bug in a different costume: exporting
    // a document nobody asked for. `dispatch` turns the rejection into a
    // message naming the command.
    const focused = stubDocument('/notes/other.md');
    stubEditors({ documents: [focused], active: focused });

    return expect(resolveDocument(uri('/gone/missing.md'))).rejects.toThrow('cannot open');
  });
});

describe('resolveDocument — nothing given', () => {
  it('is the active editor, whatever its language', () => {
    // A `.txt` somebody is deliberately treating as Markdown is theirs to
    // export; the menu `when` clauses already decide where the commands appear.
    const active = stubDocument('/notes/scratch.txt', 'plaintext');
    stubEditors({ documents: [active], active, visible: [active] });

    return resolveDocument(undefined).then((document) => {
      expect(document).toBe(active);
      // Nothing was opened: the active editor's document is already one.
      expect(openedPaths()).toEqual([]);
    });
  });

  it('falls back to a visible editor when the focus is in a webview', () => {
    // The Markdown preview is a webview, so `activeTextEditor` is undefined —
    // and the preview is exactly where someone reaches for "Export as PDF".
    const visible = stubDocument('/notes/trip.md');
    stubEditors({ documents: [visible], active: null, visible: [visible] });

    return resolveDocument(undefined).then((document) => {
      expect(document).toBe(visible);
    });
  });

  it('prefers Markdown over a diagram file among several visible editors', () => {
    const diagram = stubDocument('/notes/flow.puml', 'plantuml');
    const markdown = stubDocument('/notes/trip.md');
    stubEditors({
      documents: [diagram, markdown],
      active: null,
      // Screen order puts the diagram first; language order overrules it.
      visible: [diagram, markdown],
    });

    expect(targetDocument()).toBe(markdown);
  });

  it('is undefined when there is nothing open at all', () => {
    return resolveDocument(undefined).then((document) => {
      expect(document).toBeUndefined();
    });
  });

  it('ignores a visible editor of a language we do not handle', () => {
    const other = stubDocument('/notes/app.ts', 'typescript');
    stubEditors({ documents: [other], active: null, visible: [other] });

    expect(targetDocument()).toBeUndefined();
  });
});

// MARK: - Which files a batch acts on

//
//  WHY THE EXTENSION IS NOT THE ANSWER
//  -----------------------------------
//  The explorer row that reaches a batch is contributed under
//  `when: resourceLangId == markdown` — the *editor's* answer to "is this
//  Markdown", which is longer than any list kept here and grows with the
//  editor: the built-in `markdown-basics` claims `.litcoffee`, `.ron`,
//  `.ronn` and `.workbook` beyond the ten spellings `MARKDOWN_EXTENSIONS`
//  holds, and `**/.cursor/**/*.mdc` by file name rather than by extension at
//  all. Filtering a multi-selection by extension therefore threw away files
//  the same submenu had just offered, and which exported perfectly one at a
//  time: two of them came back as "no Markdown files in that selection", and
//  a mixed selection as "2 files skipped — not Markdown", a sentence the
//  editor disagrees with.
//
//  So the host decides, through the one call the batch had to make anyway.
//
describe('batchTargets — the host decides what Markdown is', () => {
  it('keeps a spelling the editor calls Markdown and this repo has never heard of', async () => {
    const ronn = stubDocument('/notes/guide.ronn');
    const workbook = stubDocument('/notes/book.workbook');
    const mdc = stubDocument('/proj/.cursor/rules/house.mdc');
    stubEditors({ documents: [ronn, workbook, mdc] });

    const chosen = await batchTargets([
      uri('/notes/guide.ronn'),
      uri('/notes/book.workbook'),
      uri('/proj/.cursor/rules/house.mdc'),
    ]);
    expect(chosen.targets.map((target) => target.path)).toEqual([
      '/notes/guide.ronn',
      '/notes/book.workbook',
      '/proj/.cursor/rules/house.mdc',
    ]);
    expect(chosen.skipped).toBe(0);
  });

  it('drops a file the editor calls something else', async () => {
    const markdown = stubDocument('/notes/trip.md');
    const script = stubDocument('/notes/build.ts', 'typescript');
    stubEditors({ documents: [markdown, script] });

    const chosen = await batchTargets([uri('/notes/trip.md'), uri('/notes/build.ts')]);
    expect(chosen.targets.map((target) => target.path)).toEqual(['/notes/trip.md']);
    expect(chosen.skipped).toBe(1);
  });

  it('drops what it cannot open at all, which is what a folder is', async () => {
    // A rubber-band selection in the explorer picks up folders and images.
    // `openTextDocument` rejects for the first and the rejection is the
    // answer — a batch must not fail because a directory was in the box.
    stubEditors({ documents: [stubDocument('/notes/trip.md')] });

    const chosen = await batchTargets([uri('/notes/trip.md'), uri('/notes/archive')]);
    expect(chosen.targets.map((target) => target.path)).toEqual(['/notes/trip.md']);
    expect(chosen.skipped).toBe(1);
  });

  it('asks the host only about the files the cheap test cannot settle', async () => {
    // `.md` is Markdown on any day of the week; opening twenty of them to be
    // told so would be a listing the batch then repeats file by file.
    const markdown = stubDocument('/notes/trip.md');
    const ronn = stubDocument('/notes/guide.ronn');
    stubEditors({ documents: [markdown, ronn] });

    await batchTargets([uri('/notes/trip.md'), uri('/notes/guide.ronn')]);
    expect(openedPaths()).toEqual(['/notes/guide.ronn']);
  });

  it('keeps the selection order, so the names a batch plans line up with it', async () => {
    const one = stubDocument('/notes/a.ronn');
    const two = stubDocument('/notes/b.md');
    const three = stubDocument('/notes/c.workbook');
    stubEditors({ documents: [one, two, three] });

    const chosen = await batchTargets([
      uri('/notes/a.ronn'),
      uri('/notes/b.md'),
      uri('/notes/c.workbook'),
    ]);
    expect(chosen.targets.map((target) => target.path)).toEqual([
      '/notes/a.ronn',
      '/notes/b.md',
      '/notes/c.workbook',
    ]);
  });
});
