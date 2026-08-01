//
//  golden.test.ts
//  md.vscode — the fixture corpus, and the snapshot the apps never had.
//
//  `test/fixtures/testdata/` is a verbatim copy of `md/mdTests/TestData/`,
//  which is itself mirrored into md.macOS and md.Android;
//  `test/fixtures/examples/` is a verbatim copy of the documents the apps ship
//  in their Examples menu. Both are inputs, not outputs: edit them only to
//  match the other repos, and copy any change to all four.
//
//  WHY THE SNAPSHOTS EXIST
//  -----------------------
//  None of the three shipping apps has a full-document snapshot test. Every
//  assertion in `TestDataTests.swift` is a `contains` over one construct, so a
//  fixture can render differently in a hundred bytes nobody named and the suite
//  stays green. That is exactly how sixteen Swift-versus-Kotlin divergences
//  went unnoticed until a differential run over 3,555 documents was built to
//  look for them — the ports agreed about everything anyone had thought to
//  assert, and differed everywhere else.
//
//  So the whole rendered body of every fixture is written to
//  `test/fixtures/golden/`, and the three stylesheets with it. These files are
//  not documentation and they are not a specification: they are a tripwire. A
//  diff in one is a question — "did you mean to change that?" — and the answer
//  is usually yes. What must never happen is the change going unnoticed.
//
//  The bodies are snapshotted rather than whole documents, because the `<head>`
//  and the stylesheet are identical in all of them and are pinned once, on
//  their own, where a change to the sheet shows up as a change to the sheet
//  instead of as the same diff repeated twenty-four times.
//
//  Regenerate with `npx vitest run -u` and read every hunk.
//

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { css, renderBody, renderDocument } from '../src/render/html';
import { notes, outline, parse, parseWithLines } from '../src/render/parser';
import type { Block } from '../src/render/types';

const FIXTURES = path.join(__dirname, 'fixtures');
const GOLDEN = path.join(FIXTURES, 'golden');

/**
 * The corpus, exactly as `TestDataTests.testCorpusIsComplete` pins it.
 *
 * Written out rather than read off the disk so that a fixture *lost* in a
 * rebase fails here, which a `readdir`-driven loop could never notice.
 */
const TESTDATA = [
  'blockquotes', 'code', 'edge-cases', 'headings', 'images', 'inline', 'lists',
  'math', 'mermaid', 'notes', 'outline', 'page-breaks', 'plantuml', 'tables',
  'test', 'thematic-breaks',
];

/** The app's Examples menu, in the order it shows them. */
const EXAMPLES = [
  '01-Welcome', '02-Formatting', '03-Tables', '04-Code',
  '05-Images', '06-Math', '07-Diagrams', '08-Writer Tools',
];

function read(directory: string, name: string): string {
  return fs.readFileSync(path.join(FIXTURES, directory, `${name}.md`), 'utf8');
}

function names(directory: string): string[] {
  return fs
    .readdirSync(path.join(FIXTURES, directory))
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length))
    .sort();
}

/** Every fixture in the suite, as `[directory, name, source]`. */
const ALL: ReadonlyArray<[string, string, string]> = [
  ...TESTDATA.map((name) => ['testdata', name, read('testdata', name)] as [string, string, string]),
  ...EXAMPLES.map((name) => ['examples', name, read('examples', name)] as [string, string, string]),
];

