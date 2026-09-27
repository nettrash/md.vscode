//
//  dialect.test.ts
//  md.vscode — the md-dialect lint, rule by rule, and the two quick fixes
//  proved by applying them.
//
//  WHAT THIS SUITE IS ACTUALLY GUARDING
//  ------------------------------------
//  A lint that reports a difference which is not there is worse than no lint
//  at all: it is a permanent faint underline under correct prose, and the
//  first thing anyone does with one is switch it off. So the false positives
//  get as much space here as the findings do, and `false-positives.md` is
//  asserted to produce **nothing at all** — a less-than sign in arithmetic, a
//  tag shown inside backticks, `arr[0][1]`, an indented paragraph under a
//  list item, a footnote defined further down the file, a commented-out
//  image, a fence, and a fence inside a block quote.
//
//  The two quick fixes are not asserted as strings. A fix that produced text
//  which merely *looked* fenced would pass such a test and corrupt a
//  document; what matters is what the parser makes of the result, so each fix
//  is applied and the document re-parsed. The indented block has to come back
//  as a `codeBlock` carrying the exact code, and the table as a `table` with
//  its header and rows — which is the difference the author was told about in
//  the first place.
//
//  The editor-facing half (`src/lint/diagnostics.ts`) is exercised through
//  `test/vscode-stub.ts`, because the three things worth pinning there are
//  only observable through the host: the severity is Information and nothing
//  else, the settings mean "on unless switched off", and a fix's edit carries
//  the document's own line ending.
//

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DIALECT_RULES,
  dialectFindings,
  ruleEnabled,
  type DialectFinding,
  type DialectFix,
  type DialectRule,
} from '../src/lint/dialect';
import {
  affectsLint,
  diagnosticsFor,
  DIAGNOSTIC_SOURCE,
  fixesFor,
  LINT_DEBOUNCE_MS,
  readLintConfig,
  shouldLint,
} from '../src/lint/diagnostics';
import { renderBody } from '../src/render/html';
import { parse } from '../src/render/parser';
import { normalizedLines } from '../src/render/text';
import {
  changeEvent,
  DiagnosticSeverity,
  EndOfLine,
  stub,
  Uri,
  type WorkspaceEdit,
} from './vscode-stub';

const FIXTURES = path.join(__dirname, 'fixtures', 'dialect');

const fixture = (name: string): string => readFileSync(path.join(FIXTURES, `${name}.md`), 'utf8');

/** The codes reported for a source, in document order — the whole finding list, compressed. */
const codes = (source: string, switches?: Parameters<typeof dialectFindings>[1]): string[] =>
  dialectFindings(source, switches).map((finding) => finding.code);

/** The rules reported for a source, deduplicated. */
const rules = (source: string): DialectRule[] => [
  ...new Set(dialectFindings(source).map((finding) => finding.rule)),
];

/**
 * Apply a fix the way `fixesFor` asks the editor to, and hand back the whole
 * document — so the assertion can be about what the parser then sees.
 */
function applied(source: string, fix: DialectFix): string {
  const lines = normalizedLines(source);
  return [...lines.slice(0, fix.startLine), ...fix.lines, ...lines.slice(fix.endLine + 1)].join(
    '\n',
  );
}

/** The one finding of a given code, or a failure naming what was found instead. */
function only(source: string, code: string): DialectFinding {
  const found = dialectFindings(source).filter((finding) => finding.code === code);
  expect(found.map((finding) => finding.code), code).toHaveLength(1);
  return found[0];
}

/** The first finding of a given code, for a fixture that deliberately holds several. */
function first(source: string, code: string): DialectFinding {
  const found = dialectFindings(source).filter((finding) => finding.code === code);
  expect(found.length, code).toBeGreaterThan(0);
  return found[0];
}

// MARK: - Raw HTML

