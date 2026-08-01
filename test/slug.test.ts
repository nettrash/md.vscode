//
//  slug.test.ts
//  md.vscode — anchors, and the one place in the port that must walk code points.
//
//  Ported from `testSlugDropsPunctuationLikeGitHub`,
//  `testParserSlugKeepsWhatTheAndroidPortKeeps`,
//  `testDuplicateHeadingSlugsAreDeduped` and `testHTMLHeadingsCarryAnchorIds`
//  in `md/mdTests/mdTests.swift`; catalogued in `specs/06-tests.md` §13.
//
//  WHY THIS HAS ITS OWN FILE
//  -------------------------
//  A slug is two lines of code and three shipped bugs. It is the join between
//  the Contents outline and the ids the HTML renderer assigns, and the two must
//  agree about *every* heading in document order — because the deduplication
//  counter is shared and positional. If one of them thinks a line is a heading
//  and the other does not, every subsequent anchor drifts by one and a table of
//  contents link scrolls to nothing. That is not a hypothetical: it is what
//  front matter's closing `---` did before `outline()` learned to skip it.
//
//  It is also one of exactly two places in the port that must not walk UTF-16
//  code units. A surrogate half is neither a letter nor a mark, so an astral
//  letter would be dropped from the anchor and a heading in a mathematical or
//  historic script would link to `#section`.
//

import { describe, expect, it } from 'vitest';

import { outline, slug } from '../src/render/parser';
import { renderBody } from '../src/render/html';

const ACUTE = String.fromCodePoint(0x0301); // COMBINING ACUTE ACCENT
const ZWJ = String.fromCodePoint(0x200d); // ZERO WIDTH JOINER
const NBSP = String.fromCodePoint(0x00a0); // NO-BREAK SPACE
const EM_SPACE = String.fromCodePoint(0x2003); // EM SPACE
const DOT_ABOVE = String.fromCodePoint(0x0307); // COMBINING DOT ABOVE
const BOLD_A = String.fromCodePoint(0x1d400); // MATHEMATICAL BOLD CAPITAL A

/** One slug with a private counter, for the cases that do not test dedup. */
function one(text: string): string {
  return slug(text, new Map<string, number>());
}

/** The `id` of every top-level heading the renderer emitted, in order. */
function headingIds(source: string): string[] {
  const { html } = renderBody(source, { title: 't', dark: false });
  return [...html.matchAll(/<h[1-6] id="([^"]*)"/g)].map((m) => m[1]);
}

