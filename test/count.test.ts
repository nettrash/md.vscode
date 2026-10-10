//
//  count.test.ts
//  md.vscode — the status bar's word and character count against the apps' own.
//
//  The expected numbers are what md for iPhone printed under these same example
//  files on 2026-09-27 (iOS 27, the App Store screenshots of that day): the
//  extension's count must be the family's count, not a near miss of it.
//

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { countCharacters, countLabel, countWords, readingMinutes } from '../src/status/count';

const example = (name: string): string =>
  readFileSync(path.join(__dirname, 'fixtures', 'examples', name), 'utf8');

describe('countWords and countCharacters', () => {
  it.each([
    ['01-Welcome.md', 211, 1425],
    ['07-Diagrams.md', 444, 3084],
    ['08-Plots.md', 552, 3019],
    ['06-Math.md', 215, 1249],
    ['04-Code.md', 131, 848],
  ])('%s counts %i words and %i characters, as md for iPhone does', (name, words, characters) => {
    const text = example(name);
    expect(countWords(text)).toBe(words);
    expect(countCharacters(text)).toBe(characters);
  });

  it('counts word-like segments only, and graphemes rather than code units', () => {
    expect(countWords('md test')).toBe(2);
    expect(countWords('  — , ; !')).toBe(0);
    expect(countWords("don't stop")).toBe(2);
    expect(countCharacters('👍🏽 é')).toBe(3);
    expect(countCharacters('')).toBe(0);
  });
});

describe('countLabel', () => {
  it('reads as the apps’ footer, with the selection when there is one', () => {
    expect(countLabel({ words: 211, characters: 1425 })).toBe(`211 words · ${(1425).toLocaleString()} characters`);
    expect(countLabel({ words: 1, characters: 1 })).toBe('1 word · 1 character');
    expect(countLabel({ words: 211, characters: 1425 }, { words: 12, characters: 70 })).toBe(
      `12 of 211 words · 70 of ${(1425).toLocaleString()} characters`,
    );
    expect(countLabel({ words: 2, characters: 7 }, { words: 0, characters: 0 })).toBe('2 words · 7 characters');
  });

  it('rounds reading time to whole minutes, at least one', () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(211)).toBe(1);
    expect(readingMinutes(2300)).toBe(10);
  });
});
