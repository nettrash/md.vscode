//
//  parser.test.ts
//  md.vscode — the block grammar.
//
//  A port of the parser half of `md/mdTests/mdTests.swift`, catalogued in
//  `specs/06-tests.md` §2–§13. Swift test names are carried in comments so a
//  failure here is greppable in md, md.macOS and md.Android.
//
//  THE HIGHEST-VALUE TESTS IN THE SUITE ARE IN `combining marks` BELOW.
//  A Swift `Character` is an extended grapheme cluster, so an ASCII delimiter
//  followed by a combining mark, a variation selector or a ZWJ is one
//  `Character` that is not equal to the plain delimiter — and the block is
//  silently not recognised. A differential run of the Apple and Android ports
//  over 3,555 marked documents put the divergence at 465 records before Swift
//  was routed through `ScalarText` and 0 after. Every diverging input carried
//  one of exactly three characters.
//
//  JavaScript strings are UTF-16 code units, which is Kotlin's model and the
//  one Android already got right, so this port passes those tests by
//  construction. They are here anyway, and they are the tests to run first
//  after any change, because the failure they guard against is not a crash: it
//  is a list that renders as a paragraph, a fence whose code is reflowed as
//  prose, an outline that has lost an entry, and — the loudest of them — a
//  comment whose `-->` carried a mark, never closed, and swallowed the rest of
//  the document.
//
//  Anything that reintroduces grapheme awareness reintroduces the bug:
//  `Intl.Segmenter`, `[...str]` in the block scanner, a `v`-flag regex doing
//  `\p{RGI_Emoji}` cluster matching, or a stray `.normalize()`.
//

import { describe, expect, it } from 'vitest';

import {
  frontMatter,
  notes,
  outline,
  parse,
  parseFootnoteDefinition,
  parseWithLines,
} from '../src/render/parser';
import type { Block } from '../src/render/types';

// MARK: - Helpers

/** Join lines without fighting a template literal over ``` fences. */
function doc(...parts: string[]): string {
  return parts.join('\n');
}

/** `MarkdownParser.parse(s).map(\.kind)` — the shape most Swift tests assert. */
function kinds(source: string): string[] {
  return parse(source).map((block) => block.kind);
}

/**
 * Assert a block's kind and narrow it for the caller.
 *
 * The alternative — `expect(b.kind).toBe('list')` followed by a cast — states
 * the expectation twice and lets the two drift apart.
 */
function expectKind<K extends Block['kind']>(
  block: Block,
  kind: K,
): Extract<Block, { kind: K }> {
  expect(block.kind).toBe(kind);
  return block as Extract<Block, { kind: K }>;
}

const ACUTE = String.fromCodePoint(0x0301); // COMBINING ACUTE ACCENT
const VS16 = String.fromCodePoint(0xfe0f); // VARIATION SELECTOR-16
const ZWJ = String.fromCodePoint(0x200d); // ZERO WIDTH JOINER
const NBSP = String.fromCodePoint(0x00a0); // NO-BREAK SPACE
const NEL = String.fromCodePoint(0x0085); // NEXT LINE
const ZWSP = String.fromCodePoint(0x200b); // ZERO WIDTH SPACE
const ARABIC_THREE = String.fromCodePoint(0x0663); // ARABIC-INDIC DIGIT THREE
const HALF = String.fromCodePoint(0x00bd); // VULGAR FRACTION ONE HALF

/** The three characters the whole parity family is written around. */
const MARKS = [ACUTE, VS16, ZWJ];

// MARK: - §2 Headings

describe('headings', () => {
  // Swift: testHeadingLevels
  it('reads all six ATX levels', () => {
    for (let level = 1; level <= 6; level++) {
      const block = expectKind(parse(`${'#'.repeat(level)} Title`)[0], 'heading');
      expect(block.level).toBe(level);
      expect(block.text).toBe('Title');
    }
  });

  // Swift: testHeadingRequiresSpace
  it('requires a space after the hashes', () => {
    expect(kinds('#Title')).toEqual(['paragraph']);
    // A TAB does not count either: the marker test is against U+0020 alone.
    expect(kinds('#\tTitle')).toEqual(['paragraph']);
  });

  // Swift: testHeadingSevenHashesIsParagraph
  it('stops at six levels', () => {
    expect(kinds('####### too deep')).toEqual(['paragraph']);
    expect(kinds('######## deeper still')).toEqual(['paragraph']);
  });

  // Swift: testHeadingClosingHashesStripped
  it('strips a closing hash run that follows whitespace', () => {
    expect(expectKind(parse('## Title ##')[0], 'heading').text).toBe('Title');
  });

  // Swift: testHeadingPreservesTrailingHashInWord
  it('keeps a trailing hash that belongs to the word', () => {
    expect(expectKind(parse('# C#')[0], 'heading').text).toBe('C#');
    expect(expectKind(parse('# F# notes')[0], 'heading').text).toBe('F# notes');
  });

  it('allows unbounded indentation, unlike an opening fence', () => {
    // Asymmetric with `FenceMarker`, which caps at three spaces. §11 of the
    // parser spec records it rather than fixing it.
    expect(expectKind(parse('        # Deep')[0], 'heading').level).toBe(1);
  });

  // Swift: testSetextHeadings
  it('reads setext underlines', () => {
    const h1 = parse(doc('My Title', '==='));
    expect(h1).toHaveLength(1);
    expect(expectKind(h1[0], 'heading').level).toBe(1);
    expect(expectKind(h1[0], 'heading').text).toBe('My Title');

    const h2 = parse(doc('My Title', '---'));
    // Exactly one block: the underline must not *also* emit a thematic break.
    expect(h2).toHaveLength(1);
    expect(expectKind(h2[0], 'heading').level).toBe(2);
  });

  it('fires setext only when exactly one line is buffered', () => {
    // Two buffered lines and the `---` is a rule, which is also the rule
    // `outline()` applies. If the two disagreed, every later anchor would
    // drift and the table of contents would scroll to nothing.
    expect(kinds(doc('line1', 'line2', '---'))).toEqual(['paragraph', 'thematicBreak']);
  });

  // Swift: testStandaloneRuleStillParsesAfterSetextChange
  it('leaves a standalone rule a rule', () => {
    expect(kinds('---')).toEqual(['thematicBreak']);
  });
});

