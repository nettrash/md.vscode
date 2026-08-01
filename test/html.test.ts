//
//  html.test.ts
//  md.vscode — the block serializer, the document skeleton and the engine gate.
//
//  Ported from the `testHTML…`, `testCSV…`, `testDelimited…`, `testRaw…` and
//  `testGraphvizInkRules…` families in `md/mdTests/mdTests.swift`; catalogued
//  in `specs/06-tests.md` §14, §16–§19 and §26.
//
//  THE PARITY CONTRACT UNDER TEST
//  ------------------------------
//  With `opts.engines` absent, `renderDocument` must produce byte-identical
//  output to `MarkdownHTML.document(_:title:dark:export:)`. Two VS Code-only
//  affordances layer on top — host-side engine hooks and `data-line`
//  attributes — and both must be strictly additive: neither may change a byte
//  of the default output, and a hook returning `null` must leave its container
//  exactly as the no-hook path wrote it. Those are separate `describe` blocks
//  below, and the byte-diff assertions run with both switched off.
//
//  ASSERTION STYLE, COPIED FROM THE SWIFT SUITE
//  --------------------------------------------
//  "Assert on the emitted markup, not the class name: the stylesheet names
//  every class unconditionally, so a bare `contains` would pass no matter what
//  the body actually holds." Every negative assertion here therefore includes
//  the `<` of the tag, and the gating tests read `renderBody().needs` or the
//  `<head>` rather than grepping the whole page.
//

import { describe, expect, it } from 'vitest';

import {
  css,
  delimitedTable,
  graphvizEngines,
  isDecimalNumber,
  isRawGraphviz,
  isRawPlantUML,
  parseDelimited,
  renderBlock,
  renderBody,
  renderDocument,
} from '../src/render/html';
import type { EngineHooks, EngineNeeds, RenderOptions } from '../src/render/html';
import { parse } from '../src/render/parser';

const ZWSP = String.fromCodePoint(0x200b); // ZERO WIDTH SPACE
const NEL = String.fromCodePoint(0x0085); // NEXT LINE
const ACUTE = String.fromCodePoint(0x0301); // COMBINING ACUTE ACCENT

/** Join lines without fighting a template literal over ``` fences. */
function doc(...parts: string[]): string {
  return parts.join('\n');
}

/** The default screen render — the bytes the parity contract is about. */
function body(source: string, options: Partial<RenderOptions> = {}): string {
  return renderBody(source, { title: 't', dark: false, ...options }).html;
}

function needs(source: string): EngineNeeds {
  return renderBody(source, { title: 't', dark: false }).needs;
}

/** Everything between `<style>` and `</style>`. */
function styleBlock(html: string): string {
  const open = html.indexOf('<style>') + '<style>'.length;
  return html.slice(open, html.indexOf('</style>', open));
}

// MARK: - §14 The document skeleton

describe('document skeleton', () => {
  // Swift: testHTMLWrapsDocument
  it('wraps the body in a themed page', () => {
    const html = renderDocument('# Title', { title: 'Doc', dark: false });
    expect(html.startsWith('<!DOCTYPE html>\n<html lang="en">\n<head>\n')).toBe(true);
    expect(html).toContain('<title>Doc</title>');
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain('<body data-md-dark="0">');
    expect(html).toContain('<script type="module" src="rich/md-init.js"></script>');
  });

  it('escapes the title', () => {
    // It is always the caller's string: nothing is sniffed from an H1 or from
    // front matter, which is parsed but never rendered and never feeds it.
    expect(renderDocument('x', { title: 'a & <b>', dark: false })).toContain(
      '<title>a &amp; &lt;b&gt;</title>',
    );
  });

  it('glues the head includes directly onto </style> and ends at </html>', () => {
    // Byte-relevant, both of them. An empty head yields `</style>\n</head>`;
    // a maths document reads `…</style><link rel="stylesheet" …>` on one line.
    // The returned string has no trailing newline.
    const plain = renderDocument('hi', { title: 't', dark: false });
    expect(plain).toContain('</style>\n</head>');
    expect(plain.endsWith('</html>')).toBe(true);

    const maths = renderDocument('$a+b$', { title: 't', dark: false });
    expect(maths).toContain('</style><link rel="stylesheet" href="rich/katex.min.css">');
  });

  it('leaves a blank line where an empty source’s body would be', () => {
    // Part of the bytes: `<body …>` then the join of no blocks then the script.
    expect(renderDocument('', { title: 't', dark: false })).toContain(
      '<body data-md-dark="0">\n\n<script type="module"',
    );
  });

  it('rewrites every asset URL through assetBase', () => {
    // How VS Code hands the preview its webview URIs. Never a `<base href>`:
    // that would turn `href="#slug"` into a cross-document navigation and
    // break the one link kind the host allows.
    const html = renderDocument('$a+b$', {
      title: 't',
      dark: false,
      assetBase: 'vscode-resource://ext/media/rich',
    });
    expect(html).toContain('href="vscode-resource://ext/media/rich/katex.min.css"');
    expect(html).toContain('src="vscode-resource://ext/media/rich/md-init.js"');
    expect(html).not.toContain('"rich/');
  });

  // Swift: testHTMLEscapesSpecialCharacters
  it('escapes the prose', () => {
    expect(body('a < b & c > d')).toContain('a &lt; b &amp; c &gt; d');
  });
});

// MARK: - Block emission