describe('slug', () => {
  it('lowercases, keeps letters and digits, and maps a space to a hyphen', () => {
    expect(one('Getting Started')).toBe('getting-started');
    expect(one('Chapter 12')).toBe('chapter-12');
  });

  // Swift: testSlugDropsPunctuationLikeGitHub
  it('drops punctuation, exactly as GitHub does', () => {
    // `c` `#`→drop `␣`→`-` `&`→drop `␣`→`-` `f` `#!`→drop.
    // Keeping GitHub's rule is what makes links written for GitHub keep working.
    expect(one('C# & F#!')).toBe('c--f');
  });

  it('keeps `-` and `_` but drops every other whitespace character', () => {
    // U+0020 alone becomes a hyphen; a tab, an NBSP or an EM SPACE is dropped
    // rather than converted.
    expect(one('a-b_c')).toBe('a-b_c');
    expect(one(`a\tb`)).toBe('ab');
    expect(one(`a${NBSP}b`)).toBe('ab');
    expect(one(`a${EM_SPACE}b`)).toBe('ab');
  });

  // Swift: testParserSlugKeepsWhatTheAndroidPortKeeps
  it('keeps a combining mark even on a character it otherwise drops', () => {
    // This is where a grapheme walk and a code-point walk parted company.
    // `"a -◌́b c"` dropped the hyphen *and* the mark on Apple (the cluster
    // equals neither `-` nor `" "`) and kept both on Android, so the same
    // heading had two different anchors and a link written on one platform
    // scrolled to nothing on the other.
    expect(one(`a -${ACUTE}b c`)).toBe(`a--${ACUTE}b-c`);
  });

  it('keeps a combining mark on a letter', () => {
    expect(one(`Cafe${ACUTE}`)).toBe(`cafe${ACUTE}`);
  });

  it('drops a format character such as ZWJ', () => {
    expect(one(`Heading${ZWJ}`)).toBe('heading');
  });

  it('keeps an astral letter, which a UTF-16 walk would drop', () => {
    // A surrogate half is neither a letter nor a mark. Walking code units
    // would drop both halves and this heading would anchor to `#-heading`.
    expect(one(`${BOLD_A} Heading`)).toBe(`${BOLD_A}-heading`);
  });

  it('lowercases the whole string before iterating, not character by character', () => {
    // U+0130 İ lowercases to two scalars in both Swift and JavaScript, and the
    // second of them is a combining mark the slug keeps.
    expect(one('İ')).toBe(`i${DOT_ABOVE}`);
  });

  it('never normalises, so NFC and NFD are different anchors', () => {
    // Swift's `==` on ASCII literals is canonical equivalence, which for the
    // parser's delimiters means exactly what `===` means — but nothing in the
    // family ever calls `normalize()`, and adding it here would make
    // lookalikes match and diverge from Android. The cost is honest: a
    // decomposed heading anchors differently from a composed one, on every
    // platform alike.
    expect(one('café')).not.toBe(one(`cafe${ACUTE}`));
  });

  it('falls back to "section" when nothing survives', () => {
    expect(one('!!!')).toBe('section');
    expect(one('')).toBe('section');
  });

  // Swift: testDuplicateHeadingSlugsAreDeduped
  it('deduplicates through the caller’s counter', () => {
    const used = new Map<string, number>();
    expect(slug('Getting Started', used)).toBe('getting-started');
    expect(slug('Getting Started', used)).toBe('getting-started-1');
    expect(slug('Getting Started', used)).toBe('getting-started-2');
  });

  it('can still produce a duplicate id, exactly as GitHub does', () => {
    // The counter counts the *bare* slug, so `Same`, `Same 1`, `Same` yield
    // `same`, `same-1`, `same-1`: the counter for `same` was bumped by the
    // first heading and the third emits the id the second already took.
    // Replicated, not fixed.
    const used = new Map<string, number>();
    expect([slug('Same', used), slug('Same 1', used), slug('Same', used)]).toEqual([
      'same',
      'same-1',
      'same-1',
    ]);
  });
});

describe('anchors', () => {
  // Swift: testHTMLHeadingsCarryAnchorIds
  it('gives every top-level heading an id from the same counter', () => {
    expect(headingIds('# My Title\n\n# My Title')).toEqual(['my-title', 'my-title-1']);
  });

  it('keeps the outline and the emitted ids in step', () => {
    // The critical invariant: the same `used` map, walked in the same document
    // order. A document mixing every kind of heading the parser recognises.
    const source = [
      '---',
      'title: Skipped',
      '---',
      '',
      '# Same',
      '',
      '## Same',
      '',
      '```',
      '# not a heading',
      '```',
      '',
      '[^a]: a definition, not plain text',
      '---',
      '',
      'Setext',
      '===',
    ].join('\n');
    expect(headingIds(source)).toEqual(outline(source).map((e) => e.slug));
    expect(outline(source).map((e) => e.slug)).toEqual(['same', 'same-1', 'setext']);
  });

  it('gives a heading inside a block quote no id and no counter', () => {
    // `renderBlock` handles the nested form; only `renderBody` owns the slug
    // counter, so a quoted heading must not consume one.
    const { html } = renderBody('> ## Same\n\n## Same', { title: 't', dark: false });
    expect(html).toContain('<h2>Same</h2>');
    expect(html).toContain('<h2 id="same">Same</h2>');
    expect(html).not.toContain('same-1');
  });

  it('runs the heading text through the inline pass, id and all', () => {
    const { html } = renderBody('# 50% **off**', { title: 't', dark: false });
    expect(html).toBe('<h1 id="50-off">50% <strong>off</strong></h1>');
  });
});