// MARK: - §3 Paragraphs

describe('paragraphs', () => {
  // Swift: testParagraphPreservesSoftBreaks
  it('keeps soft breaks in the block text', () => {
    expect(expectKind(parse(doc('line one', 'line two'))[0], 'paragraph').text).toBe(
      'line one\nline two',
    );
  });

  // Swift: testBlankLineSeparatesParagraphs
  it('separates on a blank line', () => {
    expect(kinds(doc('first', '', 'second'))).toEqual(['paragraph', 'paragraph']);
  });

  // Swift: testParserBlankLineSetIsFoundationsOwn
  it('treats a line of Foundation whitespace as blank', () => {
    expect(kinds(doc('para', ` \t${NBSP}`, 'next'))).toHaveLength(2);
  });

  // ==========================================================================
  // See the banner in text.test.ts. Foundation's frozen tables and the Kotlin
  // port both put U+200B in the general whitespace set, so a ZWSP-only line is
  // a blank line — a block separator — on all three shipping platforms. This
  // test caught `src/render/text.ts` omitting it, which made such a document
  // one paragraph in VS Code and two everywhere else.
  //
  // Swift: testParserBlankLineSetIsFoundationsOwn (spec 06 §3.3)
  // ==========================================================================
  it('treats a lone U+200B as a blank line (spec 06 §3.3)', () => {
    expect(kinds(doc('para', ZWSP, 'next'))).toHaveLength(2);
  });

  // Swift: testParserLineEndingsAreScalarExact
  it('normalises CR, CRLF and LF to one terminator each', () => {
    expect(expectKind(parse('one\r\ntwo\rthree\nfour')[0], 'paragraph').text).toBe(
      'one\ntwo\nthree\nfour',
    );
    expect(kinds('a\r\n\r\nb')).toEqual(['paragraph', 'paragraph']);
  });

  it('keeps each line raw, trimming nothing', () => {
    // Only a setext heading's text is trimmed. Leading and trailing spaces
    // survive into the paragraph, and the renderer turns the newlines into
    // `<br>` inside the inline pass.
    expect(expectKind(parse(doc('  spaced  ', '  again  '))[0], 'paragraph').text).toBe(
      '  spaced  \n  again  ',
    );
  });
});

// MARK: - §4 Lists

describe('lists', () => {
  // Swift: testUnorderedList
  it('merges -, * and + into one unordered list', () => {
    const list = expectKind(parse(doc('- a', '- b', '* c', '+ d'))[0], 'list');
    expect(list.ordered).toBe(false);
    expect(list.items.map((i) => i.text)).toEqual(['a', 'b', 'c', 'd']);
  });

  // Swift: testOrderedList
  it('accepts both . and ) as ordered delimiters', () => {
    const list = expectKind(parse(doc('1. one', '2. two', '3) three'))[0], 'list');
    expect(list.ordered).toBe(true);
    expect(list.items.map((i) => i.ordinal)).toEqual([1, 2, 3]);
  });

  it('makes the whole run ordered if any item is', () => {
    // One flag for the run; the bullet item inside falls back to `&bull;` in
    // the renderer.
    const list = expectKind(parse(doc('- a', '1. b'))[0], 'list');
    expect(list.ordered).toBe(true);
    expect(list.items.map((i) => i.ordinal)).toEqual([null, 1]);
  });

  // Swift: testNestedListLevels
  it('tags depth at two columns per level', () => {
    const list = expectKind(parse(doc('- top', '  - nested', '    - deeper'))[0], 'list');
    expect(list.items.map((i) => i.level)).toEqual([0, 1, 2]);
  });

  // Swift: testTabIndentedNestedListRecognised
  it('understands a tab as a four-column stop', () => {
    // The mirror image of `FenceMarker`, which counts U+0020 only. The
    // asymmetry is real: tab-indented items come from externally-authored
    // files and must be recognised.
    const list = expectKind(parse(doc('- top', '\t- nested'))[0], 'list');
    expect(list.items.map((i) => i.text)).toEqual(['top', 'nested']);
    expect(list.items[1].level).toBeGreaterThan(list.items[0].level);
  });

  // Swift: testTaskList
  it('reads task boxes and strips them', () => {
    const list = expectKind(parse(doc('- [ ] todo', '- [x] done', '- [X] also'))[0], 'list');
    expect(list.items.map((i) => i.task)).toEqual([false, true, true]);
    expect(list.items.map((i) => i.text)).toEqual(['todo', 'done', 'also']);
  });

  it('treats a bare marker as an item with empty text', () => {
    const list = expectKind(parse('-')[0], 'list');
    expect(list.items).toHaveLength(1);
    expect(list.items[0].text).toBe('');
  });

  it('refuses a marker followed by a tab', () => {
    expect(kinds('-\tfoo')).toEqual(['paragraph']);
  });

  // Swift: testListItemContinuationIsAbsorbed
  it('absorbs a soft-wrapped continuation line', () => {
    const blocks = parse(doc('- First item', '  with continuation', '- Second item'));
    expect(blocks).toHaveLength(1);
    const list = expectKind(blocks[0], 'list');
    expect(list.items).toHaveLength(2);
    expect(list.items[0].text).toBe('First item with continuation');
  });

  it('breaks an item out into a table but absorbs a footnote definition', () => {
    // The three continuation break-sets are deliberately not unified. The
    // list-item loop carries the table lookahead and not the footnote check;
    // the paragraph loop carries neither; the footnote loop carries the
    // footnote check and not the lookahead. All three asymmetries are real.
    expect(kinds(doc('- item', '| a |', '| --- |'))).toEqual(['list', 'table']);
    const list = expectKind(parse(doc('- item', '[^a]: note'))[0], 'list');
    expect(list.items[0].text).toBe('item [^a]: note');
  });

  // Swift: testParserOrderedListMarkerIsASCIIDigitsOnly
  it('accepts ASCII digits only as an ordered marker', () => {
    // `Character.isNumber` on Apple admits `½` and `Ⅻ`, which `Int` cannot
    // read back; Kotlin's `toIntOrNull` reads `٣` as 3. With ASCII digits the
    // ordinal always parses and all four ports agree.
    expect(kinds(`${HALF}. half`)).toEqual(['paragraph']);
    expect(kinds(`${ARABIC_THREE}. three`)).toEqual(['paragraph']);
  });

  it('loses leading zeros and caps the marker at nine digits', () => {
    expect(expectKind(parse('007. item')[0], 'list').items[0].ordinal).toBe(7);
    expect(kinds('1234567890. too many digits')).toEqual(['paragraph']);
  });
});