describe('rawHtml — md shows tags as the characters you typed', () => {
  const source = fixture('raw-html');

  it('reports every tag, opening, closing and self-closing', () => {
    expect(codes(source)).toEqual(new Array(7).fill('md.dialect.rawHtml'));
  });

  it('puts the range on the tag and not on the line', () => {
    // "Press <b>hard</b> and then <br> once." — the first tag starts at
    // column 6 and is three characters long.
    const first = dialectFindings(source)[0];
    expect([first.line, first.column, first.endLine, first.endColumn]).toEqual([2, 6, 2, 9]);
  });

  it('names the tag in the message, so the Problems pane row is readable alone', () => {
    expect(dialectFindings(source)[0].message).toContain('"<b>"');
  });

  it('offers no quick fix: what the author meant is not mechanical', () => {
    for (const finding of dialectFindings(source)) expect(finding.fix).toBeNull();
  });

  it('is not fooled by arithmetic, by backticks or by maths', () => {
    // The named false positive: a less-than sign in prose is not a tag.
    expect(codes('If 1 < 2 and 3 > 4 then no tag was written.')).toEqual([]);
    expect(codes('Write `<b>` to show a tag.')).toEqual([]);
    expect(codes('The set $\\{x <b> y\\}$ is maths.')).toEqual([]);
    expect(codes('An autolink <https://nettrash.me> is a different difference.')).toEqual([]);
  });

  it('reads a tag that is genuinely there, in the same sentence as one that is not', () => {
    expect(codes('If 1 < 2 then <b>yes</b>.')).toEqual([
      'md.dialect.rawHtml',
      'md.dialect.rawHtml',
    ]);
  });

  it('says nothing about a fenced code block, or a fence inside a quote', () => {
    expect(codes('```html\n<div>x</div>\n```')).toEqual([]);
    expect(codes('> quoted:\n>\n> ```\n> <div>x</div>\n> ```')).toEqual([]);
  });

  it('says nothing about a comment on its own line, which md drops whole', () => {
    expect(codes('Intro.\n\n<!-- <img src="a.png"> -->\n\nOutro.')).toEqual([]);
    // But an inline comment is rendered by md, tag and all, so it is reported.
    expect(codes('Text with <!-- <b> --> in the middle.')).toEqual(['md.dialect.rawHtml']);
  });
});

// MARK: - Reference links

describe('referenceLink — md has neither half of the syntax', () => {
  const source = fixture('reference-links');

  it('reports the three uses and the three definitions', () => {
    expect(codes(source)).toEqual([
      'md.dialect.referenceUse',
      'md.dialect.referenceUse',
      'md.dialect.referenceUse',
      'md.dialect.referenceDefinition',
      'md.dialect.referenceDefinition',
      'md.dialect.referenceDefinition',
    ]);
  });

  it('reports the collapsed form and the image form as well as the full one', () => {
    const texts = dialectFindings(source)
      .filter((finding) => finding.code === 'md.dialect.referenceUse')
      .map((finding) => source.split('\n')[finding.line].slice(finding.column, finding.endColumn));
    expect(texts).toEqual(['[handbook][hb]', '[changelog][]', '![the logo][logo]']);
  });

  it('underlines only the [label]: of a definition, not the URL', () => {
    const definition = dialectFindings(source).find(
      (finding) => finding.code === 'md.dialect.referenceDefinition',
    );
    expect(definition).toBeDefined();
    const line = source.split('\n')[definition!.line];
    expect(line.slice(definition!.column, definition!.endColumn)).toBe('[hb]:');
  });

  it('leaves a bracketed subscript alone when nothing defines that label', () => {
    // The named false positive. `[0][1]` is a reference link on GitHub too —
    // but only if `[1]:` exists, and without it GitHub prints it as written,
    // exactly as md does. No difference, no diagnostic.
    expect(codes('The array subscript arr[0][1] is prose.')).toEqual([]);
  });

  it('reports the same subscript once a definition makes it a link elsewhere', () => {
    expect(codes('The value arr[0][1] here.\n\n[1]: https://example.com')).toEqual([
      'md.dialect.referenceUse',
      'md.dialect.referenceDefinition',
    ]);
  });

  it('matches labels the way CommonMark does — case and inner spacing folded', () => {
    expect(codes('See [the docs][Read  Me].\n\n[read me]: https://example.com')).toEqual([
      'md.dialect.referenceUse',
      'md.dialect.referenceDefinition',
    ]);
  });

  it('underlines the syntax and not the indentation CommonMark allows', () => {
    const source = '  [hb]: https://example.com\n\nSee [it][hb].';
    const definition = only(source, 'md.dialect.referenceDefinition');
    expect([definition.column, definition.endColumn]).toEqual([2, 7]);
  });

  it('is not fooled by a line that only looks like a definition', () => {
    // CommonMark rejects this too — the title is unquoted junk — so GitHub
    // prints it as a paragraph, which is what md does.
    expect(codes('[see]: the section below is not a definition.')).toEqual([]);
  });

  it('never mistakes a footnote definition for a link definition', () => {
    expect(codes('A claim[^a].\n\n[^a]: the note.')).toEqual([]);
  });
});