describe('blocks', () => {
  it('renders a paragraph with soft breaks as <br> plus a real newline', () => {
    // So a two-line paragraph is still two lines of source in the generated
    // HTML — and the conversion happens before protected spans are restored,
    // so a multi-line display formula keeps its own newlines.
    expect(body(doc('one', 'two'))).toBe('<p>one<br>\ntwo</p>');
  });

  it('renders a flat list, never a <ul> or an <ol>', () => {
    // The parser's model is flat with a `level` integer; rebuilding a tree
    // here would be a second, drifting interpretation of it. Markers are
    // entities, not literal characters — the EPUB builder rewrites `&bull;` to
    // `&#8226;` because named entities are undefined in XML.
    const html = body(doc('- a', '  - b'));
    expect(html).toBe(
      '<div class="md-list">' +
        '<div class="md-item" style="padding-left:0.00em"><span class="md-marker">&bull;</span><span>a</span></div>' +
        '<div class="md-item" style="padding-left:1.60em"><span class="md-marker">&bull;</span><span>b</span></div>' +
        '</div>',
    );
    expect(html).not.toContain('<ul>');
    expect(html).not.toContain('<ol>');
  });

  it('lets a task box beat an ordinal and marks a done item', () => {
    const html = body(doc('1. [x] done', '2. plain'));
    expect(html).toContain('<div class="md-item done" style="padding-left:0.00em"><span class="md-marker">&#9745;</span>');
    expect(html).toContain('<span class="md-marker">2.</span>');
    expect(body('- [ ] open')).toContain('<span class="md-marker">&#9744;</span>');
  });

  it('falls back to a bullet for an unordered item inside an ordered run', () => {
    expect(body(doc('1. one', '- two'))).toContain('<span class="md-marker">&bull;</span><span>two</span>');
  });

  // Swift: testHTMLTableAlignmentsAndCells
  it('renders a table with an inline style per cell', () => {
    expect(body(doc('| A | B |', '|:-:|--:|', '| 1 | 2 |'))).toBe(
      '<table><thead><tr>' +
        '<th style="text-align:center">A</th><th style="text-align:right">B</th>' +
        '</tr></thead><tbody><tr>' +
        '<td style="text-align:center">1</td><td style="text-align:right">2</td>' +
        '</tr></tbody></table>',
    );
  });

  it('emits <tbody> even with no rows and defaults a stray column to left', () => {
    expect(body(doc('| A |', '| --- |'))).toContain('<tbody></tbody>');
    expect(
      renderBlock(
        { kind: 'table', header: ['A'], alignments: [], rows: [['1']] },
        { title: 't', dark: false },
      ),
    ).toContain('<th style="text-align:left">A</th>');
  });

  it('runs every table cell through the inline pass', () => {
    expect(body(doc('| `a` |', '| --- |', '| *b* |'))).toContain('<td style="text-align:left"><em>b</em></td>');
  });

  it('renders the simple kinds', () => {
    expect(body('---')).toBe('<hr>');
    expect(body('\\newpage')).toBe('<div class="md-pagebreak"></div>');
    expect(body('> quoted')).toBe('<blockquote>\n<p>quoted</p>\n</blockquote>');
  });

  it('renders a nested heading without an id', () => {
    // Only `renderBody` owns the slug counter, so the nested form emitted by
    // `renderBlock` carries no anchor.
    expect(renderBlock({ kind: 'heading', level: 3, text: 'Inside' }, { title: 't', dark: false })).toBe(
      '<h3>Inside</h3>',
    );
  });

  it('renders notes, front matter and footnote definitions as nothing at all', () => {
    // Private notes live in the editor and the notes panel only; metadata is
    // about the document, not part of it; a definition is printed at the foot
    // of the page rather than where it was written.
    for (const block of parse(doc('<!-- note: n -->'))) {
      expect(renderBlock(block, { title: 't', dark: false })).toBe('');
    }
    expect(body(doc('---', 'title: T', '---', '', 'Body.'))).toBe('\n<p>Body.</p>');
  });

  it('keeps the blank lines an empty block leaves in the join', () => {
    // Blocks that render to "" still take part in the "\n" join, and the
    // footnote section adds another leading "\n". Both are observable bytes.
    expect(body(doc('Text[^a].', '', '[^a]: The note.'))).toContain(
      '</p>\n\n<section class="md-footnotes">',
    );
  });
});

// MARK: - §16 Rich containers

