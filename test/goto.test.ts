//
//  goto.test.ts
//  md.vscode — the rows of Go to Heading… and Go to Note….
//

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { NOTE_PREVIEW_LENGTH, headingRows, noteRows } from '../src/navigate/items';
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