// MARK: - Indented code

describe('indentedCode — four spaces make a paragraph here', () => {
  const source = fixture('indented-code');

  it('reports each indented block once, not each line', () => {
    expect(codes(source)).toEqual(['md.dialect.indentedCode', 'md.dialect.indentedCode']);
  });

  it('reports a block that opens the document, and one that follows a heading', () => {
    expect(codes('    the very first line')).toEqual(['md.dialect.indentedCode']);
    expect(codes('# Title\n\n    indented')).toEqual(['md.dialect.indentedCode']);
  });

  it('leaves an indented paragraph under a list item alone', () => {
    // The named false positive. A list item takes an indented paragraph as
    // its own continued content on both sides of the fence, so there is no
    // difference to report — and fencing it would change what md draws.
    expect(codes('- A list item\n\n    indented under the item')).toEqual([]);
    expect(codes('> A quote\n\n    indented under the quote')).toEqual([]);
    // The footnote definition carries a finding of its own — nothing cites
    // `[^a]` — so this one is asserted by rule rather than by an empty list.
    expect(rules('[^a]: a note\n\n    indented under the definition')).not.toContain(
      'indentedCode',
    );
  });

  it('says nothing when the indented line merely continues a paragraph', () => {
    // No blank line above it, so CommonMark continues the paragraph too.
    expect(codes('A paragraph\n    indented continuation')).toEqual([]);
  });

  it('fences the whole run, dedented, and the parser reads it back as code', () => {
    const finding = first(source, 'md.dialect.indentedCode');
    expect(finding.fix).not.toBeNull();
    const blocks = parse(applied(source, finding.fix!));
    const code = blocks.find((block) => block.kind === 'codeBlock');
    expect(code).toBeDefined();
    expect(code).toEqual({ kind: 'codeBlock', language: null, code: 'npm install md\nnpm test' });
  });

  it('lengthens the fence when the block itself opens a line with backticks', () => {
    // A three-backtick fence would be closed by the block's own first line,
    // and the rest of the document would spill out of it.
    const source = 'Next:\n\n    ```\n    nested\n    ```';
    const finding = only(source, 'md.dialect.indentedCode');
    const blocks = parse(applied(source, finding.fix!));
    expect(blocks.find((block) => block.kind === 'codeBlock')).toEqual({
      kind: 'codeBlock',
      language: null,
      code: '```\nnested\n```',
    });
  });

  it('never swallows a list or a table that renders correctly today', () => {
    // `    - item` is a level-2 list item to md, so the fence must stop above
    // it however indented it is.
    const source = 'Text:\n\n    code\n\n    - item';
    const finding = only(source, 'md.dialect.indentedCode');
    expect(finding.fix!.endLine).toBe(2);
    expect(parse(applied(source, finding.fix!)).map((block) => block.kind)).toEqual([
      'paragraph',
      'codeBlock',
      'list',
    ]);
  });
});

// MARK: - A table with no blank line above it

describe('tableAfterParagraph — md needs the blank line', () => {
  const source = fixture('table-after-paragraph');

  it('reports the swallowed table and leaves the correct one alone', () => {
    expect(codes(source)).toEqual(['md.dialect.tableAfterParagraph']);
    expect(only(source, 'md.dialect.tableAfterParagraph').line).toBe(3);
  });

  it('agrees with the parser about what is swallowed', () => {
    // The premise of the whole rule: md really does make one paragraph of it.
    expect(parse(source).map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
      'table',
    ]);
  });

  it('is answered by parse(), so a pipe that is not a table says nothing', () => {
    expect(codes('Intro\n| not | a table\n| because no delimiter row')).toEqual([]);
    expect(codes('Intro\na | b\nc | d')).toEqual([]);
  });

  it('still finds a table written without outer pipes and with alignments', () => {
    // The prefilter in front of `parse()` must not be narrower than the
    // parser: a delimiter row needs no leading pipe and may carry colons.
    expect(codes('Intro\nSize | Width\n:--- | ---:\nA4 | 210mm')).toEqual([
      'md.dialect.tableAfterParagraph',
    ]);
  });

  it('says nothing about a table that opens a block', () => {
    expect(codes('| a | b |\n| --- | --- |\n| 1 | 2 |')).toEqual([]);
  });

  it('inserts one blank line, and the parser then reads a table', () => {
    const finding = only(source, 'md.dialect.tableAfterParagraph');
    const blocks = parse(applied(source, finding.fix!));
    expect(blocks.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'table',
      'paragraph',
      'table',
    ]);
    expect(blocks[2]).toEqual({
      kind: 'table',
      header: ['Size', 'Width'],
      alignments: ['leading', 'leading'],
      rows: [
        ['A4', '210mm'],
        ['A5', '148mm'],
      ],
    });
  });
});