describe('corpus', () => {
  // Swift: TestDataTests.testCorpusIsComplete
  it('holds exactly the sixteen mirrored fixtures', () => {
    expect(names('testdata')).toEqual([...TESTDATA].sort());
  });

  it('holds exactly the eight shipped examples', () => {
    // Swift asserts this against `Bundle.main`; here the tree is on disk.
    // The five-article Example Book is deliberately not copied: books are an
    // export concern and belong with the book tests, not with the renderer's.
    expect(names('examples')).toEqual([...EXAMPLES].sort());
  });

  // Swift: TestDataTests.testEveryFixtureParsesAndRenders
  it('parses and renders every fixture', () => {
    for (const [, name, source] of ALL) {
      expect(parse(source).length, `${name} parsed to no blocks`).toBeGreaterThan(0);
      expect(renderDocument(source, { title: name, dark: false }), name).toContain('<body');
    }
  });

  it('agrees with itself about where the blocks are', () => {
    // The module contract's invariant, over the whole corpus:
    //     parse(src) === parseWithLines(src).map(p => p.block)
    // It holds by construction — both are projections of one `scan()` — and it
    // is asserted anyway, because "two walks agreeing out of discipline" is the
    // exact failure mode this port exists to guard against.
    for (const [, name, source] of ALL) {
      const placed = parseWithLines(source);
      expect(placed.map((p) => p.block), name).toEqual(parse(source));
      // And every recorded line must address a real line of the source.
      const total = source.split('\n').length;
      for (const entry of placed) {
        expect(entry.line, name).toBeGreaterThanOrEqual(0);
        expect(entry.line, name).toBeLessThan(total + 1);
      }
    }
  });

  it('keeps the outline and the emitted anchor ids in step across the corpus', () => {
    // The same `used` counter walked in the same document order. If the two
    // ever disagreed about whether a line is a heading, every later anchor
    // would drift by one and a Contents link would scroll to nothing.
    for (const [, name, source] of ALL) {
      const { html } = renderBody(source, { title: name, dark: false });
      const ids = [...html.matchAll(/<h[1-6] id="([^"]*)"/g)].map((m) => m[1]);
      expect(ids, name).toEqual(outline(source).map((entry) => entry.slug));
    }
  });
});

describe('per-fixture invariants', () => {
  // Each of these exists so that a fixture edit which loses the construct the
  // file's name promises fails here, rather than silently weakening the corpus
  // that every other test in this file leans on.

  // Swift: testHeadingsFixtureCoversAllSixLevels
  it('headings.md covers all six levels', () => {
    const levels = new Set(
      parse(read('testdata', 'headings'))
        .filter((block): block is Extract<Block, { kind: 'heading' }> => block.kind === 'heading')
        .map((block) => block.level),
    );
    for (const level of [1, 2, 3, 4, 5, 6]) expect(levels).toContain(level);
  });

  // Swift: testTablesFixtureParsesTables
  it('tables.md holds exactly three tables', () => {
    // Three real ones; the delimiter-less pair of lines at the end is not one.
    expect(parse(read('testdata', 'tables')).filter((b) => b.kind === 'table')).toHaveLength(3);
  });

  // Swift: testListsFixtureCarriesOrderedAndUnordered
  it('lists.md carries both kinds of list', () => {
    const lists = parse(read('testdata', 'lists')).filter(
      (block): block is Extract<Block, { kind: 'list' }> => block.kind === 'list',
    );
    expect(lists.some((list) => list.ordered)).toBe(true);
    expect(lists.some((list) => !list.ordered)).toBe(true);
  });

  // Swift: testPageBreaksFixtureCarriesBothSpellings
  it('page-breaks.md carries both spellings', () => {
    expect(parse(read('testdata', 'page-breaks')).filter((b) => b.kind === 'pageBreak')).toHaveLength(2);
  });

  // Swift: testNotesFixtureKeepsPrivateNotesOutOfTheHTML
  it('notes.md keeps the author’s notes out of the rendered page', () => {
    const source = read('testdata', 'notes');
    // Two `note:` comments; the plain comment is not a note.
    expect(notes(source)).toHaveLength(2);
    const html = renderDocument(source, { title: 'notes', dark: false });
    expect(html).toContain('Visible prose before');
    expect(html).not.toContain('private author note');
    expect(html).not.toContain('plain comment');
  });

  // Swift: testOutlineFixtureDedupesAndSlugs
  it('outline.md dedupes its slugs and skips a fenced lookalike', () => {
    const entries = outline(read('testdata', 'outline'));
    const slugs = entries.map((entry) => entry.slug);
    expect(slugs).toContain('section');
    expect(slugs).toContain('section-1');
    expect(slugs).toContain('c--f');
    expect(entries.some((entry) => entry.text.includes('not a heading'))).toBe(false);
    expect(entries[entries.length - 1].text).toBe('Setext also counts');
  });

  // Swift: testImagesFixtureEmitsImgTags
  it('images.md emits img tags, including a linked image', () => {
    const html = renderDocument(read('testdata', 'images'), { title: 'images', dark: false });
    expect(html).toContain(
      '<img src="https://nettrash.me/favicon.ico" alt="nettrash.me favicon" title="The favicon">',
    );
    expect(html).toContain(
      '<a href="https://nettrash.me"><img src="https://nettrash.me/favicon.ico" alt="badge"></a>',
    );
  });

  // Swift: testRichFixturesEmitTheirContainers
  it('the rich fixtures emit their containers and pull their engines', () => {
    const math = renderDocument(read('testdata', 'math'), { title: 'math', dark: false });
    expect(math).toContain('class="md-mathi"');
    expect(math).toContain('class="md-mathd"');
    expect(math).toContain('katex.min.js');
    // `math.md` also holds `$99.99 is a price`, which the currency guard must
    // leave as prose.
    expect(math).toContain('$99.99');

    expect(renderDocument(read('testdata', 'mermaid'), { title: 'mermaid', dark: false })).toContain(
      '<pre class="mermaid">',
    );
    // `plantuml.md` uses the ```puml alias; only ```plantuml is unit-asserted
    // anywhere, so this is the one place the alias is pinned on a real file.
    expect(
      renderDocument(read('testdata', 'plantuml'), { title: 'plantuml', dark: false }),
    ).toContain('<div class="plantuml">');
  });
});