// MARK: - §5 Code fences

describe('code fences', () => {
  // Swift: testFencedCodeWithLanguage
  it('reads a language off the info string', () => {
    const block = expectKind(parse(doc('```swift', 'let x = 1', '```'))[0], 'codeBlock');
    expect(block.language).toBe('swift');
    expect(block.code).toBe('let x = 1');
  });

  // Swift: testTildeFence
  it('accepts a tilde fence', () => {
    expect(expectKind(parse(doc('~~~', 'plain', '~~~'))[0], 'codeBlock').code).toBe('plain');
  });

  // Swift: testFenceContentIsNotInterpreted
  it('interprets nothing inside a fence', () => {
    const block = expectKind(parse(doc('```', '# not a heading', '```'))[0], 'codeBlock');
    expect(block.code).toBe('# not a heading');
  });

  // Swift: testUnclosedFenceConsumesToEnd
  it('consumes an unclosed fence to EOF', () => {
    expect(expectKind(parse(doc('```', 'a', 'b'))[0], 'codeBlock').code).toBe('a\nb');
  });

  it('picks up the trailing empty line when the source ends in a newline', () => {
    // Wart, verified, replicated: `normalizedLines` always appends a final
    // element, so an unclosed fence in a file ending with a newline gains a
    // trailing "\n". A closed fence is unaffected.
    expect(expectKind(parse('```\na\n')[0], 'codeBlock').code).toBe('a\n');
    expect(expectKind(parse('```\na\n```\n')[0], 'codeBlock').code).toBe('a');
  });

  // Swift: testIndentedFenceStripsIndent
  it('strips the opening fence’s indent from the body', () => {
    const block = expectKind(parse(doc('  ```', '  indented', '  ```'))[0], 'codeBlock');
    expect(block.code).toBe('indented');
  });

  it('refuses a fence indented four spaces or opened with a tab', () => {
    // Fence indentation counts U+0020 only, and stops at three. There is no
    // indented-code branch anywhere in this parser, so both fall through to
    // the paragraph branch.
    expect(kinds(doc('    ```', '    code', '    ```'))).toEqual(['paragraph']);
    expect(kinds(doc('\t```', 'code'))[0]).toBe('paragraph');
  });

  it('lets a closing fence be indented arbitrarily and be longer', () => {
    const blocks = parse(doc('```', 'code', '        `````', 'after'));
    expect(blocks.map((b) => b.kind)).toEqual(['codeBlock', 'paragraph']);
    expect(expectKind(blocks[0], 'codeBlock').code).toBe('code');
  });

  it('refuses a backtick in a backtick fence’s info string but allows it in a tilde one', () => {
    expect(kinds(doc('```js `x`', 'code', '```'))[0]).toBe('paragraph');
    expect(expectKind(parse(doc('~~~js `x`', 'code', '~~~'))[0], 'codeBlock').language).toBe(
      'js',
    );
  });

  it('takes the first U+0020-delimited word of the info string, tab included', () => {
    // The trim is the wide whitespace set; the split is on U+0020 alone. So a
    // tab is interior, neither trimmed nor a split point — "the same word
    // Kotlin's `split(\" \").first()` takes".
    expect(expectKind(parse(doc('```js extra', 'x', '```'))[0], 'codeBlock').language).toBe('js');
    expect(expectKind(parse(doc('```js\tfoo', 'x', '```'))[0], 'codeBlock').language).toBe(
      'js\tfoo',
    );
  });

  // Swift: testParserNoteAndFenceTrimsAreFoundationsOwn
  it('trims the info string and the closing fence with Foundation’s set', () => {
    // The Android port trimmed with space and tab only, so a fence padded with
    // U+00A0 kept a language nobody typed — and, worse, a closing fence padded
    // with U+00A0 did not close and swallowed the rest of the document.
    expect(expectKind(parse(doc(`\`\`\`${NBSP}js`, 'code()', '```'))[0], 'codeBlock').language).toBe(
      'js',
    );
    expect(kinds(doc('```', 'code()', `\`\`\`${NBSP}`, '', 'after'))).toEqual([
      'codeBlock',
      'paragraph',
    ]);
  });

  it('wins over every other block start, including a thematic break', () => {
    // Branch order is normative: blank → fence → rule → page break → footnote
    // definition → comment → heading → table → quote → list → paragraph.
    expect(kinds(doc('```', '---', '# nope', '> nope', '- nope', '```'))).toEqual(['codeBlock']);
  });
});

// MARK: - §6 Block quotes

