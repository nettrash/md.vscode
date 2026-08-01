//
//  text.test.ts
//  md.vscode — the text primitives the whole parity core stands on.
//
//  Ported from the `testParser…AreFoundationsOwn` / `testParserLineEndingsAre
//  ScalarExact` family in `md/mdTests/mdTests.swift`, and from the character-set
//  enumeration the Kotlin port pinned in `MarkdownParserTest.kt`. Swift test
//  names are kept in comments so a failure here is greppable in the other three
//  repos.
//
//  WHY THESE ARE WORTH TESTING AT ALL
//  ----------------------------------
//  Nothing here is interesting on its own. Every one of them is a set-membership
//  question, and every one was answered differently by two shipping platforms at
//  some point:
//
//    * a fence line padded with U+00A0 was front matter on Apple and an
//      ordinary paragraph on Android — so the document's metadata vanished;
//    * a `<!-- note: … -->` whose marker was preceded by U+0085 was a note on
//      Apple and no note at all on Android — so the notes panel listed a
//      different set of notes;
//    * a line holding one invisible U+200B was a blank line — a block separator
//      — on Apple and a paragraph on Android.
//
//  Three sets are involved and they must never be conflated: the general
//  whitespace set (blank lines, fence info strings, closing fences,
//  front-matter fences, footnote-definition trims), `whitespacesAndNewlines`
//  (the note body, and nothing else), and the ASCII-only `" \t"` trim used by
//  the CSV numeric-alignment scan alone — which lives in `html.ts` and is
//  tested there.
//
//  EVERY INVISIBLE CHARACTER IS A NAMED CONSTANT, never a literal and never a
//  `\uXXXX` escape buried in a string. This suite is *about* characters nobody
//  can see; a literal U+00A0 in the source is indistinguishable from a space to
//  the next reader, and an escape inside a long template literal is barely
//  better. `NBSP` says what it is at every call site.
//

import { describe, expect, it } from 'vitest';

import {
  codePoints,
  isWhitespace,
  isWhitespaceOrNewline,
  normalizedLines,
  scalarContains,
  scalarFirstIndex,
  scalarHasPrefix,
  scalarHasSuffix,
  trimLeadingWS,
  trimTrailingWS,
  trimWS,
  trimWSNL,
} from '../src/render/text';

const ACUTE = String.fromCodePoint(0x0301); // COMBINING ACUTE ACCENT
const VS16 = String.fromCodePoint(0xfe0f); // VARIATION SELECTOR-16
const ZWJ = String.fromCodePoint(0x200d); // ZERO WIDTH JOINER
const ZWSP = String.fromCodePoint(0x200b); // ZERO WIDTH SPACE
const NBSP = String.fromCodePoint(0x00a0); // NO-BREAK SPACE
const NEL = String.fromCodePoint(0x0085); // NEXT LINE
const BOM = String.fromCodePoint(0xfeff); // ZERO WIDTH NO-BREAK SPACE
const VT = String.fromCodePoint(0x000b); // LINE TABULATION
const FF = String.fromCodePoint(0x000c); // FORM FEED
const LS = String.fromCodePoint(0x2028); // LINE SEPARATOR
const PS = String.fromCodePoint(0x2029); // PARAGRAPH SEPARATOR

/**
 * The three marks the whole parity family is written around.
 *
 * A Swift `Character` is an extended grapheme cluster, so each of these fuses
 * onto the delimiter in front of it and the cluster stops being equal to the
 * plain ASCII character. JavaScript strings are UTF-16 code units, so a naive
 * port passes the mark tests by construction — which is exactly why they are
 * here: they pin *outputs*, and a port that reached for `Intl.Segmenter`, a
 * `v`-flag regex or an NFC `normalize()` would break them silently.
 */
const MARKS = [ACUTE, VS16, ZWJ];