// MARK: - Footnotes

describe('footnote — a note nothing points at, and the reference that is not a difference', () => {
  const source = fixture('footnotes');

  it('reports the uncited definition, and says nothing about the orphan references', () => {
    // The fixture holds two references with no definition behind them
    // (`[^orphan]`, `[^late]`) and one definition nothing cites
    // (`[^unused]`). Only the last is a dialect difference: md prints an
    // uncited note at the foot with no link back, where a CommonMark engine
    // swallows the line as a link reference definition and prints nothing at
    // all. An undefined *reference* is left as literal text by every engine
    // there is, md included, so there is no difference to report.
    expect(codes(source)).toEqual(['md.dialect.footnoteNeverCited']);
  });

  it('names the id in the message', () => {
    const found = dialectFindings(source);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('[^unused]');
  });

  it('says nothing about a reference with no definition, because md says nothing either', () => {
    // The rule the whole file is under: a finding claims md draws something
    // a CommonMark engine does not. Asked of md's own renderer, an undefined
    // reference comes back as the characters that were typed — which is
    // byte for byte what markdown-it, the engine the built-in preview
    // renders with, produces for the same line, and what GitHub shows. No
    // difference, so no finding.
    const orphan = 'An orphan footnote[^note] with nothing behind it.';
    expect(renderBody(orphan, { title: 'orphan', dark: false }).html).toBe(`<p>${orphan}</p>`);
    expect(codes(orphan)).toEqual([]);
  });

  it('leaves a negated character class in prose alone', () => {
    // Why the rule had to go, and why these lines are pinned rather than
    // trusted: `[^a-z]` is a regular expression whose body is drawn from the
    // very character set a footnote id is allowed. One sentence of ordinary
    // developer prose used to earn a permanent underline and an offer to
    // define a footnote called `a-z`.
    for (const prose of [
      'Use the pattern [^a-z] to match a non-letter.',
      'Strip with s/[^A-Z]//g when you need it.',
      'The class [^0-9] excludes the digits, [^_0-9] the underscore too.',
    ]) {
      expect(codes(prose), prose).toEqual([]);
    }
  });

  it('counts a definition written after its reference as cited', () => {
    // The named false positive: reading order does not decide this, and the
    // renderer numbers by order of first reference precisely so that it need
    // not.
    expect(codes('A claim[^later].\n\n[^later]: the definition.')).toEqual([]);
  });

  it('does not count a citation written inside another definition', () => {
    // `withFootnotes` never sees a placeholder inside a definition — the
    // definitions render to nothing in the body — so the note really is
    // uncited, and saying otherwise would be a lie about the output.
    expect(codes('Body[^a].\n\n[^a]: see [^b]\n[^b]: the other')).toEqual([
      'md.dialect.footnoteNeverCited',
    ]);
  });

  it('asks the inline pass what counts as a reference, so a non-ASCII id is not one', () => {
    // `inline()` leaves `[^café]` as literal text, exactly as it leaves any
    // other bracketed prose, so there is no reference there to cite anything.
    expect(codes('A claim[^café].')).toEqual([]);
    expect(codes('A claim[^two words].')).toEqual([]);
  });

  it('says nothing about a reference inside backticks', () => {
    expect(codes('Write `[^id]` to cite a note.')).toEqual([]);
  });
});

// MARK: - The whole point