describe('block quotes', () => {
  // Swift: testBlockQuote
  it('collects a run of quoted lines into one quote', () => {
    const quote = expectKind(parse(doc('> quoted', '> text'))[0], 'quote');
    expect(quote.blocks).toHaveLength(1);
    expect(expectKind(quote.blocks[0], 'paragraph').text).toBe('quoted\ntext');
  });

  it('ends a quote at a blank line and at a non-quoted line', () => {
    // There is no lazy continuation, so `"> a\n\n> b"` is two quote blocks.
    expect(kinds(doc('> a', '', '> b'))).toEqual(['quote', 'quote']);
    expect(kinds(doc('> a', 'b'))).toEqual(['quote', 'paragraph']);
  });

  // Swift: testNestedBlockQuote
  it('recurses', () => {
    const outer = expectKind(parse('> > deep')[0], 'quote');
    expect(outer.blocks[0].kind).toBe('quote');
  });

  // Swift: testDeeplyNestedQuoteDoesNotOverflow
  it('returns rather than overflowing on five thousand markers', () => {
    // A line of thousands of `>` costs one recursion per marker, so without a
    // cap it overflows the stack.
    const blocks = parse('>'.repeat(5000) + ' deep');
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].kind).toBe('quote');
  });

  it('caps the nesting at 33 levels, which is part of the output shape', () => {
    // A JavaScript stack would survive rather more than 33 frames; the cap
    // stays at 32 because the *shape* — quote nodes at depths 0…32, the
    // innermost holding a single paragraph with the still-`>`-laden remainder
    // — is what the parity contract is about.
    let depth = 0;
    let current: Block = parse('>'.repeat(5000) + ' deep')[0];
    while (current.kind === 'quote') {
      depth++;
      current = current.blocks[0];
    }
    expect(depth).toBe(33);
    expect(current.kind).toBe('paragraph');
  });
});

// MARK: - §7 Thematic breaks

describe('thematic breaks', () => {
  // Swift: testThematicBreaks
  it('accepts three or more of one marker, spaces and tabs allowed', () => {
    for (const rule of ['---', '***', '___', '- - -', '****', '----------', ' - -\t- ']) {
      expect(kinds(rule), rule).toEqual(['thematicBreak']);
    }
  });

  // Swift: testDashesUnderTextAreNotRuleWhenTooShort
  it('needs three markers', () => {
    expect(kinds('--')).toEqual(['paragraph']);
  });

  it('filters only U+0020 and U+0009, so an NBSP disqualifies the line', () => {
    // Narrower than every other predicate in the parser, which use the full
    // Zs-based set. The asymmetry is real and shipped.
    expect(kinds(`${NBSP}---`)).toEqual(['paragraph']);
  });

  it('refuses a mixed run', () => {
    expect(kinds('--*')).toEqual(['paragraph']);
  });
});

// MARK: - §8 Tables

describe('tables', () => {
  // Swift: testTableParsing
  it('reads a header, its alignments and its rows, trimming every cell', () => {
    const table = expectKind(
      parse(doc('| Name | Age |', '| :--- | ---: |', '| Ann  | 30 |', '| Bob  | 25 |'))[0],
      'table',
    );
    expect(table.header).toEqual(['Name', 'Age']);
    expect(table.alignments).toEqual(['leading', 'trailing']);
    expect(table.rows).toEqual([
      ['Ann', '30'],
      ['Bob', '25'],
    ]);
  });

  // Swift: testTableCenterAlignment
  it('reads centre alignment', () => {
    const table = expectKind(parse(doc('| A | B |', '|:-:|:-:|', '| 1 | 2 |'))[0], 'table');
    expect(table.alignments).toEqual(['center', 'center']);
  });

  it('cannot distinguish :--- from ---', () => {
    // There is no "explicitly left" alignment in this model.
    const table = expectKind(parse(doc('| A |', '| :--- |', '| 1 |'))[0], 'table');
    expect(table.alignments).toEqual(['leading']);
  });

  // Swift: testTableEscapedPipe
  it('keeps an escaped pipe inside its cell', () => {
    const table = expectKind(parse(doc('| Col |', '| --- |', '| a \\| b |'))[0], 'table');
    expect(table.rows).toEqual([['a | b']]);
  });

  // Swift: testNotATableWithoutDelimiterRow
  it('requires a delimiter row', () => {
    expect(kinds(doc('a | b | c', 'x | y | z'))).toEqual(['paragraph']);
  });

  it('requires the delimiter row to have exactly as many cells as the header', () => {
    expect(kinds(doc('| a | b |', '| --- |', '| 1 | 2 |'))).toEqual(['paragraph']);
  });

  it('pads and truncates body rows to the header width', () => {
    const table = expectKind(
      parse(doc('| a | b |', '| --- | --- |', '| 1 |', '| 1 | 2 | 3 |'))[0],
      'table',
    );
    expect(table.rows).toEqual([
      ['1', ''],
      ['1', '2'],
    ]);
  });

  it('cannot interrupt a paragraph', () => {
    // The paragraph loop carries no table lookahead. Reachable, shipped, §11.
    expect(kinds(doc('Intro', '| a |', '| --- |'))).toEqual(['paragraph']);
  });
});

// MARK: - §9 Front matter