describe('whitespace sets', () => {
  // Foundation's `CharacterSet.whitespaces`: Unicode Zs ∪ U+0009.
  it('treats Zs and tab as whitespace', () => {
    for (const code of [
      0x0009, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
      0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000,
    ]) {
      expect(isWhitespace(code), `U+${code.toString(16).toUpperCase()}`).toBe(true);
    }
  });

  it('excludes the line terminators from the whitespace set', () => {
    // These belong to `whitespacesAndNewlines` only. U+0085 in particular is
    // whitespace when the note body is trimmed and is *not* a blank line
    // anywhere else — two sets, deliberately different.
    for (const code of [0x000a, 0x000b, 0x000c, 0x000d, 0x0085, 0x2028, 0x2029]) {
      const name = `U+${code.toString(16).toUpperCase()}`;
      expect(isWhitespace(code), name).toBe(false);
      expect(isWhitespaceOrNewline(code), name).toBe(true);
    }
  });

  it('excludes U+180E, which has been Cf and not Zs since Unicode 6.3', () => {
    expect(isWhitespace(0x180e)).toBe(false);
    expect(isWhitespaceOrNewline(0x180e)).toBe(false);
  });

  // ==========================================================================
  // This one caught a real divergence in `src/render/text.ts`, which now has
  // the U+200B entry it was missing. Kept with its full reasoning, because the
  // entry looks like a typo to anyone tidying the table and is not one.
  //
  // Swift's `testParserBlankLineSetIsFoundationsOwn` and Kotlin's
  // `MarkdownParser.kt` both put U+200B ZERO WIDTH SPACE *in* the general
  // whitespace set. Kotlin spells out why, having enumerated both tables over
  // the whole of Unicode:
  //
  //   "U+200B ZERO WIDTH SPACE is in Foundation's set and is *not* `Zs` to this
  //    JVM: Apple's table is frozen at a Unicode version that still classified
  //    it as a space separator … it is the only character they disagree about.
  //    Without the clause a line holding one invisible ZWSP was a blank line —
  //    a block separator — on Apple and a paragraph here.
  //    (`MarkdownHTML.swift` met the same fact from the other side and narrowed
  //    *its* trim to " \t".)"
  //
  // `text.ts` had omitted U+200B and gave the CSV alignment scan as its reason
  // — but that scan is precisely the *other* side of the same fact. It has its
  // own narrower ASCII trim (`trimAsciiSpaceTab` in `html.ts`) exactly so that
  // the general set can keep U+200B without misaligning a pasted spreadsheet.
  // The two decisions are opposite on purpose (port spec §5, rules 5 and 7);
  // folding one into the other loses the blank line.
  //
  // Settled by running it, not by reading tables: on this machine Foundation's
  // `CharacterSet.whitespaces.contains(U+200B)` is `true`.
  // ==========================================================================
  it('U+200B is in Foundation’s whitespace set (port spec §5 rule 5)', () => {
    expect(isWhitespace(0x200b)).toBe(true);
    expect(trimWS(ZWSP)).toBe('');
  });
});

describe('trimming', () => {
  // Swift: testParserNoteAndFenceTrimsAreFoundationsOwn
  it('trims the Foundation whitespace set, not JavaScript’s', () => {
    expect(trimWS(' js ')).toBe('js');
    expect(trimWS(`${NBSP}js${NBSP}`)).toBe('js');
    expect(trimWS('  padded \t')).toBe('padded');
    expect(trimWS('')).toBe('');
    expect(trimWS('   ')).toBe('');
  });

  it('leaves newlines and U+FEFF alone, unlike String.prototype.trim', () => {
    // `"\n a \n".trim()` is `"a"`, and `trim()` also eats U+FEFF. Foundation's
    // `.whitespaces` keeps all of them. Blank-line detection turns on it.
    expect(trimWS('\n a \n')).toBe('\n a \n');
    expect(trimWS(BOM)).toBe(BOM);
  });

  it('trims newlines only through trimWSNL, the note-body trim', () => {
    expect(trimWSNL('\n a \n')).toBe('a');
    // U+0085 NEL: whitespace here and nowhere else. Swift 12.10 / 12.11.
    expect(trimWSNL(`${NEL}note${NEL}`)).toBe('note');
    expect(trimWS(`${NEL}note${NEL}`)).toBe(`${NEL}note${NEL}`);
  });

  it('trims scalars, not graphemes, so a space carrying a mark still goes', () => {
    // Foundation trims scalars: `" \u{0301}abc"` loses the space even though
    // space-plus-mark is one `Character`. Kotlin's `trimSpaces()` agrees.
    for (const mark of MARKS) {
      expect(trimWS(` ${mark}abc`)).toBe(`${mark}abc`);
      expect(trimWS(`abc${mark} `)).toBe(`abc${mark}`);
    }
  });

  it('trims one end at a time', () => {
    expect(trimLeadingWS('  a  ')).toBe('a  ');
    expect(trimTrailingWS('  a  ')).toBe('  a');
    expect(trimLeadingWS('a')).toBe('a');
    expect(trimTrailingWS('a')).toBe('a');
  });
});