describe('a document written for md reports nothing', () => {
  it('finds no difference in the false-positive fixture', () => {
    expect(dialectFindings(fixture('false-positives'))).toEqual([]);
  });

  it('finds no difference in the shipped examples it should not', () => {
    // The examples are the documents the family hands a new reader, and they
    // are written in md's own dialect throughout. If the lint has anything to
    // say about one of them, either the lint is wrong or the example is
    // teaching a construct md does not render.
    //
    // With one deliberate exception, which is the best proof this suite has
    // that the footnote rule works on prose nobody wrote for it: *09-Writer
    // Tools* demonstrates a note that nothing cites and a reference with no
    // note behind it, in so many words, and says what md does with each. The
    // lint finds exactly those two and nothing else — including nothing for
    // the `[^id]` written inside backticks four lines above them.
    const examples = path.join(__dirname, 'fixtures', 'examples');
    const expected: Record<string, string[]> = {
      '09-Writer Tools': ['md.dialect.footnoteNeverCited'],
    };
    for (const name of [
      '01-Welcome',
      '02-Formatting',
      '03-Tables',
      '04-Code',
      '05-Images',
      '06-Math',
      '07-Diagrams',
      '08-Plots',
      '09-Writer Tools',
    ]) {
      const source = readFileSync(path.join(examples, `${name}.md`), 'utf8');
      expect(codes(source), name).toEqual(expected[name] ?? []);
    }
  });
});

// MARK: - The switches

describe('the per-rule switches', () => {
  it('treats an absent key as on, like every other md.* boolean', () => {
    for (const rule of DIALECT_RULES) {
      expect(ruleEnabled(undefined, rule), rule).toBe(true);
      expect(ruleEnabled({}, rule), rule).toBe(true);
      expect(ruleEnabled({ [rule]: false }, rule), rule).toBe(false);
    }
  });

  it('silences one rule and leaves the others alone', () => {
    const source = [fixture('raw-html'), fixture('footnotes')].join('\n\n');
    expect(rules(source)).toEqual(['rawHtml', 'footnote']);
    expect(codes(source, { rawHtml: false }).every((code) => code.startsWith('md.dialect.footnote'))).toBe(
      true,
    );
    expect(codes(source, { footnote: false }).every((code) => code === 'md.dialect.rawHtml')).toBe(
      true,
    );
  });

  it('judges a reference use against the document, not against the switch', () => {
    // Turning the rule off must not change *which* uses are differences —
    // only whether they are reported — so the definitions are still gathered.
    const source = 'See [a][b].\n\n[b]: https://example.com';
    expect(codes(source)).toEqual(['md.dialect.referenceUse', 'md.dialect.referenceDefinition']);
    expect(codes(source, { referenceLink: false })).toEqual([]);
  });

  it('can be switched off altogether, rule by rule', () => {
    const everything: Record<string, boolean> = {};
    for (const rule of DIALECT_RULES) everything[rule] = false;
    for (const name of ['raw-html', 'reference-links', 'indented-code', 'footnotes']) {
      expect(codes(fixture(name), everything), name).toEqual([]);
    }
  });
});

// MARK: - The editor half

describe('diagnostics — what the Problems pane is handed', () => {
  beforeEach(() => stub());

  it('reports at Information and never higher', () => {
    const diagnostics = diagnosticsFor(fixture('raw-html'), {});
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.severity).toBe(DiagnosticSeverity.Information);
    }
  });

  it('carries the source and the rule code, so a row can be filtered', () => {
    const diagnostic = diagnosticsFor(fixture('raw-html'), {})[0];
    expect(diagnostic.source).toBe(DIAGNOSTIC_SOURCE);
    expect(diagnostic.code).toBe('md.dialect.rawHtml');
  });

  it('carries the range of the finding, not the whole line', () => {
    const diagnostic = diagnosticsFor(fixture('raw-html'), {})[0];
    expect([
      diagnostic.range.start.line,
      diagnostic.range.start.character,
      diagnostic.range.end.line,
      diagnostic.range.end.character,
    ]).toEqual([2, 6, 2, 9]);
  });

  it('honours the switches it is given', () => {
    expect(diagnosticsFor(fixture('raw-html'), { rawHtml: false })).toEqual([]);
  });
});