describe('front matter', () => {
  const yaml = doc(
    '---',
    'title: My Book',
    'author: Ivan Alekseev',
    'date: 2026-07-24',
    '---',
    '',
    '# Chapter One',
    '',
    'Text.',
  );

  // Swift: testYAMLFrontMatterIsParsedAndHidden
  it('parses a YAML block at the very top', () => {
    const blocks = parse(yaml);
    const matter = expectKind(blocks[0], 'frontMatter');
    expect(matter.fields).toEqual([
      { key: 'title', value: 'My Book' },
      { key: 'author', value: 'Ivan Alekseev' },
      { key: 'date', value: '2026-07-24' },
    ]);
    expect(blocks.map((b) => b.kind)).not.toContain('thematicBreak');
  });

  // Swift: testTOMLFrontMatterUsesEquals
  it('uses = for a +++ block and strips one layer of quotes', () => {
    const matter = expectKind(
      parse(doc('+++', 'title = "Quoted"', 'draft = false', '+++', '', 'Body.'))[0],
      'frontMatter',
    );
    expect(matter.fields).toEqual([
      { key: 'title', value: 'Quoted' },
      { key: 'draft', value: 'false' },
    ]);
  });

  // Swift: testFrontMatterOnlyAtTheVeryTopAndOnlyWhenClosed
  it('needs a closing fence', () => {
    expect(kinds(doc('---', '', 'Just a rule above.'))[0]).toBe('thematicBreak');
  });

  it('needs the line after the opener to be non-blank', () => {
    // The guard that stops a rule with prose under it from swallowing the
    // reader's words. It is isolated by exactly this one input: delete the
    // guard and every other front-matter test stays green.
    const blocks = parse(doc('---', '', 'title: A', '---', '', 'body'));
    expect(blocks.map((b) => b.kind)).not.toContain('frontMatter');
    expect(blocks[0].kind).toBe('thematicBreak');
  });

  it('keeps a rule-plus-prose-plus-rule document intact', () => {
    const blocks = parse(
      doc('---', '', 'Intro the reader must see.', '', '---', '', 'More.'),
    );
    expect(blocks[0].kind).toBe('thematicBreak');
    expect(
      blocks.some((b) => b.kind === 'paragraph' && b.text === 'Intro the reader must see.'),
    ).toBe(true);
  });

  it('needs at least one recognisable field', () => {
    // `---\nChapter One\n---` reads the way it reads everywhere else: a rule
    // and a setext H2.
    const blocks = parse(doc('---', 'Chapter One', '---', '', 'Text.'));
    expect(blocks.map((b) => b.kind)).not.toContain('frontMatter');
    const heading = blocks.find((b) => b.kind === 'heading');
    expect(heading && heading.kind === 'heading' ? heading.level : 0).toBe(2);
    expect(heading && heading.kind === 'heading' ? heading.text : '').toBe('Chapter One');
  });

  it('is only ever at the very top', () => {
    expect(
      kinds(doc('# Title', '', '---', '', 'title: not metadata', '', '---')),
    ).not.toContain('frontMatter');
  });

  it('never appears inside a block quote', () => {
    const quote = expectKind(parse(doc('> ---', '> title: x', '> ---'))[0], 'quote');
    expect(quote.blocks.map((b) => b.kind)).not.toContain('frontMatter');
  });

  // Swift: testFrontMatterSkipsWhatTheFlatScanCannotRead
  it('skips comments and list lines but still consumes the block whole', () => {
    const blocks = parse(
      doc('---', 'title: Deep', '# a comment', 'tags:', '  - one', '  - two', '---', 'Body.'),
    );
    const matter = expectKind(blocks[0], 'frontMatter');
    expect(matter.fields[0]).toEqual({ key: 'title', value: 'Deep' });
    expect(matter.fields).toContainEqual({ key: 'tags', value: '' });
    expect(matter.fields.some((f) => f.key.startsWith('-'))).toBe(false);
    expect(blocks).toHaveLength(2);
    expect(expectKind(blocks[1], 'paragraph').text).toBe('Body.');
  });

  it('keeps duplicate keys and their order', () => {
    // A record of what the author wrote, not a dictionary.
    const matter = expectKind(
      parse(doc('---', 'tag: a', 'tag: b', '---', '', 'Body.'))[0],
      'frontMatter',
    );
    expect(matter.fields).toEqual([
      { key: 'tag', value: 'a' },
      { key: 'tag', value: 'b' },
    ]);
  });

  // Swift: testUnicodeSpacingAndWordBoundariesAgreeAcrossPlatforms
  it('lets the closing fence be padded with Foundation whitespace', () => {
    expect(frontMatter(doc('---', 'title: A', `---${NBSP}`, '', 'body'))).toEqual([
      { key: 'title', value: 'A' },
    ]);
  });

  it('accepts ... as a YAML closer', () => {
    expect(frontMatter(doc('---', 'title: A', '...', '', 'body'))).toEqual([
      { key: 'title', value: 'A' },
    ]);
  });

  // Swift: testFrontMatterAccessor
  it('exposes the fields through the accessor', () => {
    expect(frontMatter(doc('---', 'author: Ann', '---', '', 'Hi.'))).toEqual([
      { key: 'author', value: 'Ann' },
    ]);
    // DIVERGENCE FROM THE APPS, mandated by the module contract:
    // `MarkdownParser.frontMatter(of:)` returns `[]` for a document without
    // any; the contract types this `MetadataField[] | null`. The distinction
    // costs nothing — the three guards make an empty field list
    // unrepresentable — but a caller porting a Swift call site wants
    // `frontMatter(src) ?? []`.
    expect(frontMatter(doc('# Plain', '', 'No metadata.'))).toBeNull();
  });

  // Swift: testFrontMatterDoesNotLeakIntoTheOutlineOrNotes
  it('is invisible to outline()', () => {
    // The closing `---` underlines the last metadata line. A scanner that
    // walked raw source would read a setext heading the rendered document does
    // not contain, and its slug would push every real heading's anchor out of
    // step with the ids the renderer assigns — so the table of contents would
    // scroll to nothing.
    expect(outline(doc('---', 'title: My Post', '---', '', '# Hello', '')).map((e) => e.text)).toEqual(
      ['Hello'],
    );
    expect(outline(doc('---', 'Hello: x', '---', '', '# Hello: x', '')).map((e) => e.slug)).toEqual(
      ['hello-x'],
    );
  });

  it('is invisible to notes()', () => {
    expect(
      notes(doc('---', 'title: X', '<!-- note: hidden -->', '---', '', 'Body.')),
    ).toHaveLength(0);
    expect(notes(doc('---', 'title: X', '---', '', '<!-- note: real -->'))).toHaveLength(1);
  });
});