describe('scalar helpers', () => {
  // Swift's `ScalarText` exists because `"a%\u{0301}b".contains("%")` is false.
  // JavaScript is already code-unit exact, so these assert the *behaviour* the
  // helper was written to provide rather than porting the helper itself.
  it('finds a delimiter that carries a combining mark', () => {
    for (const mark of MARKS) {
      expect(scalarContains(`a%${mark}b`, '%')).toBe(true);
      expect(scalarHasPrefix(`[${mark}x`, '[')).toBe(true);
      expect(scalarHasSuffix(`x]${mark}`, `]${mark}`)).toBe(true);
      expect(scalarFirstIndex(`a-->${mark}b`, '-->')).toBe(1);
    }
  });

  it('never finds an empty needle, unlike String.prototype.includes', () => {
    // Swift returns false; JS's `includes('')` returns true. Call sites rely on
    // the Swift answer.
    expect(scalarContains('abc', '')).toBe(false);
    expect(scalarFirstIndex('abc', '')).toBeNull();
    // The prefix / suffix pair keep the *stdlib* answer, as the Swift does.
    expect(scalarHasPrefix('abc', '')).toBe(true);
    expect(scalarHasSuffix('abc', '')).toBe(true);
  });

  it('refuses a needle longer than the haystack and honours the start index', () => {
    expect(scalarFirstIndex('ab', 'abc')).toBeNull();
    expect(scalarFirstIndex('abcabc', 'abc', 1)).toBe(3);
    expect(scalarFirstIndex('abc', 'z')).toBeNull();
  });
});

describe('normalizedLines', () => {
  // Swift: testParserLineEndingsAreScalarExact
  it('treats CR, LF and CRLF as exactly one terminator each', () => {
    expect(normalizedLines('one\r\ntwo\rthree\nfour')).toEqual([
      'one',
      'two',
      'three',
      'four',
    ]);
  });

  it('never splits on the wider newline set', () => {
    // U+000B, U+000C, U+0085, U+2028 and U+2029 are ordinary content to the
    // block scanner. Only the raw-diagram probes use the wider set, and they
    // carry their own splitter in html.ts.
    const line = `a${VT}b${FF}c${NEL}d${LS}e${PS}f`;
    expect(normalizedLines(line)).toEqual([line]);
  });

  it('always appends the final line, so a trailing terminator yields an empty one', () => {
    // Observable: an unclosed fence at EOF picks this up and so gains a
    // trailing "\n" in its code. Wart, replicated — see parser.test.ts.
    expect(normalizedLines('a\n')).toEqual(['a', '']);
    expect(normalizedLines('a\r\n')).toEqual(['a', '']);
    expect(normalizedLines('')).toEqual(['']);
    expect(normalizedLines('\n')).toEqual(['', '']);
  });
});

describe('codePoints', () => {
  it('walks code points, keeping an astral character whole', () => {
    // The one thing `slug()` needs and a UTF-16 walk cannot give: a surrogate
    // half is neither a letter nor a mark, so an astral letter would be
    // dropped from every anchor.
    const bold = String.fromCodePoint(0x1d400); // MATHEMATICAL BOLD CAPITAL A
    expect(codePoints(`a${bold}b`)).toEqual([0x61, 0x1d400, 0x62]);
    expect(codePoints('')).toEqual([]);
  });
});