describe('rich containers', () => {
  // Swift: testHTMLMermaidBlockEmitsContainer
  it('emits a Mermaid container, never a code block', () => {
    const html = body(doc('```mermaid', 'graph TD', 'A-->B', '```'));
    expect(html).toBe('<pre class="mermaid">graph TD\nA--&gt;B</pre>');
    expect(html).not.toContain('<pre><code>graph TD');
  });

  // Swift: testHTMLPlantumlBlockEmitsContainer
  it('emits a PlantUML container for all three spellings', () => {
    for (const language of ['plantuml', 'puml', 'plant-uml']) {
      expect(body(doc('```' + language, '@startuml', '@enduml', '```')), language).toBe(
        '<div class="plantuml">@startuml\n@enduml</div>',
      );
    }
  });

  // Swift: testHTMLGraphvizBlockEmitsContainer / …AliasesAndLayoutEngines
  it('maps every fence word onto its layout program', () => {
    // `data-engine` is the mapped *value*, never the author's info word, so
    // the attribute needs no escaping. Never widen that table with anything
    // the author controls.
    expect(Object.keys(graphvizEngines)).toHaveLength(10);
    expect(new Set(Object.values(graphvizEngines)).size).toBe(8);
    for (const [word, engine] of Object.entries(graphvizEngines)) {
      expect(body(doc('```' + word, 'digraph { a -> b }', '```')), word).toBe(
        `<div class="graphviz" data-engine="${engine}">digraph { a -&gt; b }</div>`,
      );
    }
  });

  // Swift: testHTMLGraphvizEscapesAngleBrackets
  it('escapes DOT’s HTML-like labels into the container', () => {
    // md-init.js reads `el.textContent`, which decodes it back; without the
    // escaping the label markup would be parsed as page markup.
    const html = body(doc('```dot', 'digraph { n [label=<<b>hi</b>>] }', '```'));
    expect(html).toContain('&lt;&lt;b&gt;hi&lt;/b&gt;&gt;');
    expect(html).not.toContain('<b>hi</b>');
  });

  // Swift: testHTMLMathFenceEmitsDisplayMath
  it('emits a display-math div for a math fence', () => {
    // Note the shape: a fence is a `<div>` while `$$…$$` inside a paragraph is
    // a `<span>`. Both are display mode and both are found by `.md-mathd`.
    for (const language of ['math', 'latex', 'tex']) {
      expect(body(doc('```' + language, '\\int_0^1 x\\,dx', '```')), language).toBe(
        '<div class="md-mathd">\\int_0^1 x\\,dx</div>',
      );
    }
  });

  // Swift: testHTMLCodeLanguageEmitsHighlightClassAndLoadsEngine
  it('lower-cases the info word into a language- class', () => {
    // The class must *begin* with `language-`, because md-init.js selects with
    // `code[class^="language-"]`, an attribute-starts-with match.
    expect(body(doc('```Swift', 'let x = 1', '```'))).toBe(
      '<pre><code class="language-swift">let x = 1</code></pre>',
    );
  });

  // Swift: testHTMLBareFenceAndSpecialFencesAreNotHighlighted
  it('leaves a bare fence bare', () => {
    const html = body(doc('```', 'plain text', '```'));
    expect(html).toBe('<pre><code>plain text</code></pre>');
    expect(html).not.toContain('language-');
  });

  it('resolves the info word case-insensitively for every rich language', () => {
    expect(body(doc('```MERMAID', 'graph TD', '```'))).toContain('<pre class="mermaid">');
    expect(body(doc('```DOT', 'digraph {}', '```'))).toContain('data-engine="dot"');
  });
});

// MARK: - §16b The engine gate

describe('engine gating', () => {
  // The gate is a substring scan of the *emitted markup*, never of the block
  // list — because `renderBlock` recurses into quotes, so a top-level scan
  // would emit a container and never include its engine, leaving the diagram
  // stuck as its own source text.
  const off = { math: false, mermaid: false, plantuml: false, graphviz: false, highlight: false };

  it('pulls in nothing for plain prose, a code span or a bare fence', () => {
    expect(needs('# Title\n\nJust prose.')).toEqual(off);
    expect(needs('a `code span` here')).toEqual(off);
    expect(needs(doc('```', 'plain', '```'))).toEqual(off);
  });

  it('pulls in nothing for two currency amounts', () => {
    // `inline()` emits a math span only for a real formula, which is what has
    // always kept KaTeX out of prose with stray dollar signs in it.
    expect(needs('it costs $5 and $10 today')).toEqual(off);
    const html = renderDocument('it costs $5 and $10 today', { title: 't', dark: false });
    expect(html).toContain('$5 and $10');
    expect(html).not.toContain('katex.min.js');
    expect(html).not.toContain('mhchem.min.js');
  });

  it('keys each engine off its own container', () => {
    expect(needs('$a+b$')).toEqual({ ...off, math: true });
    expect(needs('$$a+b$$')).toEqual({ ...off, math: true });
    expect(needs(doc('```math', 'x', '```'))).toEqual({ ...off, math: true });
    expect(needs(doc('```mermaid', 'graph TD', '```'))).toEqual({ ...off, mermaid: true });
    expect(needs(doc('```plantuml', '@startuml', '```'))).toEqual({ ...off, plantuml: true });
    expect(needs(doc('```dot', 'digraph {}', '```'))).toEqual({ ...off, graphviz: true });
    expect(needs(doc('```swift', 'let x = 1', '```'))).toEqual({ ...off, highlight: true });
    expect(needs(doc('```csv', 'a,b', '1,2', '```'))).toEqual(off);
  });

  it('pulls the engine in for a diagram nested inside a block quote', () => {
    // THE reason the gate reads the markup and not the block list.
    expect(needs(doc('> ```dot', '> digraph { a }', '> ```'))).toEqual({
      ...off,
      graphviz: true,
    });
    const html = renderDocument(doc('> ```mermaid', '> graph TD', '> ```'), {
      title: 't',
      dark: false,
    });
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain('rich/mermaid.min.js');
  });

  it('still gates correctly when data-line attributes are added', () => {
    // `class="mermaid"` becomes `class="mermaid code-line"` under
    // `sourceLines`, which would silently stop matching a whole-tag probe and
    // ship a Mermaid document with no Mermaid. The gate reads the undecorated
    // markup for exactly that reason.
    const rendered = renderBody(doc('```mermaid', 'graph TD', '```'), {
      title: 't',
      dark: false,
      sourceLines: true,
    });
    expect(rendered.html).toContain('<pre class="mermaid code-line" data-line="0">');
    expect(rendered.needs.mermaid).toBe(true);
  });

  it('pulls in KaTeX for prose that merely names the class — verified, and kept', () => {
    // The "escaping prevents false positives" argument holds for the four
    // tag-shaped probes, and is FALSE for math: `md-mathi` / `md-mathd`
    // contain no `<`, `>` or `"`. Harmless at runtime (KaTeX finds no
    // elements) and a real byte difference. Reproduced on purpose.
    expect(needs('The class md-mathd is mentioned in prose.').math).toBe(true);
  });

  it('loads mhchem with KaTeX, after KaTeX, sharing its defer', () => {
    // Deferred classic scripts run in document order: KaTeX defines the global
    // `katex`, then mhchem registers `\ce{}` onto it, before md-init.js — a
    // deferred module, and last — calls `katex.render()`. mhchem silently
    // no-ops against a mismatched KaTeX, so the two files are version-locked
    // and must always be replaced together.
    const html = renderDocument('Reaction $\\ce{H2O}$ here', { title: 't', dark: false });
    expect(html).toContain('<script defer src="rich/katex.min.js"></script>');
    expect(html).toContain('<script defer src="rich/mhchem.min.js"></script>');
    expect(html.indexOf('katex.min.js')).toBeLessThan(html.indexOf('mhchem.min.js'));
  });

  it('shares one viz-global.js between PlantUML and a dot fence', () => {
    // PlantUML needs Viz for its own Graphviz-backed layouts, and a ```dot
    // block is that same engine addressed directly — so a dot block adds zero
    // payload over what PlantUML already needed. PlantUML itself is never
    // included in the head; md-init.js imports it lazily.
    for (const source of [
      doc('```plantuml', '@startuml', '```'),
      doc('```dot', 'digraph {}', '```'),
    ]) {
      const html = renderDocument(source, { title: 't', dark: false });
      expect(html).toContain('<script src="rich/viz-global.js"></script>');
      expect(html).not.toContain('plantuml.js');
    }
  });

  it('emits the highlight include as a deferred script', () => {
    expect(renderDocument(doc('```swift', 'x', '```'), { title: 't', dark: false })).toContain(
      '<script defer src="rich/highlight.min.js"></script>',
    );
  });

  it('leaves a plain document light', () => {
    const html = renderDocument('# Title\n\nJust prose.', { title: 't', dark: false });
    for (const engine of ['katex.min.js', 'mermaid.min.js', 'viz-global.js', 'highlight.min.js']) {
      expect(html, engine).not.toContain(engine);
    }
    expect(html).toContain('rich/md-init.js');
  });
});