// MARK: - §10 Footnote definitions

describe('footnote definitions', () => {
  // Swift: testFootnoteDefinitionIsParsedAndNotDrawnInPlace
  it('parses a definition', () => {
    const blocks = parse(doc('Text[^a].', '', '[^a]: The note.'));
    const definition = expectKind(blocks[blocks.length - 1], 'footnoteDefinition');
    expect(definition.id).toBe('a');
    expect(definition.text).toBe('The note.');
  });

  // Swift: testFootnoteDefinitionAbsorbsWrappedLines
  it('absorbs wrapped continuation lines', () => {
    const blocks = parse(
      doc('X[^a].', '', '[^a]: first line', '  second line', '', 'After.'),
    );
    const definition = blocks.find((b) => b.kind === 'footnoteDefinition');
    expect(definition && definition.kind === 'footnoteDefinition' ? definition.text : '').toBe(
      'first line second line',
    );
    expect(expectKind(blocks[blocks.length - 1], 'paragraph').text).toBe('After.');
  });

  it('separates consecutive definitions', () => {
    // The footnote continuation loop carries the footnote check, unlike the
    // list-item loop.
    const blocks = parse(doc('[^a]: one', '[^b]: two'));
    expect(blocks.map((b) => b.kind)).toEqual(['footnoteDefinition', 'footnoteDefinition']);
  });

  // Swift: testFootnoteDefinitionDoesNotLeakIntoTheOutline
  it('is not plain text to outline()', () => {
    // `parse` claims the definition line, so `---` under it is a rule and not
    // a setext heading. Counting it as plain would list a heading the rendered
    // document has not got, and drag every later anchor out of step.
    expect(
      outline(doc('# Real', '', '[^a]: The note.', '---', '', 'Text[^a].')).map((e) => e.text),
    ).toEqual(['Real']);
  });

  // Swift: testFootnoteIdentifierCharacterSet
  it('accepts ASCII letters, digits, - and _ and nothing else', () => {
    // Narrower than Pandoc, deliberately twice over: the identifier travels
    // into an `id` attribute, and it is exactly the set the renderer's
    // *reference* pattern accepts — so a definition can never be written that
    // no reference is able to name.
    expect(parseFootnoteDefinition('[^a-1_B]: ok')).toEqual({ id: 'a-1_B', text: 'ok' });
    for (const bad of [
      '[^café]: no',
      '[^сн]: no',
      '[^two words]: no',
      '[^a.b]: no',
      '[^]: no',
      '[a]: not a footnote',
      '[^a] no colon',
    ]) {
      expect(parseFootnoteDefinition(bad), bad).toBeNull();
    }
  });

  // Swift: testUnicodeSpacingAndWordBoundariesAgreeAcrossPlatforms
  it('tolerates Foundation whitespace around the line', () => {
    expect(parseFootnoteDefinition(`${NBSP}[^a]: note`)).not.toBeNull();
    expect(parseFootnoteDefinition(`[^a]: note${NBSP}`)).toEqual({ id: 'a', text: 'note' });
  });
});

// MARK: - §11 Page breaks

describe('page breaks', () => {
  // Swift: testPageBreakParses
  it('reads both spellings', () => {
    expect(kinds(doc('before', '', '\\newpage', '', 'after'))).toEqual([
      'paragraph',
      'pageBreak',
      'paragraph',
    ]);
    expect(kinds('\\pagebreak')).toEqual(['pageBreak']);
  });

  // Swift: testPageBreakVariantInterruptsParagraph
  it('interrupts a paragraph without a blank line', () => {
    expect(kinds(doc('line one', '\\pagebreak', 'line two'))).toEqual([
      'paragraph',
      'pageBreak',
      'paragraph',
    ]);
  });

  it('needs the line to hold nothing else', () => {
    expect(kinds('\\newpage now')).toEqual(['paragraph']);
  });
});

// MARK: - §12 Author notes and HTML comments

describe('notes and comments', () => {
  // Swift: testNoteCommentBecomesNoteBlock
  it('turns a note comment into a note block', () => {
    const blocks = parse('<!-- note: check the intro -->');
    expect(blocks).toHaveLength(1);
    expect(expectKind(blocks[0], 'note').text).toBe('check the intro');
  });

  it('folds the case of the note: prefix', () => {
    expect(expectKind(parse('<!-- NOTE: shouty -->')[0], 'note').text).toBe('shouty');
    expect(expectKind(parse('<!-- Note: titled -->')[0], 'note').text).toBe('titled');
  });

  // Swift: testPlainCommentIsDropped
  it('drops a comment that is not a note', () => {
    expect(kinds(doc('a', '', '<!-- just a comment -->', '', 'b'))).toEqual([
      'paragraph',
      'paragraph',
    ]);
  });

  // Swift: testMultilineNote
  it('spans lines', () => {
    const note = expectKind(parse(doc('<!-- note: first', 'second -->'))[0], 'note');
    expect(note.text).toContain('first');
    expect(note.text).toContain('second');
  });

  it('discards whatever follows --> on the closing line', () => {
    // Known wart: the whole closing line is consumed.
    expect(kinds('<!-- c --> visible text')).toEqual([]);
  });

  // Swift: testNotesHelperFindsLine
  it('reports a note’s 0-based source line', () => {
    const found = notes(doc('start', '', '<!-- note: fix me -->', '', 'end'));
    expect(found).toEqual([{ text: 'fix me', line: 2 }]);
  });

  it('ignores a note written inside a fence', () => {
    expect(notes(doc('```', '<!-- note: not really -->', '```'))).toHaveLength(0);
  });

  // Swift: testParserNoteAndFenceTrimsAreFoundationsOwn
  it('trims the note body with the newline-bearing set, U+0085 included', () => {
    // Two different sets: U+0085 is whitespace here and is *not* a blank line
    // anywhere else. Kotlin's own set kept U+0085, which made a note vanish
    // from its panel.
    expect(notes(`<!--${NEL} note: n -->`).map((n) => n.text)).toEqual(['n']);
    expect(notes(`<!-- note: n ${NEL}-->`).map((n) => n.text)).toEqual(['n']);
  });
});

