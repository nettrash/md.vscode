//
//  goto.test.ts
//  md.vscode — the rows of Go to Heading… and Go to Note….
//

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as vscode from 'vscode';

import { bindGoTo, type GoToEditor, type GoToPicker, type Row } from '../src/navigate/goTo';
import { NOTE_PREVIEW_LENGTH, headingRows, noteRows, truncated } from '../src/navigate/items';
import { notes, outline } from '../src/render/parser';

const example = (name: string): string => readFileSync(path.join(__dirname, 'fixtures', 'examples', name), 'utf8');

describe('headingRows', () => {
  it('lists the Welcome example as its Contents menu does, indented below the top level', () => {
    const rows = headingRows(outline(example('01-Welcome.md')));
    expect(rows.map((r) => r.label)).toEqual([
      'Welcome to md',
      ' Three ways to look at a document',
      ' A taste of Markdown',
      ' Explore the other examples',
    ]);
    expect(rows[0]).toMatchObject({ description: 'H1 · line 1', line: 0 });
  });

  it('indents from the shallowest level present, not from H1', () => {
    expect(headingRows(outline('## A\n\n### B\n')).map((r) => r.label)).toEqual(['A', ' B']);
  });

  it('is empty when there are no headings, and skips a heading inside a fence', () => {
    expect(headingRows(outline('plain\n\n```\n# not a heading\n```\n'))).toEqual([]);
  });
});

describe('noteRows', () => {
  it('lists the Writer Tools example’s private note, on its line', () => {
    const rows = noteRows(notes(example('09-Writer Tools.md')));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].line).toBe(18);
    expect(rows[0].description).toBe('line 19');
    expect(rows[0].label.startsWith('This note is invisible in Preview')).toBe(true);
    expect(rows[0].label.length).toBeLessThanOrEqual(NOTE_PREVIEW_LENGTH);
  });

  it('flattens a multi-line note and names an empty one', () => {
    expect(noteRows([{ text: 'one\n  two', line: 3 }])[0].label).toBe('one two');
    expect(noteRows([{ text: '', line: 0 }])[0].label).toBe('(empty note)');
  });
});

describe('truncated', () => {
  it('never splits an emoji, a flag or an accented letter at the cut', () => {
    // 79 letters then an emoji: the emoji is the 80th character and stays whole.
    const text = 'a'.repeat(79) + '😀' + 'tail';
    const cut = truncated(text, NOTE_PREVIEW_LENGTH);
    expect(cut).toBe('a'.repeat(79) + '…');
    expect(truncated('a'.repeat(78) + '🇩🇪' + 'xyz', 80)).toBe('a'.repeat(78) + '🇩🇪' + '…');
    expect(truncated('é'.normalize('NFD').repeat(81), 80)).toBe('é'.normalize('NFD').repeat(79) + '…');
    for (const s of [cut, truncated('x'.repeat(79) + '😀😀', 80)]) {
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)).toBe(false);
    }
  });

  it('leaves text at or under the limit alone', () => {
    expect(truncated('😀'.repeat(80), 80)).toBe('😀'.repeat(80));
    expect(truncated('', 80)).toBe('');
  });
});

describe('bindGoTo — the picker behaves as Go to Symbol', () => {
  const at = (line: number, character = 0) => new vscode.Position(line, character);
  const sel = (a: number, b = a) => new vscode.Selection(at(a, 1), at(b, 3));

  function fakes(initial: vscode.Selection[]) {
    const revealed: number[] = [];
    const editor: GoToEditor & { revealedAtTop: number } = {
      document: {} as vscode.TextDocument,
      viewColumn: undefined,
      selections: initial,
      visibleRanges: [new vscode.Range(40, 0, 60, 0)],
      revealedAtTop: -1,
      revealRange(range, type) {
        if (type === vscode.TextEditorRevealType.AtTop) editor.revealedAtTop = range.start.line;
        else revealed.push(range.start.line);
      },
    };
    const listeners: { active?: (a: readonly Row[]) => unknown; accept?: () => unknown; hide?: () => unknown } = {};
    const pick: GoToPicker & { disposed: boolean; selected: Row[]; active: Row[] } = {
      items: [],
      placeholder: undefined,
      matchOnDescription: true,
      selected: [],
      active: [],
      get selectedItems() { return pick.selected; },
      get activeItems() { return pick.active; },
      disposed: false,
      onDidChangeActive: (l) => (listeners.active = l),
      onDidAccept: (l) => (listeners.accept = l),
      onDidHide: (l) => (listeners.hide = l),
      hide: () => listeners.hide?.(),
      dispose: () => (pick.disposed = true),
    };
    const rows = [
      { label: 'A', description: 'H1 · line 3', line: 2 },
      { label: 'B', description: 'H2 · line 10', line: 9 },
    ];
    bindGoTo(editor, pick, rows, 'Go to a heading');
    return { editor, pick, listeners, revealed };
  }

  it('fills the list and follows the highlighted row', () => {
    const { pick, listeners, revealed } = fakes([sel(50)]);
    expect(pick.items.map((r) => r.line)).toEqual([2, 9]);
    expect(pick.placeholder).toBe('Go to a heading');
    expect(pick.matchOnDescription).toBe(false);
    listeners.active?.([pick.items[1]]);
    listeners.active?.([pick.items[0]]);
    expect(revealed).toEqual([9, 2]);
  });

  it('puts the caret at the start of the chosen line on Enter, as one selection', () => {
    const { editor, pick, listeners } = fakes([sel(50), sel(52), sel(54)]);
    pick.active = [pick.items[1]];
    listeners.accept?.();
    expect(editor.selections).toHaveLength(1);
    expect(editor.selections[0].start).toEqual(at(9, 0));
    expect(editor.selections[0].end).toEqual(at(9, 0));
    expect(pick.disposed).toBe(true);
  });

  it('gives back every cursor and the scroll position on Escape', () => {
    const initial = [sel(50), sel(52, 53), sel(54)];
    const { editor, pick, listeners } = fakes(initial);
    listeners.active?.([pick.items[1]]);
    pick.hide();
    expect(editor.selections).toBe(initial);
    expect(editor.revealedAtTop).toBe(40);
    expect(pick.disposed).toBe(true);
  });
});