// MARK: - §19 CSV and TSV

describe('delimited data', () => {
  // Swift: testCSVFenceRendersAsATable
  it('draws a csv fence as a table', () => {
    const html = body(doc('```csv', 'Name,Role', 'Ann,Editor', '```'));
    expect(html).toContain('<th style="text-align:left">Name</th>');
    expect(html).toContain('<td style="text-align:left">Ann</td>');
    expect(html).not.toContain('<pre><code>Name,Role');
  });

  // Swift: testTSVFenceUsesTabs / testCSVNumericColumnsAreRightAligned
  it('right-aligns a column whose every filled cell is a number', () => {
    // Alignment is inferred from the body only: the header text never votes,
    // and empty cells are ignored rather than disqualifying.
    const html = body(doc('```tsv', 'City\tPeople', 'Oslo\t709037', '```'));
    expect(html).toContain('<th style="text-align:left">City</th>');
    expect(html).toContain('<td style="text-align:right">709037</td>');
    expect(body(doc('```csv', 'A', '1', 'n/a', '```'))).toContain(
      '<th style="text-align:left">A</th>',
    );
  });

  // Swift: testEmptyCSVFenceStaysACodeBlock
  it('keeps a block that parses to nothing as a bare code block', () => {
    // Nothing the author wrote may disappear because it failed to parse — and
    // the fallback is the *bare* `<pre><code>` form, which is what keeps it
    // from tripping the highlight gate.
    const html = body(doc('```csv', '```'));
    expect(html).toBe('<pre><code></code></pre>');
    expect(needs(doc('```csv', '```')).highlight).toBe(false);
  });

  // Swift: testDecimalNumberGrammarIsExplicitNotDoubleInit
  it('spells the number grammar out rather than asking a standard library', () => {
    // `Double("0x10")` is 16 in Swift and a failure in Java; `Number("")` is 0
    // and `Number(" 1 ")` is 1 in JavaScript. Hand-writing the scanner is the
    // same rule everywhere — and the honest one: a hex literal is not a figure
    // whose decimal point can line up with anything.
    for (const yes of ['0', '-1', '+2', '3.5', '.5', '5.', '1e9', '-2.5E-3', '007']) {
      expect(isDecimalNumber(yes), yes).toBe(true);
    }
    for (const no of [
      '0x10', 'inf', 'Inf', 'INF', 'nan', 'NaN', '1,000', '1 000', '', '-', '.',
      'e5', '1e', '1e+', '12abc', '1.2.3', String.fromCodePoint(0x0663), String.fromCodePoint(0x00bd),
    ]) {
      expect(isDecimalNumber(no), JSON.stringify(no)).toBe(false);
    }
  });

  it('trims the alignment cell with ASCII space and tab only', () => {
    // An invisible U+200B is not padding: Foundation's `.whitespaces` strips it
    // and a Zs-based trim does not, so the alignment scan trims ASCII only and
    // every platform agrees the cell is not a number. This is deliberately the
    // *opposite* decision from the blank-line set.
    expect(body(doc('```csv', 'Item,Value', `a,${ZWSP}1${ZWSP}`, '```'))).toContain(
      '<th style="text-align:left">Value</th>',
    );
    expect(body(doc('```csv', 'Item,Value', 'a, 1 ', '```'))).toContain(
      '<th style="text-align:right">Value</th>',
    );
  });

  // Swift: testDelimitedParsingFollowsRFC4180
  it('parses RFC 4180', () => {
    expect(parseDelimited('Name,Note\n"Doe, Jane","She said ""hi"""\nAnn,\n', ',')).toEqual([
      ['Name', 'Note'],
      ['Doe, Jane', 'She said "hi"'],
      ['Ann', ''],
    ]);
    expect(parseDelimited('a,"one\ntwo"\n', ',')).toEqual([['a', 'one\ntwo']]);
    // A quote only *opens* a quoted field while the field is still empty.
    expect(parseDelimited('5" pipe,x', ',')).toEqual([['5" pipe', 'x']]);
    expect(parseDelimited('a,b', ',')).toEqual([['a', 'b']]);
    expect(parseDelimited('""', ',')).toEqual([]);
  });

  // Swift: testDelimitedParsingHandlesWindowsLineEndings
  it('normalises Windows and classic-Mac line endings first', () => {
    // Spreadsheet exports are exactly where CRLF comes from.
    expect(parseDelimited('a,b\r\nc,d\r\n', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseDelimited('a,b\rc,d', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('shares one table builder with the LaTeX writer', () => {
    // Split out so a column cannot be right-aligned in the PDF and
    // left-aligned in the `.tex`. One copy, by design.
    expect(delimitedTable('City,People\nOslo,709037', ',')).toEqual({
      header: ['City', 'People'],
      alignments: ['leading', 'trailing'],
      rows: [['Oslo', '709037']],
    });
    expect(delimitedTable('', ',')).toBeNull();
  });
});

// MARK: - §18 Raw whole-file diagram documents

describe('raw diagram documents', () => {
  // Swift: testRawPlantUMLDocumentRendersAsDiagram
  it('recognises a raw PlantUML file', () => {
    for (const source of [
      '@startuml\nAlice -> Bob: hi\n@enduml\n',
      "' header comment\n\n@startmindmap\n* root\n@endmindmap",
      '   \n@startuml\n@enduml',
      // CRLF files must work.
      '\r\n@startuml\r\nA -> B\r\n@enduml\r\n',
      "' note\r\n\r\n@startmindmap\r\n* r\r\n@endmindmap",
    ]) {
      expect(isRawPlantUML(source), JSON.stringify(source)).toBe(true);
    }
    // The *first* qualifying line decides, so prose that merely mentions the
    // opener stays Markdown.
    expect(isRawPlantUML('# Title\n\nSome prose about @startuml in passing.')).toBe(false);
    expect(isRawPlantUML('')).toBe(false);
  });

  it('renders a raw PlantUML file as one diagram', () => {
    const html = renderDocument('@startuml\nA -> B\n@enduml\n', { title: 't', dark: false });
    expect(html).toContain('<div class="plantuml">');
    expect(html).toContain('rich/viz-global.js');
    expect(html).not.toContain('<p>@startuml');
  });

  // Swift: testRawGraphvizDocumentRendersAsDiagram
  it('matches DOT’s grammar rather than a prefix', () => {
    // `graph` is an ordinary English word, so the opener is matched against
    // `[strict] (graph | digraph) [ID] '{'`. "graph theory is a branch of…"
    // has three words where DOT allows at most one name and then a brace.
    for (const yes of [
      'digraph { a -> b }',
      'graph {}',
      'strict digraph G {\n}',
      'DiGraph Foo {\n}',
      'digraph{a}',
      'digraph\n{\n  a\n}',
      '// generated\n\n/* by hand */\ndigraph { a }',
      'digraph "my graph" {\n}',
      `digraph cafe${ACUTE} {\n}`,
      'digraph café {\n}',
      `digraph ${String.fromCodePoint(0x2169)} {\n}`,
      `// generated${NEL}digraph G {${NEL}}`,
      '\r\ndigraph G {\r\n  a -> b;\r\n}\r\n',
      '// generated\r\ndigraph G {\r\n}\r\n',
    ]) {
      expect(isRawGraphviz(yes), JSON.stringify(yes)).toBe(true);
    }
    for (const no of [
      // A `#` line is deliberately NOT skipped: every Markdown heading starts
      // with one, and skipping them would let the check see straight past the
      // title of an ordinary document.
      '# Notes\n\ngraph { the mental model }',
      'graph theory is a branch of maths.\n\nSee $\\frac{a}{b}$.',
      'digraph models are useful { in theory }',
      'graphviz is a fine tool { see }',
      'digraphs are a topic { here }',
      'digraph without a brace',
      '# Title\n\nSome prose about digraph { } in passing.',
      '',
    ]) {
      expect(isRawGraphviz(no), JSON.stringify(no)).toBe(false);
    }
  });

  it('renders a raw Graphviz file as one diagram', () => {
    const html = renderDocument('digraph G {\n  a -> b;\n}\n', { title: 't', dark: false });
    expect(html).toContain('<div class="graphviz" data-engine="dot">');
    expect(html).toContain('rich/viz-global.js');
    expect(html).not.toContain('<p>digraph');
  });

  it('leaves a Markdown document that merely contains a dot fence as Markdown', () => {
    const html = renderDocument(doc('# Title', '', '```dot', 'digraph { a }', '```', ''), {
      title: 't',
      dark: false,
    });
    expect(html).toContain('<h1');
    expect(html).toContain('class="graphviz"');
  });
});

// MARK: - §10b Footnote numbering and markup

describe('footnotes', () => {
  // Swift: testFootnoteDefinitionIsParsedAndNotDrawnInPlace
  it('prints the note at the foot of the page, not where it was written', () => {
    const html = body(doc('Text[^a].', '', '[^a]: The note.'));
    expect(html).not.toContain('<p>[^a]: The note.</p>');
    expect(html).toContain('<li id="fn-1">The note.');
  });

  // Swift: testFootnotesAreNumberedByFirstReferenceNotDefinitionOrder
  it('numbers by order of first reference', () => {
    // The order a reader meets them, not the order the definitions happen to
    // be written in.
    const html = body(doc('See[^b] then[^a].', '', '[^a]: Alpha.', '[^b]: Bravo.'));
    expect(html).toContain('<li id="fn-1">Bravo.');
    expect(html).toContain('<li id="fn-2">Alpha.');
    expect(html.indexOf('#fn-1')).toBeLessThan(html.indexOf('#fn-2'));
  });

  // Swift: testRepeatedFootnoteReferenceGetsItsOwnAnchor
  it('gives a repeated citation its own anchor and one shared back-link', () => {
    const html = body(doc('One[^a] two[^a].', '', '[^a]: Note.'));
    expect(html.split('href="#fn-1"')).toHaveLength(3); // exactly two occurrences
    expect(html).toContain('id="fnref-1"');
    expect(html).toContain('id="fnref-1-2"');
    // The back-link always targets the *first* citation, never `fnref-1-2`.
    expect(html).toContain('<a class="md-fnback" href="#fnref-1">&#8617;</a>');
  });

  // Swift: testFootnoteReferenceWithoutDefinitionStaysLiteralText
  it('reverts an undefined reference to the text the author typed', () => {
    // Linking it to nothing would be worse than leaving it alone.
    const html = body('A claim[^nope].');
    expect(html).toContain('[^nope]');
    expect(html).not.toContain('<sup class="md-fnref"');
    expect(html).not.toContain('<section class="md-footnotes">');
  });

  // Swift: testUnreferencedFootnoteIsStillPrinted
  it('still prints a definition nobody cited, with no back-link', () => {
    // Dropping it would silently discard something the author wrote; it simply
    // gets no back-link, having nowhere to go back to.
    const html = body(doc('Body.', '', '[^lone]: Never cited.'));
    expect(html).toContain('<li id="fn-1">Never cited.');
    expect(html).not.toContain('<a class="md-fnback"');
  });

  // Swift: testFootnoteTextIsInlineMarkdownAndIsEscaped
  it('renders a note’s own text as inline Markdown, escaped', () => {
    const html = body(doc('X[^a].', '', '[^a]: *Emphasis* and <b>literal</b> & co.'));
    expect(html).toContain('<em>Emphasis</em>');
    expect(html).toContain('&lt;b&gt;literal&lt;/b&gt;');
    expect(html).toContain('&amp; co.');
  });

  // Swift: testFootnoteReferenceNestedInsideANoteBecomesLiteralText
  it('cleans a reference inside a note back to literal text', () => {
    // It has missed the numbering pass, so it is cleaned rather than left as
    // markup the reader would see. No `data-fn=` may survive into the page.
    const html = body(doc('X[^a].', '', '[^a]: see [^b] too.', '[^b]: Other.'));
    expect(html).not.toContain('data-fn=');
    expect(html).toContain('[^b]');
  });
});

// MARK: - Engine hooks (VS Code only, strictly additive)

describe('engine hooks', () => {
  const options = { title: 't', dark: false } as const;

  it('changes not one byte when every hook returns null', () => {
    // The hooks rule: a hook returning `null` must leave the container exactly
    // as the no-hook path would emit it.
    const source = doc(
      '$a+b$',
      '',
      '```swift',
      'let x = 1',
      '```',
      '',
      '```dot',
      'digraph { a }',
      '```',
      '',
      '```math',
      'E=mc^2',
      '```',
    );
    const nulls: EngineHooks = {
      math: () => null,
      highlight: () => null,
      graphviz: () => null,
    };
    expect(renderDocument(source, { ...options, engines: nulls })).toBe(
      renderDocument(source, options),
    );
  });

  it('fills the same container rather than replacing it', () => {
    // The gate must still see a maths document and the export paths must still
    // find the element they expect.
    const rendered = renderBody('$a+b$', {
      ...options,
      engines: { math: (tex, display) => `<span data-tex="${tex}" data-display="${display}"></span>` },
    });
    expect(rendered.html).toBe(
      '<p><span class="md-mathi"><span data-tex="a+b" data-display="false"></span></span></p>',
    );
    expect(rendered.needs.math).toBe(true);
  });

  it('hands KaTeX the decoded LaTeX, as md-init.js’s textContent does', () => {
    let seen = '';
    renderBody('$a < b$', {
      ...options,
      engines: {
        math: (tex) => {
          seen = tex;
          return 'X';
        },
      },
    });
    expect(seen).toBe('a < b');
  });

  it('fills all three math container shapes', () => {
    const shapes: string[] = [];
    renderBody(doc('$a$ and $$b$$', '', '```math', 'c', '```'), {
      ...options,
      engines: {
        math: (tex, display) => {
          shapes.push(`${tex}:${display}`);
          return null;
        },
      },
    });
    expect(shapes).toEqual(['a:false', 'b:true', 'c:true']);
  });

  it('passes the mapped engine name, not the author’s info word', () => {
    let engine = '';
    renderBody(doc('```gv', 'digraph { a }', '```'), {
      ...options,
      engines: {
        graphviz: (_source, name) => {
          engine = name;
          return null;
        },
      },
    });
    expect(engine).toBe('dot');
  });

  it('fills a raw .gv document through the same hook', () => {
    const rendered = renderBody('digraph G {\n}\n', {
      ...options,
      engines: { graphviz: () => '<svg></svg>' },
    });
    expect(rendered.html).toBe('<div class="graphviz" data-engine="dot"><svg></svg></div>');
  });

  it('has no hook for PlantUML or Mermaid, which cannot run in Node', () => {
    // Mermaid needs real text metrics — headless it produces a 30 998px-wide
    // broken layout — and PlantUML needs a real canvas's `measureText`. Both
    // render in the preview, so the hooks interface has three members.
    const hooks: EngineHooks = {};
    expect(Object.keys(hooks)).toHaveLength(0);
    const rendered = renderBody(doc('```plantuml', '@startuml', '```'), {
      ...options,
      engines: { math: () => 'x', highlight: () => 'x', graphviz: () => 'x' },
    });
    expect(rendered.html).toBe('<div class="plantuml">@startuml</div>');
  });
});

// MARK: - Source lines (VS Code only, strictly additive)

describe('source lines', () => {
  it('appends the class and adds data-line to a top-level block', () => {
    // VS Code's own markdown-it chain does `attrJoin("class", "code-line")`,
    // which appends. Here it is also mandatory: md-init.js and highlight.js
    // select code with `code[class^="language-"]`, so a class list that stops
    // starting with `language-` stops being highlighted.
    const html = body(doc('# H', '', 'para', '', '```js', 'x', '```'), { sourceLines: true });
    expect(html).toBe(
      '<h1 id="h" class="code-line" data-line="0">H</h1>\n' +
        '<p class="code-line" data-line="2">para</p>\n' +
        '<pre><code class="language-js code-line" data-line="4">x</code></pre>',
    );
  });

  it('decorates the <code> of a fenced block, never the <pre>', () => {
    // VS Code's `getCodeLineElements` skips every PRE and handles the CODE
    // inside it, computing an end line from the newline count so a long block
    // scrolls proportionally instead of snapping.
    expect(body(doc('```', 'x', '```'), { sourceLines: true })).toBe(
      '<pre><code class="code-line" data-line="0">x</code></pre>',
    );
  });

  it('leaves an empty block empty', () => {
    // Notes, front matter and footnote definitions have no tag to decorate.
    expect(body('<!-- note: n -->', { sourceLines: true })).toBe('');
  });

  it('never leaks into the default output', () => {
    const source = doc('# H', '', 'para');
    expect(body(source)).not.toContain('code-line');
    expect(body(source)).not.toContain('data-line');
  });
});

// MARK: - Diagram sources (VS Code only, strictly additive)

describe('diagram sources', () => {
  /** What `md-preview.ts` does with the attribute, so the round trip is real. */
  function decodeAttribute(html: string, at = 0): string {
    const marker = ' data-md-src="';
    const start = html.indexOf(marker, at);
    expect(start).toBeGreaterThanOrEqual(0);
    const from = start + marker.length;
    const encoded = html.slice(from, html.indexOf('"', from));
    return Buffer.from(encoded, 'base64').toString('utf8');
  }

  it('carries a Mermaid block source verbatim, base64-encoded', () => {
    // The arrows are the point: `-->` is escaped in the container's own text,
    // and what the client needs is the source the author wrote, not the markup.
    const source = doc('```mermaid', 'graph TD', '  A[a] --> B{b & "c"}', '```');
    const html = body(source, { diagramSources: true });
    expect(decodeAttribute(html)).toBe('graph TD\n  A[a] --> B{b & "c"}');
  });

  it('survives a non-ASCII diagram', () => {
    // `atob` is bytes, not text. Encoding UTF-16 code units instead of UTF-8
    // bytes would corrupt every one of these on the way back.
    const source = doc('```mermaid', 'graph TD', '  A[Ünicode → 日本語]', '```');
    expect(decodeAttribute(body(source, { diagramSources: true }))).toBe(
      'graph TD\n  A[Ünicode → 日本語]',
    );
  });

  it('decorates PlantUML too, and a raw .puml document', () => {
    const fenced = body(doc('```plantuml', '@startuml', 'A -> B', '@enduml', '```'), {
      diagramSources: true,
    });
    expect(decodeAttribute(fenced)).toBe('@startuml\nA -> B\n@enduml');

    // A whole file opened as a diagram takes a different path through
    // `renderBody` and returns before the Markdown one is reached.
    const raw = body('@startuml\nA -> B\n@enduml\n', { diagramSources: true });
    expect(raw).toContain('data-md-src="');
    expect(decodeAttribute(raw)).toBe('@startuml\nA -> B\n@enduml\n');
  });

  it('leaves Graphviz alone', () => {
    // Graphviz is rendered in the extension host and arrives finished; the
    // client never touches the container, so it has no source to be told.
    const html = body(doc('```dot', 'digraph { a -> b }', '```'), { diagramSources: true });
    expect(html).toContain('<div class="graphviz" data-engine="dot">');
    expect(html).not.toContain('data-md-src');
  });

  it('finds a diagram nested inside a block quote', () => {
    // `withSourceLine` only ever sees top-level blocks, so a per-block
    // decorator would miss this one entirely.
    const html = body(doc('> ```mermaid', '> graph TD', '> ```'), { diagramSources: true });
    expect(decodeAttribute(html)).toBe('graph TD');
  });

  it('decorates every block, not merely the first', () => {
    const html = body(
      doc('```mermaid', 'one', '```', '', '```mermaid', 'two', '```', '', '```plantuml', '@startuml', '@enduml', '```'),
      { diagramSources: true },
    );
    expect(html.split('data-md-src="').length - 1).toBe(3);
    expect(decodeAttribute(html)).toBe('one');
    expect(decodeAttribute(html, html.indexOf('data-md-src') + 1)).toBe('two');
  });

  it('composes with sourceLines without disturbing the engine gate', () => {
    // The gate probes the exact string `<pre class="mermaid">` on the
    // UNDECORATED markup. An attribute emitted where the container is built
    // would land inside that probe and ship a Mermaid document with no Mermaid.
    const rendered = renderBody(doc('```mermaid', 'graph TD', '```'), {
      title: 't',
      dark: false,
      sourceLines: true,
      diagramSources: true,
    });
    expect(rendered.needs.mermaid).toBe(true);
    expect(rendered.html).toContain('<pre class="mermaid code-line" data-line="0" data-md-src="');
  });

  it('encodes to an alphabet that needs no escaping', () => {
    // Base64 cannot contain a quote, an ampersand or an angle bracket, which is
    // why the value is interpolated raw — and why nothing downstream, including
    // VS Code's own `data-initial-md-content` attribute, can re-escape it.
    const html = body(doc('```mermaid', 'a --> "b" & <c>', '```'), { diagramSources: true });
    const marker = ' data-md-src="';
    const from = html.indexOf(marker) + marker.length;
    expect(html.slice(from, html.indexOf('"', from))).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
  });

  it('never leaks into the default output', () => {
    const source = doc('```mermaid', 'graph TD', '```', '', '```plantuml', '@startuml', '@enduml', '```');
    expect(body(source)).not.toContain('data-md-src');
    expect(renderDocument(source, { title: 't', dark: false })).not.toContain('data-md-src');
    // The parity bytes, unchanged by the option existing at all.
    expect(body(source, { diagramSources: false })).toBe(body(source));
  });
});

// MARK: - §26 The stylesheet

describe('stylesheet', () => {
  /** Strip comments the way a CSS parser does, not the way a grep does. */
  function stripComments(sheet: string): string {
    let out = '';
    let cursor = 0;
    for (;;) {
      const open = sheet.indexOf('/*', cursor);
      if (open < 0) {
        out += sheet.slice(cursor);
        return out;
      }
      out += sheet.slice(cursor, open);
      const close = sheet.indexOf('*/', open + 2);
      // An unterminated comment swallows everything after it — which is
      // exactly the failure this test exists to catch.
      if (close < 0) return out;
      cursor = close + 2;
    }
  }

  it('has three variants and 101 lines in each', () => {
    // `dark && !export` runs in `renderDocument` before the palette is
    // computed, so there is no fourth, never-shipped variant. The count
    // includes the genuinely blank line the empty `pre-wrap` interpolation
    // leaves behind in the preview sheets.
    for (const sheet of [css(false, false), css(true, false), css(false, true)]) {
      expect(sheet.split('\n')).toHaveLength(101);
    }
    expect(css(true, true)).toBe(css(false, true));
  });

  // Swift: testGraphvizInkRulesSurviveCSSCommentStripping
  it('keeps the Graphviz ink rules CSS after comments are stripped', () => {
    // If a comment ever closes early, the loose prose that follows becomes the
    // prelude of the next rule and the CSS parser swallows that rule whole —
    // the diagram then draws in black on the dark paper. A test that merely
    // greps the document for the rule text still passes in that state, because
    // the text is there; it just isn't CSS any more. Hence the methodology,
    // not just the strings.
    for (const dark of [false, true]) {
      const sheet = styleBlock(renderDocument(doc('```dot', 'digraph { a }', '```'), {
        title: 't',
        dark,
      }));
      expect(sheet.split('/*')).toHaveLength(sheet.split('*/').length);

      const stripped = stripComments(sheet);
      // Graphviz writes no `fill` attribute at all unless the author asked for
      // a colour, so `text:not([fill])` is the rule that matters — and the
      // first casualty of a broken comment. Do not merge the four.
      expect(stripped).toContain('.graphviz svg text:not([fill])');
      expect(stripped).toContain('.graphviz svg text[fill="black"]');
      expect(stripped).toContain('.graphviz svg [stroke="black"]');
      expect(stripped).toContain('.graphviz svg [fill="black"]:not(text)');
      expect(stripped).toContain(
        `.graphviz svg text:not([fill]) { fill: ${dark ? '#E7DBC2' : '#2B2620'}; }`,
      );
    }
  });

  // Swift: testHTMLThemeVariantsDiffer
  it('differs between the light and dark previews', () => {
    const light = renderDocument('hi', { title: 't', dark: false });
    const dark = renderDocument('hi', { title: 't', dark: true });
    expect(light).not.toBe(dark);
    expect(dark).toContain('color-scheme: dark');
    expect(dark).toContain('print-color-adjust: exact');
    expect(dark).toContain('background: #241E18');
    expect(dark).toContain('data-md-dark="1"');
  });

  // Swift: testExportPageIsPlainWhiteAndAlwaysLight
  it('forces the light palette on a plain white page for export', () => {
    // The tinted paper and cream-on-carbon ink are screen themes, not
    // something to fix into a printout — and dark cream-on-carbon is
    // unreadable as cream-on-white.
    const html = renderDocument('hi', { title: 't', dark: true, export: true });
    expect(html).toContain('background: #FFFFFF');
    expect(html).toContain('color-scheme: light');
    expect(html).not.toContain('#241E18');
    // Mermaid's theme and PlantUML's dark flag are chosen by this attribute,
    // never by CSS — so an exported document must say `0`.
    expect(html).toContain('data-md-dark="0"');
  });

  // Swift: testHTMLPageBreakMarkerAndExportCSS
  it('collapses the page-break rule to a real page boundary only in export', () => {
    const source = doc('a', '', '\\newpage', '', 'b');
    const preview = renderDocument(source, { title: 't', dark: false });
    expect(preview).toContain('md-pagebreak');
    expect(preview).not.toContain('break-after: page');

    const exported = renderDocument(source, { title: 't', dark: false, export: true });
    expect(exported).toContain('break-after: page');
    expect(exported).toContain('<div class="md-pagebreak"></div>');
  });

  it('adds the code-wrapping rule only in export', () => {
    // Paper cannot scroll a too-wide block, so a long line would be clipped at
    // the block's edge.
    expect(css(false, true)).toContain('pre { white-space: pre-wrap; overflow-wrap: anywhere; }');
    expect(css(false, false)).not.toContain('pre-wrap');
  });
});