// MARK: - §13 Outline

describe('outline', () => {
  // Swift: testOutlineLevelsSlugsAndLines
  it('reports levels, slugs and 0-based lines, skipping fenced lookalikes', () => {
    const entries = outline(
      doc(
        '# One', // 0
        '', // 1
        'text', // 2
        '', // 3
        '## Two', // 4
        '', // 5
        '```', // 6
        '# not a heading', // 7
        '```', // 8
        '', // 9
        'Setext', // 10
        '---', // 11
      ),
    );
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ level: 1, text: 'One', slug: 'one', line: 0 });
    expect(entries[1].slug).toBe('two');
    // A setext entry points at the *text* line, not the underline.
    expect(entries[2]).toEqual({ level: 2, text: 'Setext', slug: 'setext', line: 10 });
  });

  // Swift: testOutlineSkipsUnderlineAfterMultiLineParagraph
  it('applies parse()’s one-buffered-line setext rule', () => {
    expect(outline(doc('line1', 'line2', '---'))).toHaveLength(0);
    expect(outline(doc('only', '---'))).toHaveLength(1);
  });

  it('counts lines with the parser’s own splitter, so a lone CR splits', () => {
    // VS Code does not treat a lone `\r` as a line break; the parser does.
    expect(outline('# One\r\n\r\n# Two').map((e) => e.line)).toEqual([0, 2]);
  });

  it('skips a comment, closed or not', () => {
    expect(outline(doc('<!-- x -->', '', '# After')).map((e) => e.text)).toEqual(['After']);
    expect(outline(doc('<!-- never closed', '# Swallowed'))).toHaveLength(0);
  });

  it('sees setext headings parse() does not — a shipped divergence', () => {
    // A table header row and a list-item continuation line are *not* excluded
    // from `isPlain`, so each injects a phantom entry here that `parse` does
    // not produce, and each consumes a slug. Two reachable divergences; §11 of
    // the parser spec flags them rather than silently fixing them.
    expect(outline(doc('| a |', '---')).map((e) => e.text)).toEqual(['| a |']);
    expect(kinds(doc('| a |', '---'))).not.toContain('heading');
  });
});

// MARK: - §20 The combining-mark corpus