describe('golden output', () => {
  for (const [directory, name, source] of ALL) {
    it(`${directory}/${name}.md renders as recorded`, async () => {
      const { html } = renderBody(source, { title: name, dark: false });
      await expect(html + '\n').toMatchFileSnapshot(
        path.join(GOLDEN, directory, `${name}.html`),
      );
    });
  }

  it('needs the recorded engines', async () => {
    // One file rather than twenty-four, because the interesting diff is
    // "which document started needing KaTeX", and that is only legible as a
    // list.
    const table: Record<string, string> = {};
    for (const [directory, name, source] of ALL) {
      const { needs } = renderBody(source, { title: name, dark: false });
      table[`${directory}/${name}`] = Object.entries(needs)
        .filter(([, on]) => on)
        .map(([engine]) => engine)
        .join(' ');
    }
    await expect(JSON.stringify(table, null, 2) + '\n').toMatchFileSnapshot(
      path.join(GOLDEN, 'engine-needs.json'),
    );
  });

  it('wraps a document as recorded', async () => {
    // The skeleton, once, on the "everything" fixture: `<head>` order, the
    // `</style>` glue, `data-md-dark`, the module script last, and no trailing
    // newline. Every other golden file is a body, so this is the only place
    // those bytes are pinned on a real document.
    const html = renderDocument(read('testdata', 'test'), { title: 'test', dark: false });
    await expect(html.replace(css(false, false), '/* … see stylesheet-light.css … */')).toMatchFileSnapshot(
      path.join(GOLDEN, 'document.html'),
    );
  });

  it('styles as recorded, in all three variants', async () => {
    // There are three reachable stylesheets, not four: `dark && !export` runs
    // in `renderDocument` before the palette is computed.
    await expect(css(false, false) + '\n').toMatchFileSnapshot(
      path.join(GOLDEN, 'stylesheet-light.css'),
    );
    await expect(css(true, false) + '\n').toMatchFileSnapshot(
      path.join(GOLDEN, 'stylesheet-dark.css'),
    );
    await expect(css(false, true) + '\n').toMatchFileSnapshot(
      path.join(GOLDEN, 'stylesheet-export.css'),
    );
  });
});