describe('readLintConfig — on unless switched off', () => {
  it('is on with nothing set', () => {
    stub();
    expect(readLintConfig()).toEqual({ enabled: true, rules: {} });
  });

  it('is off only for an explicit false', () => {
    stub({ 'lint.dialect': false });
    expect(readLintConfig().enabled).toBe(false);
    stub({ 'lint.dialect': true });
    expect(readLintConfig().enabled).toBe(true);
    // A value of the wrong type is not a switch-off.
    stub({ 'lint.dialect': 'no' });
    expect(readLintConfig().enabled).toBe(true);
  });

  it('reads the per-rule map and keeps only the rules that exist', () => {
    stub({ 'lint.rules': { rawHtml: false, footnote: true, smartQuotes: false } });
    expect(readLintConfig().rules).toEqual({ rawHtml: false });
  });
});

describe('affectsLint and shouldLint', () => {
  it('notices md.lint and nothing else', () => {
    const affects = (...sections: readonly string[]): boolean =>
      affectsLint(changeEvent(...sections) as never);
    expect(affects('md.lint.dialect')).toBe(true);
    expect(affects('md.lint.rules')).toBe(true);
    expect(affects('md.lint')).toBe(true);
    expect(affects('md.preview.theme')).toBe(false);
    expect(affects('editor.fontSize')).toBe(false);
  });

  it('runs on Markdown and on nothing else', () => {
    const document = (languageId: string): never =>
      ({ languageId } as unknown as never);
    expect(shouldLint(document('markdown'))).toBe(true);
    expect(shouldLint(document('plantuml'))).toBe(false);
    expect(shouldLint(document('plaintext'))).toBe(false);
  });

  it('waits half a second before re-linting a document being typed into', () => {
    expect(LINT_DEBOUNCE_MS).toBe(500);
  });
});

describe('fixesFor — the edit the lightbulb applies', () => {
  beforeEach(() => stub());

  /** As much of a TextDocument as `fixesFor` reads. */
  const document = (text: string, eol: number = EndOfLine.LF): never =>
    ({ uri: Uri.file('/w/notes.md'), getText: () => text, eol } as unknown as never);

  const lineRange = (line: number): never =>
    ({ start: { line, character: 0 }, end: { line, character: 0 } } as unknown as never);

  it('offers the fence on the indented block and nothing on the line above', () => {
    const source = fixture('indented-code');
    expect(fixesFor(document(source), lineRange(4), {})).toHaveLength(1);
    expect(fixesFor(document(source), lineRange(4), {})[0].title).toContain('fenced');
    expect(fixesFor(document(source), lineRange(0), {})).toEqual([]);
  });

  it('writes the replacement over exactly the lines the fix names', () => {
    const source = fixture('table-after-paragraph');
    const action = fixesFor(document(source), lineRange(3), {})[0];
    const edit = action.edit as unknown as WorkspaceEdit;
    expect(edit.edits).toHaveLength(1);
    const [written] = edit.edits;
    expect([
      written.range.start.line,
      written.range.start.character,
      written.range.end.line,
      written.range.end.character,
    ]).toEqual([3, 0, 3, '| Size | Width |'.length]);
    expect(written.newText).toBe('\n| Size | Width |');
  });

  it('uses the line ending the document already uses, so a CRLF file stays CRLF', () => {
    const source = fixture('table-after-paragraph').replace(/\n/g, '\r\n');
    const action = fixesFor(document(source, EndOfLine.CRLF), lineRange(3), {})[0];
    const edit = action.edit as unknown as WorkspaceEdit;
    expect(edit.edits[0].newText).toBe('\r\n| Size | Width |');
  });

  it('attaches the diagnostic, so the Problems pane can offer the same action', () => {
    const action = fixesFor(document(fixture('table-after-paragraph')), lineRange(3), {})[0];
    expect(action.diagnostics).toHaveLength(1);
    expect(action.diagnostics![0].code).toBe('md.dialect.tableAfterParagraph');
    expect(action.diagnostics![0].severity).toBe(DiagnosticSeverity.Information);
  });

  it('offers nothing for the rules whose fix would be a guess', () => {
    expect(fixesFor(document(fixture('raw-html')), lineRange(2), {})).toEqual([]);
    expect(fixesFor(document(fixture('reference-links')), lineRange(2), {})).toEqual([]);
    expect(fixesFor(document(fixture('footnotes')), lineRange(7), {})).toEqual([]);
  });

  it('offers nothing when its rule is switched off', () => {
    const source = fixture('indented-code');
    expect(fixesFor(document(source), lineRange(4), { indentedCode: false })).toEqual([]);
  });
});