describe('combining marks', () => {
  // THE SINGLE HIGHEST-VALUE BLOCK IN THIS FILE. Each of these was a real,
  // silent divergence: the block was found on Android and missed on Apple,
  // and `MarkdownParser` is what the preview, the HTML, the PDF, the EPUB,
  // the outline and the notes panel are all built from — so each one was the
  // same document being a different document, everywhere at once.

  // Swift: testParserHeadingSurvivesAMarkOnItsMarkerSpace
  it('finds a heading whose marker space carries a mark', () => {
    for (const mark of MARKS) {
      const heading = expectKind(parse(`# ${mark}Heading`)[0], 'heading');
      expect(heading.level).toBe(1);
      expect(heading.text).toBe(`${mark}Heading`);
      // And the outline must agree, or the entry — and its anchor — is lost.
      expect(outline(`# ${mark}Heading`).map((e) => e.text)).toEqual([`${mark}Heading`]);
    }
  });

  // Swift: testParserListMarkerSurvivesAMarkOnItsSpace
  it('finds a list whose bullet space carries a mark', () => {
    // The demonstrated one: `- ́[draft]` was a paragraph on Apple and a list
    // on Android, because the cluster "space plus mark" is not a space.
    for (const mark of MARKS) {
      const list = expectKind(parse(`- ${mark}[draft]`)[0], 'list');
      expect(list.ordered).toBe(false);
      expect(list.items.map((i) => i.text)).toEqual([`${mark}[draft]`]);
    }
  });

  // Swift: testParserTaskBoxIsScalarExact
  it('finds a task box whose text carries a mark', () => {
    for (const mark of MARKS) {
      const list = expectKind(parse(`- [ ] ${mark}task`)[0], 'list');
      expect(list.items.map((i) => i.task)).toEqual([false]);
      expect(list.items.map((i) => i.text)).toEqual([`${mark}task`]);
    }
  });

  // Swift: testParserOrderedListMarkerIsASCIIDigitsOnly
  it('absorbs an ordered marker whose delimiter carries a mark', () => {
    for (const mark of MARKS) {
      const blocks = parse(doc('1. one', `2${mark}. two`));
      expect(blocks).toHaveLength(1);
      const list = expectKind(blocks[0], 'list');
      expect(list.items.map((i) => i.text)).toEqual([`one 2${mark}. two`]);
    }
  });

  // Swift: testParserFenceSurvivesAMarkOnItsOpeningRun
  it('finds a fence whose opening run carries a mark', () => {
    // The third backtick fused with a mark counted as a run of two on Apple,
    // so the block was a paragraph — and the author's code was reflowed as
    // prose and inline-formatted.
    for (const mark of MARKS) {
      const block = expectKind(parse(doc(`\`\`\`${mark}js`, 'code()', '```'))[0], 'codeBlock');
      expect(block.language).toBe(`${mark}js`);
      expect(block.code).toBe('code()');
    }
  });

  // Swift: testParserTableRowSurvivesAMarkOnItsOnlyPipe
  it('finds a table row whose only pipe carries a mark', () => {
    for (const mark of MARKS) {
      const blocks = parse(doc('a | b', '--- | ---', `1 |${mark} 2`));
      // Exactly one block: the row must not *also* become a paragraph.
      expect(blocks).toHaveLength(1);
      expect(expectKind(blocks[0], 'table').rows).toEqual([['1', `${mark} 2`]]);
    }
  });

  // Swift: testParserFootnoteDefinitionSurvivesAMarkOnItsColon
  it('finds a footnote definition whose colon carries a mark', () => {
    for (const mark of MARKS) {
      expect(parseFootnoteDefinition(`[^a]:${mark} the note`)).toEqual({
        id: 'a',
        text: `${mark} the note`,
      });
      const definition = expectKind(parse(`[^a]:${mark} the note`)[0], 'footnoteDefinition');
      expect(definition.text).toBe(`${mark} the note`);
    }
  });

  // Swift: testParserQuoteMarkerSurvivesAMarkAfterIt
  it('finds a quote whose marker carries a mark', () => {
    for (const mark of MARKS) {
      const quote = expectKind(parse(`>${mark} quoted`)[0], 'quote');
      expect(expectKind(quote.blocks[0], 'paragraph').text).toBe(`${mark} quoted`);
      // The stripper eats `>` and exactly one space, so a mark on the text
      // stays where the author put it.
      const spaced = expectKind(parse(`> ${mark}text`)[0], 'quote');
      expect(expectKind(spaced.blocks[0], 'paragraph').text).toBe(`${mark}text`);
    }
  });

  // Swift: testParserCommentEndSurvivesAMarkAfterIt
  it('closes a comment whose --> carries a mark', () => {
    // The loudest of them: the comment never closed, so the parser swallowed
    // the rest of the document — headings, outline entries and all.
    for (const mark of MARKS) {
      const blocks = parse(doc(`<!-- note: private -->${mark}`, '', 'after'));
      expect(blocks).toHaveLength(2);
      expect(expectKind(blocks[0], 'note').text).toBe('private');
      expect(expectKind(blocks[1], 'paragraph').text).toBe('after');

      expect(outline(doc(`<!-- x -->${mark}`, '', '# After')).map((e) => e.text)).toEqual([
        'After',
      ]);
      expect(notes(`<!-- note: n -->${mark}`).map((n) => n.text)).toEqual(['n']);
      // A mark on the *opening* marker leaves the comment a comment.
      expect(parse(doc(`<!--${mark} hidden -->`, '', 'after'))).toHaveLength(1);
    }
  });

  // Swift: testParserFrontMatterFieldSurvivesAMarkOnItsSeparator
  it('finds a front-matter field whose separator carries a mark', () => {
    for (const mark of MARKS) {
      const matter = expectKind(
        parse(doc('---', 'title: T', `author:${mark} A`, '---', '', 'body'))[0],
        'frontMatter',
      );
      expect(matter.fields.map((f) => f.key)).toEqual(['title', 'author']);
      expect(matter.fields.map((f) => f.value)).toEqual(['T', `${mark} A`]);
    }
  });

  it('does not let quote stripping eat the mark behind an opening quote', () => {
    // Two graphemes can be three scalars; dropping the first *grapheme* would
    // take the mark off the character behind the quote with it.
    for (const mark of MARKS) {
      const matter = expectKind(
        parse(doc('---', `title: "${mark}Q"`, '---', '', 'body'))[0],
        'frontMatter',
      );
      expect(matter.fields).toEqual([{ key: 'title', value: `${mark}Q` }]);
    }
  });
});

// MARK: - `parseWithLines`, the one VS Code-only addition

describe('parseWithLines', () => {
  it('is the same walk as parse', () => {
    // The contract's invariant. It holds by construction — both are
    // projections of one `scan()` — rather than by two implementations
    // agreeing out of discipline, which is the failure mode the whole port is
    // guarding against. `golden.test.ts` asserts the same thing over the
    // entire fixture corpus.
    const source = doc(
      '---',
      'title: T',
      '---',
      '',
      '# Heading',
      '',
      'Paragraph.',
      '',
      '- item',
      '',
      '> quoted',
      '',
      '```js',
      'code()',
      '```',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '---',
      '',
      '\\newpage',
      '',
      '<!-- note: n -->',
      '',
      '[^a]: note',
    );
    expect(parse(source)).toEqual(parseWithLines(source).map((p) => p.block));
  });

  it('records the 0-based line each top-level block started on', () => {
    const placed = parseWithLines(
      doc(
        '# Heading', // 0
        '', // 1
        'Paragraph', // 2
        'continued', // 3
        '', // 4
        '```', // 5
        'code', // 6
        '```', // 7
      ),
    );
    expect(placed.map((p) => p.line)).toEqual([0, 2, 5]);
  });

  it('places front matter on line 0 and the block after it on the right line', () => {
    const placed = parseWithLines(doc('---', 'title: T', '---', '', '# H'));
    expect(placed.map((p) => [p.block.kind, p.line])).toEqual([
      ['frontMatter', 0],
      ['heading', 4],
    ]);
  });

  it('gives a setext heading the line of its text, not its underline', () => {
    const placed = parseWithLines(doc('Intro', '', 'Title', '==='));
    expect(placed.map((p) => [p.block.kind, p.line])).toEqual([
      ['paragraph', 0],
      ['heading', 2],
    ]);
  });
});

// MARK: - §15 A mixed document

describe('mixed document', () => {
  // Swift: testMixedDocumentBlockSequence
  it('reads the whole block sequence', () => {
    expect(
      kinds(
        doc(
          '# Title',
          '',
          'Intro paragraph.',
          '',
          '- one',
          '- two',
          '',
          '> a quote',
          '',
          '```',
          'code',
          '```',
          '',
          '---',
        ),
      ),
    ).toEqual(['heading', 'paragraph', 'list', 'quote', 'codeBlock', 'thematicBreak']);
  });
});
