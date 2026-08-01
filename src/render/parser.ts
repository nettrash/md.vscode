//
//  parser.ts
//  md.vscode — the block grammar.
//
//  A port of `md/md/MarkdownParser.swift` (985 lines), which is the file
//  every other part of the product is built from: the live preview, the
//  HTML, the PDF, print, the EPUB, the `.tex` export, the Contents outline
//  and the notes panel. A one-line divergence here is "the same document is
//  a different document on two platforms", so the rules below are
//  reproduced exactly — including the ones that look like bugs. §11 of
//  `specs/01-parser.md` lists those; each is flagged where it lives.
//
//  This is a pragmatic subset of CommonMark plus the common GitHub
//  extensions (fenced code, task lists, tables, strikethrough). It is not a
//  conformant CommonMark implementation, and deliberately so: the goal is a
//  faithful, readable preview of everyday Markdown, not spec completeness.
//  Parsing is single-pass and line-oriented, which keeps it cheap enough to
//  re-run on every keystroke. There is no indented-code branch, no link
//  reference definition, no raw HTML block and no list-item container —
//  see §12 of the spec for the full list and the reasons.
//
//  THE CHARACTER MODEL, WHICH IS THE WHOLE ARCHITECTURE
//  ----------------------------------------------------
//  The Swift matches every delimiter scalar by scalar, through `ScalarText`
//  or a walk of `unicodeScalars`, and never with `String.hasPrefix` /
//  `contains` / `firstIndex(of:)` and never by comparing a `Character`.
//  Those match extended grapheme clusters: a combining mark, a variation
//  selector or a ZWJ written after a delimiter fuses onto it, the cluster is
//  no longer equal to the plain delimiter, and the block is silently not
//  recognised. `- ́[draft]` was a paragraph on Apple and a list on Android; a
//  fence whose ``` carried a mark was a paragraph rather than a code block;
//  the same for a table's `|`, a `[^a]:` definition, a `>` quote marker, a
//  heading's `#`, and the `-->` that ends an HTML comment — that last one
//  swallowed the rest of the document.
//
//  JavaScript strings are UTF-16 code units, which is exactly Kotlin's model
//  and the one the Android port already gets right, so the fix is free here:
//  every delimiter in this grammar is a single ASCII scalar, and no half of
//  a surrogate pair can ever equal an ASCII delimiter. Plain `indexOf` /
//  `startsWith` / `charCodeAt` is therefore scalar-exact for this file.
//
//  Two consequences to hold on to:
//    * never reach for `Intl.Segmenter`, `[...str]` in the block scanner, or
//      a `v`-flag regex doing cluster matching — that re-imports the Swift
//      bug this port exists to avoid;
//    * `slug()` is the one function that walks CODE POINTS, because astral
//      letters must survive into an anchor.
//
//  Where the Swift counts *scalars* and this file counts *code units* the
//  two could in principle disagree; every such site is proved equivalent in
//  a comment beside it rather than left to the reader's faith.
//

import type {
  Block,
  ColumnAlignment,
  HeadingLevel,
  ListItem,
  MetadataField,
  NoteEntry,
  OutlineEntry,
  PlacedBlock,
} from './types';
import {
  codePoints,
  normalizedLines,
  scalarContains,
  scalarFirstIndex,
  scalarHasPrefix,
  scalarHasSuffix,
  trimWS,
  trimWSNL,
} from './text';

// MARK: - Local primitives

const SPACE = 0x20;
const TAB = 0x09;
const HASH = 0x23;
const COLON = 0x3a;
const PIPE = 0x7c;
const GT = 0x3e;
const DASH = 0x2d;
const STAR = 0x2a;
const PLUS = 0x2b;
const UNDERSCORE = 0x5f;
const EQUALS = 0x3d;
const DOT = 0x2e;
const RPAREN = 0x29;
const BACKTICK = 0x60;
const TILDE = 0x7e;

/**
 * How many leading U+0020 SPACE characters `line` has.
 *
 * Deliberately **not** the whitespace set `trimWS` uses: the Swift spells
 * these `drop { $0 == " " }` / `prefix { $0 == " " }`, so a tab, an NBSP or
 * an EM SPACE is content, not indentation. That asymmetry is load-bearing
 * in `FenceMarker` (a tab-indented fence is not a fence) and it is why the
 * frozen `trimLeadingWS` from `text.ts` cannot stand in here.
 */
function leadingSpaceCount(line: string): number {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === SPACE) n++;
  return n;
}

/** `line.unicodeScalars.drop { $0 == " " }` — U+0020 only, unbounded. */
function dropLeadingSpaces(line: string): string {
  const n = leadingSpaceCount(line);
  return n === 0 ? line : line.slice(n);
}

/**
 * An ASCII digit — the whole of CommonMark's ordered-list marker.
 *
 * Spelled out rather than asked of a `\d` regex or `Number`: `\d` under the
 * `u` flag is `Nd`, which admits `٣`, and `Character.isNumber` on Apple also
 * admits `½` and `Ⅻ`, which `Int` cannot read back. Such a line became an
 * ordered list numbered 1 on one platform and a paragraph on the other.
 */
function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

// MARK: - Parser

/**
 * The recursion cap on block quotes.
 *
 * A line of thousands of `>` costs one recursion per marker, so without a
 * cap it overflows the stack. Past the cap we stop recursing and keep the
 * remaining text as a plain paragraph. Quote nodes are therefore emitted at
 * depths 0…32 — 33 nested levels — and the innermost holds a single
 * paragraph with the still-`>`-laden remainder. A JavaScript stack would
 * survive rather more than 33 frames; the cap stays because the *output
 * shape* is part of the parity contract.
 */
const QUOTE_DEPTH_LIMIT = 32;

/**
 * Parse Markdown source into a flat list of blocks.
 *
 * `quoteDepth` is internal: block quotes recurse, and `QUOTE_DEPTH_LIMIT`
 * bounds that recursion.
 *
 * This is a projection of `scan()`, the single walk both public entry points
 * share. The contract's invariant — `parse(src)` equals
 * `parseWithLines(src).map(p => p.block)` for every input — then holds by
 * construction rather than by two implementations agreeing out of
 * discipline, which is the failure mode the whole port is guarding against.
 */
export function parse(source: string, quoteDepth = 0): Block[] {
  return scan(source, quoteDepth).map((placed) => placed.block);
}

/**
 * The same walk as `parse`, recording the 0-based source line each
 * **top-level** block started on.
 *
 * VS Code only; the apps have no equivalent, because the built-in preview
 * syncs scrolling off `class="code-line" data-line="N"` attributes and md's
 * own preview syncs proportionally instead. Blocks nested inside a quote
 * carry no line: the recursion re-parses the *stripped* inner text, whose
 * line numbers do not address the outer document, and inventing a mapping
 * for them would be a second parser in all but name.
 */
export function parseWithLines(source: string): PlacedBlock[] {
  return scan(source, 0);
}

/**
 * The one block scanner. Everything else in this file is a predicate it
 * calls.
 *
 * The branch order below is **normative** — blank, fence, thematic break,
 * page break, footnote definition, comment, heading, table, quote, list,
 * paragraph — and the consequences are relied upon throughout the product:
 * a fence wins over everything including a thematic break, so `- - -` and
 * `***` and `___` are always rules and never list items; a footnote
 * definition wins over a heading, a table, a quote and a list; a `<!--` line
 * wins over a heading; the table branch is the only one with lookahead; and
 * a setext heading is recognised **only** inside the paragraph branch.
 */
function scan(source: string, quoteDepth: number): PlacedBlock[] {
  // Normalise line endings, then work on a line array with an index cursor.
  // Lines keep their content but never their terminator.
  const lines = normalizedLines(source);
  const blocks: PlacedBlock[] = [];
  let i = 0;

  // Front matter: a metadata block fenced off at the very top of the file,
  // the convention every static-site generator and note-taker uses (Jekyll,
  // Hugo, Obsidian, Quarto). Without this the opening `---` reads as a
  // thematic break and the metadata as stray prose, which is how such a file
  // used to look here. It is only front matter at the very start of the
  // document and never inside a quote.
  if (quoteDepth === 0) {
    const matter = parseFrontMatter(lines);
    if (matter !== null) {
      blocks.push({ block: { kind: 'frontMatter', fields: matter.fields }, line: 0 });
      i = matter.next;
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    // The 0-based line this block begins on — the only thing
    // `parseWithLines` adds to the walk. Captured before any branch moves
    // the cursor, because the paragraph branch reads it after its own loop.
    const start = i;

    // Blank line — paragraph / block separator, nothing to emit.
    if (trimWS(line) === '') {
      i++;
      continue;
    }

    // Fenced code block: ``` or ~~~ (optionally indented, with an optional
    // info string / language on the opening fence).
    const fence = FenceMarker.from(line);
    if (fence !== null) {
      const code: string[] = [];
      i++;
      while (i < lines.length) {
        if (fence.closes(lines[i])) {
          i++;
          break;
        }
        // Strip the fence's own indentation from body lines so an indented
        // fence doesn't carry phantom leading spaces.
        code.push(fence.stripIndent(lines[i]));
        i++;
      }
      // An unclosed fence consumes to EOF — and because `normalizedLines`
      // always appends a final element, an unclosed fence in a source that
      // ends with a newline picks up that trailing `""` and so gains a
      // trailing `\n` in `code`. Wart, verified, replicated; a closed fence
      // is unaffected.
      blocks.push({
        block: { kind: 'codeBlock', language: fence.language, code: code.join('\n') },
        line: start,
      });
      continue;
    }

    // Thematic break: a line of 3+ -, * or _ (spaces allowed).
    if (isThematicBreak(line)) {
      blocks.push({ block: { kind: 'thematicBreak' }, line: start });
      i++;
      continue;
    }

    // Page break: a line of exactly `\newpage` (or `\pagebreak`), the Pandoc
    // convention — where the author says a page ends. Shown as a subtle
    // divider in the preview; starts a new page in print and in the shared /
    // exported PDF.
    if (isPageBreak(line)) {
      blocks.push({ block: { kind: 'pageBreak' }, line: start });
      i++;
      continue;
    }

    // Footnote definition: `[^id]: the note`, the GitHub / Pandoc
    // convention. Collected here so it never renders where it was written —
    // the renderer gathers the definitions and prints them together at the
    // foot of the document. Soft-wrapped continuation lines are absorbed the
    // way a list item's are.
    const definition = parseFootnoteDefinition(line);
    if (definition !== null) {
      let text = definition.text;
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (trimWS(l) === '') break;
        // This break set has the footnote check (so consecutive definitions
        // separate) but **no table lookahead** — deliberately asymmetric
        // with the list-item loop, which has the lookahead and not the
        // footnote check, and with the paragraph loop, which has neither.
        // The three sets are not unified on purpose; see §11.
        if (
          parseFootnoteDefinition(l) !== null ||
          FenceMarker.from(l) !== null ||
          isThematicBreak(l) ||
          parseHeading(l) !== null ||
          isQuote(l) ||
          isPageBreak(l) ||
          isCommentStart(l) ||
          listMarker(l) !== null
        ) {
          break;
        }
        text += ' ' + trimWS(l);
        i++;
      }
      blocks.push({
        block: { kind: 'footnoteDefinition', id: definition.id, text },
        line: start,
      });
      continue;
    }

    // HTML comment block: `<!-- … -->`, possibly spanning lines. A
    // `<!-- note: … -->` comment is the author's private note — kept as a
    // block so the notes panel can list it. Any other comment is simply
    // dropped. Neither appears in the preview, the PDF, print or the EPUB.
    if (isCommentStart(line)) {
      const raw: string[] = [];
      while (i < lines.length) {
        raw.push(lines[i]);
        const closed = scalarContains(lines[i], '-->');
        i++;
        if (closed) break;
      }
      // The whole closing line is consumed, so anything written after `-->`
      // is discarded: `<!-- c --> visible text` loses the text. Known wart.
      const note = noteText(raw.join('\n'));
      if (note !== null) {
        blocks.push({ block: { kind: 'note', text: note }, line: start });
      }
      continue;
    }

    // ATX heading: 1–6 leading #, a space, then the text.
    const heading = parseHeading(line);
    if (heading !== null) {
      blocks.push({
        block: { kind: 'heading', level: heading.level, text: heading.text },
        line: start,
      });
      i++;
      continue;
    }

    // GFM table: the current line is a header row and the next line is the
    // delimiter row (|---|:--:|). Requires the lookahead match, which is why
    // this is the only branch that reads `lines[i + 1]`.
    if (i + 1 < lines.length) {
      const table = parseTable(line, lines[i + 1]);
      if (table !== null) {
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && scalarContains(lines[i], '|') && trimWS(lines[i]) !== '') {
          rows.push(splitTableRow(lines[i], table.header.length));
          i++;
        }
        blocks.push({
          block: {
            kind: 'table',
            header: table.header,
            alignments: table.alignments,
            rows,
          },
          line: start,
        });
        continue;
      }
    }

    // Block quote: collect the run of `>`-prefixed lines, strip one level of
    // marker, and parse the inner content recursively. There is no lazy
    // continuation — a non-`>` line ends the run — and a blank line ends it
    // too, so `"> a\n\n> b"` is two quote blocks rather than one.
    if (isQuote(line)) {
      const inner: string[] = [];
      while (i < lines.length && isQuote(lines[i])) {
        inner.push(stripQuoteMarker(lines[i]));
        i++;
      }
      const innerText = inner.join('\n');
      const innerBlocks: Block[] =
        quoteDepth < QUOTE_DEPTH_LIMIT
          ? parse(innerText, quoteDepth + 1)
          : [{ kind: 'paragraph', text: innerText }];
      blocks.push({ block: { kind: 'quote', blocks: innerBlocks }, line: start });
      continue;
    }

    // List: collect the run of consecutive list-item lines. Each item
    // absorbs its lazy / indented continuation lines (a wrapped item like
    // "- long line\n  rest") so the list isn't torn into separate paragraphs
    // and split lists.
    if (listMarker(line) !== null) {
      const items: ListItem[] = [];
      let ordered = false;
      for (;;) {
        if (i >= lines.length) break;
        const marker = listMarker(lines[i]);
        if (marker === null) break;
        // One flag for the whole run: any ordered item makes the entire list
        // ordered, and the bullet items inside it fall back to `&bull;`.
        ordered = ordered || marker.ordinal !== null;
        let text = marker.text;
        i++;
        // Pull in following non-blank lines that don't start a new block —
        // they're soft-wrapped continuation of this item.
        while (i < lines.length) {
          const l = lines[i];
          if (trimWS(l) === '') break;
          if (
            listMarker(l) !== null ||
            FenceMarker.from(l) !== null ||
            isThematicBreak(l) ||
            parseHeading(l) !== null ||
            isQuote(l) ||
            isPageBreak(l) ||
            isCommentStart(l)
          ) {
            break;
          }
          // This loop *does* carry the table lookahead — so the same three
          // lines that stay one paragraph after `Intro` do break out into a
          // table after `- item`. A footnote definition, by contrast, is
          // absent from this set, so `- item\n[^a]: note` absorbs the
          // definition into the item's text. Both asymmetries are real.
          if (i + 1 < lines.length && parseTable(l, lines[i + 1]) !== null) break;
          text += ' ' + trimWS(l);
          i++;
        }
        items.push({
          text,
          level: marker.level,
          ordinal: marker.ordinal,
          task: marker.task,
        });
      }
      blocks.push({ block: { kind: 'list', ordered, items }, line: start });
      continue;
    }

    // Otherwise: a paragraph — gather following lines until a blank line or
    // the start of another block, preserving line breaks.
    //
    // Termination rests on an invariant worth stating: every predicate in
    // the break set below was already tested by the branches above, and the
    // setext test cannot fire on the first pass (the buffer is empty), so
    // the first line is always appended and the cursor always advances. If
    // that ever stopped being true this loop would spin forever on it.
    const paragraph: string[] = [];
    let emittedHeading = false;
    while (i < lines.length) {
      const l = lines[i];
      if (trimWS(l) === '') break;
      // Setext heading: a single buffered line underlined by `===` (h1) or
      // `---` (h2). Checked before the thematic-break / list branches so
      // `Title\n---` is a heading, not a rule — and it emits exactly one
      // block, never a heading plus a rule. The one-line rule is not a
      // simplification: `outline()` applies the same `plainRun == 1` test,
      // and if the two disagreed about whether a line is a heading, every
      // later anchor would drift and the table of contents would scroll to
      // nothing.
      if (paragraph.length === 1) {
        const level = setextUnderline(l);
        if (level !== null) {
          blocks.push({
            block: { kind: 'heading', level, text: trimWS(paragraph[0]) },
            line: start,
          });
          i++;
          emittedHeading = true;
          break;
        }
      }
      // No table lookahead and no footnote check here: a table cannot
      // interrupt a paragraph, and neither can a footnote definition. See
      // §11 — both are reachable, both are shipped, neither is fixed here.
      if (
        FenceMarker.from(l) !== null ||
        isThematicBreak(l) ||
        parseHeading(l) !== null ||
        isQuote(l) ||
        listMarker(l) !== null ||
        isPageBreak(l) ||
        isCommentStart(l)
      ) {
        break;
      }
      // Appended RAW. Leading and trailing whitespace on each line survives
      // into the paragraph's text, and soft breaks are preserved as "\n";
      // only a setext heading's text is trimmed. The renderer turns those
      // newlines into `<br>` inside the inline pass, before protected
      // math / code spans are restored, so a multi-line display-math span
      // keeps its own internal newlines instead of getting `<br>`s injected.
      paragraph.push(l);
      i++;
    }
    if (!emittedHeading && paragraph.length > 0) {
      blocks.push({ block: { kind: 'paragraph', text: paragraph.join('\n') }, line: start });
    }
  }

  return blocks;
}

// MARK: - Front matter

/** The result of a successful front-matter scan: the fields, and the line to resume at. */
interface FrontMatterScan {
  fields: MetadataField[];
  /** `close + 1` — the Swift assigns this to its `inout` cursor. */
  next: number;
}

/**
 * Parse a front-matter block if `lines` opens with one. Returns `null` —
 * leaving the caller's cursor alone — for every other document, including
 * one that merely starts with a thematic break.
 *
 * The opening fence must be the very first line: `---` for YAML (closed by
 * `---` or `...`) or `+++` for TOML (closed by `+++`).
 *
 * Three things must all hold, because the opening fence of YAML front matter
 * is spelled exactly like a thematic break and getting this wrong *hides the
 * reader's prose*: the fence must be closed; the line straight after it must
 * not be blank (no generator writes front matter that way, but a document
 * opening with a rule and a blank line is commonplace); and the block must
 * hold at least one recognisable field. A document that opens with a
 * horizontal rule, says something, and rules off again therefore keeps every
 * word of it — as does `---` followed by a setext heading's text, which
 * stays a break and a heading the way it reads everywhere else.
 *
 * Each guard is separately load-bearing and separately tested. The blank
 * guard in particular is isolated by exactly one input
 * (`---\n\ntitle: A\n---\n\nbody`); delete it and the suite stays green.
 *
 * Values are read with a deliberately flat `key: value` (or `key = value`)
 * scan rather than a YAML/TOML parser: the app has no room for one, and
 * nothing here needs nesting. Anything the scan doesn't recognise — a list,
 * a nested mapping, a comment — is skipped, and the block is still consumed
 * whole, which is the part that matters for how the document looks. Quotes
 * around a value are stripped, since every generator writes some.
 */
function parseFrontMatter(lines: string[]): FrontMatterScan | null {
  if (lines.length === 0) return null;
  const opener = trimWS(lines[0]);

  let closers: readonly string[];
  // A single scalar, not a `Character`: `key:\u{0301} value` is a colon
  // fused with a mark, which no `Character` search for ":" can find — the
  // field, and with it the author's metadata, was dropped on Apple and kept
  // on Android.
  let separator: string;
  // `===` against ASCII-only literals (here and in `closers`) is exactly
  // Swift's `==`, which is canonical equivalence rather than grapheme
  // matching: no string carrying a mark is ever canonically equal to `---`.
  // Do not insert a `.normalize()` — that would make lookalikes match and
  // would diverge from Android.
  if (opener === '---') {
    closers = ['---', '...'];
    separator = ':';
  } else if (opener === '+++') {
    closers = ['+++'];
    separator = '=';
  } else {
    return null;
  }

  // Nothing is committed to until all three guards pass. A blank line
  // straight after the opener means this is a rule with prose under it.
  if (!(lines.length > 1 && trimWS(lines[1]) !== '')) return null;

  let close = -1;
  for (let index = 1; index < lines.length; index++) {
    // The closer is compared after `trimWS`, so `---\u{00A0}` still closes
    // the block. That is a pinned parity test: the NBSP made this metadata
    // on Apple and an ordinary paragraph on Android before the two
    // whitespace sets were aligned.
    if (closers.includes(trimWS(lines[index]))) {
      close = index;
      break;
    }
  }
  if (close < 0) return null;

  const fields: MetadataField[] = [];
  for (let index = 1; index < close; index++) {
    const trimmed = trimWS(lines[index]);
    // Skip comments, list items, and anything with no separator — including
    // a nested mapping's indented children, whose parent key was already
    // recorded with an empty value.
    if (trimmed === '' || scalarHasPrefix(trimmed, '#') || scalarHasPrefix(trimmed, '-')) continue;
    const split = scalarFirstIndex(trimmed, separator);
    if (split === null) continue;
    const key = trimWS(trimmed.slice(0, split));
    if (key === '') continue;
    let value = trimWS(trimmed.slice(split + 1));
    // Quote stripping, `"` before `'`, first match wins.
    //
    // The Swift requires two *scalars* before it strips, because a value of
    // two graphemes can be three scalars and dropping the first grapheme
    // would take the mark off the character behind the opening quote with
    // it. Counting UTF-16 units here is equivalent: the only strings whose
    // unit count reaches 2 while their scalar count does not are single
    // astral characters, and an astral character is neither `"` nor `'`, so
    // the prefix test rejects them either way.
    for (const quote of ['"', "'"]) {
      if (value.length >= 2 && scalarHasPrefix(value, quote) && scalarHasSuffix(value, quote)) {
        value = value.slice(1, -1);
        break;
      }
    }
    // Duplicates preserved, order preserved: this is a record of what the
    // author wrote, not a dictionary. Consumers take the first occurrence.
    fields.push({ key, value });
  }
  // No field at all means this was never metadata — most likely a thematic
  // break with prose beneath it, or a setext heading. Leave the cursor where
  // it was and let the ordinary block parser have the lines.
  if (fields.length === 0) return null;
  return { fields, next: close + 1 };
}

/**
 * The front matter of `source`, for anything that needs to know the author
 * or the title rather than just render the text.
 *
 * Runs a full `parse` and reads the fields off the first `frontMatter`
 * block, exactly as the Swift does. That is wasteful — the same lines are
 * scanned twice — and it is kept because it makes the accessor and the
 * document structurally incapable of disagreeing about what the metadata is.
 *
 * DIVERGENCE FROM THE APPS, deliberate and mandated by the module contract:
 * `MarkdownParser.frontMatter(of:)` returns an empty array for a document
 * with no front matter; the contract types this `MetadataField[] | null`, so
 * absence is `null` here. The distinction costs nothing — the three guards
 * make an empty field list unrepresentable, so `[]` was never a value the
 * Swift could return for a document that *had* front matter — but callers
 * porting Swift call sites want `frontMatter(src) ?? []`.
 */
export function frontMatter(source: string): MetadataField[] | null {
  for (const block of parse(source)) {
    if (block.kind === 'frontMatter') return block.fields;
  }
  return null;
}

// MARK: - Footnote definitions

/**
 * A footnote definition line — `[^id]: the note` — or `null`.
 *
 * Identifiers are **ASCII** letters, digits, `-` and `_`. That is narrower
 * than Pandoc allows, and deliberately so twice over: the identifier travels
 * through the HTML renderer's escaping pass and into an `id` attribute, and
 * a character set with nothing to escape cannot come out the other side
 * spelled differently from the definition it has to match — and it is the
 * same set the renderer's *reference* pattern accepts, so a definition can
 * never be written that no reference is able to name. (Allowing any Unicode
 * letter here would do exactly that: the note would be parsed, found
 * unreferenced, and printed on its own at the foot of the page, which is a
 * puzzling thing to hand an author.)
 *
 * Exported beyond the six names of the module contract because the Swift
 * declares it `static` — that is, visible to `mdTests` — and the regression
 * corpus asserts on it directly (`\u{00A0}[^a]: note` parses; `[^café]:`,
 * `[^two words]:`, `[a]: not a footnote` do not).
 */
export function parseFootnoteDefinition(line: string): { id: string; text: string } | null {
  const trimmed = trimWS(line);
  if (!scalarHasPrefix(trimmed, '[^')) return null;
  const afterMarker = trimmed.slice(2);
  const close = scalarFirstIndex(afterMarker, ']');
  if (close === null) return null;
  const id = afterMarker.slice(0, close);
  const afterClose = afterMarker.slice(close + 1);
  if (id.length === 0) return null;
  if (!isFootnoteIdentifierRun(id)) return null;
  // The colon must immediately follow `]`.
  if (afterClose.charCodeAt(0) !== COLON) return null;
  return { id, text: trimWS(afterClose.slice(1)) };
}

/**
 * Whether every unit of `id` may stand in a footnote identifier: an ASCII
 * letter, an ASCII digit, `-` or `_`.
 *
 * Spelled out rather than asked of a regex or of `Character`, which would
 * answer for a whole grapheme cluster. Walking UTF-16 units is safe: a
 * surrogate half is not ASCII, so an astral character is rejected here
 * exactly as it is by the Swift's scalar walk.
 */
function isFootnoteIdentifierRun(id: string): boolean {
  for (let k = 0; k < id.length; k++) {
    const c = id.charCodeAt(k);
    const ok =
      (c >= 0x41 && c <= 0x5a) || // A–Z
      (c >= 0x61 && c <= 0x7a) || // a–z
      isAsciiDigit(c) ||
      c === DASH ||
      c === UNDERSCORE;
    if (!ok) return false;
  }
  return true;
}

// MARK: - Headings

/**
 * An ATX heading — 1–6 leading `#`, then a space or the end of the line.
 *
 * Scalars throughout: `# \u{0301}Heading` is a heading whose marker space
 * carries a mark, and to a `Character` walk that space is not a space — the
 * heading was a paragraph on Apple and a heading on Android, and the outline
 * lost the entry with it.
 *
 * Leading indentation is **unbounded**, unlike CommonMark's three-space cap
 * — and unlike an opening fence, which is capped at three. That asymmetry is
 * real; §11 records it rather than fixing it.
 */
function parseHeading(line: string): { level: HeadingLevel; text: string } | null {
  const rest = dropLeadingSpaces(line);
  if (rest.charCodeAt(0) !== HASH) return null;
  let level = 0;
  // The `level < 7` bound plus the 1…6 range guard is what makes
  // `####### too deep` a paragraph: the loop stops counting at seven, `rest`
  // still begins with `#`, and the guard rejects. Eight or more behaves the
  // same way for the same reason.
  while (level < 7 && rest.charCodeAt(level) === HASH) level++;
  if (level < 1 || level > 6) return null;
  const after = rest.slice(level);
  // A valid ATX heading needs a space (or the end of the line) after the #s.
  // A TAB does not count, so `#\tTitle` is a paragraph.
  if (!(after.length === 0 || after.charCodeAt(0) === SPACE)) return null;
  const text = trimWS(after);
  return { level: level as HeadingLevel, text: stripClosingHashes(text) };
}

/**
 * Remove a *closing* ATX `#` run (`## Title ##` → `Title`) but only when it
 * is preceded by whitespace, per CommonMark — so a trailing `#` that is part
 * of the title (`C#`, `F#`) is preserved.
 */
function stripClosingHashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === HASH) end--;
  if (end === text.length) return text; // no trailing # run
  if (end === 0) return ''; // all #s → empty heading
  const before = text.charCodeAt(end - 1);
  if (before !== SPACE && before !== TAB) return text; // e.g. "C#"
  return trimWS(text.slice(0, end));
}

/**
 * A setext underline: a non-empty line of only `=` (level 1) or only `-`
 * (level 2), ignoring surrounding whitespace.
 *
 * Recognised **only** inside the paragraph branch, and only when exactly one
 * line is buffered. A single `-` or `=` is a valid underline (`Title\n-` is
 * an H2), and so is `--`, which is too short to be a thematic break. `- - -`
 * is not: the interior spaces survive `trimWS` and fail the all-same test.
 */
function setextUnderline(line: string): 1 | 2 | null {
  const t = trimWS(line);
  if (t === '') return null;
  let allEquals = true;
  let allDashes = true;
  for (let k = 0; k < t.length; k++) {
    const c = t.charCodeAt(k);
    if (c !== EQUALS) allEquals = false;
    if (c !== DASH) allDashes = false;
  }
  if (allEquals) return 1;
  if (allDashes) return 2;
  return null;
}

// MARK: - Page breaks & comments

/**
 * A page break: a line whose only content is `\newpage` or `\pagebreak`
 * (the Pandoc / LaTeX conventions).
 *
 * `===` against an ASCII-only literal is Swift's canonical equivalence and
 * needs no scalar form: `\newpage` with a mark on its `e` is not canonically
 * equal to `\newpage`, and is not a page break on either platform.
 */
function isPageBreak(line: string): boolean {
  const t = trimWS(line);
  return t === '\\newpage' || t === '\\pagebreak';
}

/**
 * A line that opens an HTML comment block. Only U+0020 is dropped, and
 * unboundedly — a tab before `<!--` disqualifies the line.
 */
function isCommentStart(line: string): boolean {
  return scalarHasPrefix(dropLeadingSpaces(line), '<!--');
}

/**
 * `<!-- note: … -->` → the note's text; any other comment → `null`.
 *
 * `close` is searched **from index 0, not from `open`**. If a `-->` appears
 * before the `<!--` — possible once a preceding line fragment has been
 * joined in — then `close < open`, the guard fails, and the whole comment is
 * dropped. Wart; replicated.
 */
function noteText(comment: string): string | null {
  const open = scalarFirstIndex(comment, '<!--');
  if (open === null) return null;
  const close = scalarFirstIndex(comment, '-->') ?? comment.length;
  if (!(open + 4 <= close)) return null;
  // The only place in the parser that trims newlines as well as spaces: the
  // body of a multi-line comment arrives with the "\n" its raw lines were
  // joined with, and U+0085 counts as whitespace here while it is *not* a
  // blank line anywhere else.
  const body = trimWSNL(comment.slice(open + 4, close));
  // The prefix is tested on the lowercased copy but the five units are
  // dropped from the original, as on Android: five scalars, since `note:` is
  // five scalars and no lowercase mapping produces any of them from fewer.
  // So `<!-- NOTE: x -->` and `<!-- Note: x -->` are both notes.
  if (!scalarHasPrefix(body.toLowerCase(), 'note:')) return null;
  return trimWSNL(body.slice(5));
}

// MARK: - Outline, notes & anchors

/**
 * The document's table of contents: every ATX / setext heading outside a
 * code fence, with the source line and the same anchor slug the HTML
 * renderer assigns. Line-oriented like `parse`, so it stays cheap enough to
 * recompute whenever the outline is shown.
 *
 * `line` is 0-based and points at the heading line for ATX and at the
 * **text** line — not the underline — for setext.
 *
 * The critical invariant: the same `used` map, walked in the same document
 * order, must be shared by this function and by the renderer's heading-id
 * assignment. If the two disagree about whether a given line is a heading,
 * every subsequent anchor drifts and the table of contents scrolls to
 * nothing. That is why front matter is skipped here and why a footnote
 * definition does not count as plain text.
 */
export function outline(source: string): OutlineEntry[] {
  const lines = normalizedLines(source);
  const entries: OutlineEntry[] = [];
  const used = new Map<string, number>();
  let fence: FenceMarker | null = null;
  let previousPlain: { text: string; line: number } | null = null;
  // How many plain lines ran up to `previousPlain`. `parse` only treats an
  // underline as setext when the buffered paragraph has exactly ONE line;
  // the outline must apply the same rule, or it would list headings the
  // rendered document doesn't have (and their phantom slugs would shift
  // every later anchor).
  let plainRun = 0;
  let i = 0;
  // Skip the front matter, exactly as `parse` does. Its closing `---` would
  // otherwise underline the last metadata line into a phantom setext
  // heading — one the rendered document does not contain, whose slug would
  // then push every real heading's anchor out of step with the ids the
  // renderer assigns, so the outline would scroll to nothing.
  const matter = parseFrontMatter(lines);
  if (matter !== null) i = matter.next;

  while (i < lines.length) {
    const line = lines[i];

    if (fence !== null) {
      if (fence.closes(line)) fence = null;
      previousPlain = null;
      plainRun = 0;
      i++;
      continue;
    }

    const open = FenceMarker.from(line);
    if (open !== null) {
      fence = open;
      previousPlain = null;
      plainRun = 0;
      i++;
      continue;
    }

    if (isCommentStart(line)) {
      // Deliberately a different shape from `parse`'s comment loop — it
      // advances *while* the line does not contain `-->` and then increments
      // once more. The net effect on the cursor is the same, including for
      // an unclosed comment, where this ends with `i === lines.length + 1`.
      while (i < lines.length && !scalarContains(lines[i], '-->')) i++;
      previousPlain = null;
      plainRun = 0;
      i++;
      continue;
    }

    const heading = parseHeading(line);
    if (heading !== null) {
      entries.push({
        level: heading.level,
        text: heading.text,
        slug: slug(heading.text, used),
        line: i,
      });
      previousPlain = null;
      plainRun = 0;
      i++;
      continue;
    }

    // Setext heading: exactly one plain buffered line underlined by
    // === / --- (a longer run is a paragraph; `parse` then reads the
    // underline as a rule or as plain text, and so must we).
    if (previousPlain !== null && plainRun === 1) {
      const level = setextUnderline(line);
      if (level !== null) {
        entries.push({
          level,
          text: previousPlain.text,
          slug: slug(previousPlain.text, used),
          line: previousPlain.line,
        });
        previousPlain = null;
        plainRun = 0;
        i++;
        continue;
      }
    }

    const trimmed = trimWS(line);
    // A footnote definition is not plain text either: `parse` claims the
    // line, so an underline beneath it is a rule and not a setext heading.
    // Counting it as plain would list a heading the rendered document has
    // not got, and its slug would drag every later anchor out of step — the
    // same failure front matter had.
    //
    // A table header row and a list-item continuation line, by contrast, are
    // *not* excluded, so `"| a |\n---"` and `"- item\ncontinuation\n---"`
    // each inject a phantom entry here that `parse` does not produce. Two
    // reachable divergences, both shipped; §11 flags them rather than
    // silently fixing them.
    const isPlain =
      trimmed !== '' &&
      !isThematicBreak(line) &&
      !isQuote(line) &&
      listMarker(line) === null &&
      !isPageBreak(line) &&
      parseFootnoteDefinition(line) === null;
    plainRun = isPlain ? plainRun + 1 : 0;
    previousPlain = isPlain ? { text: trimmed, line: i } : null;
    i++;
  }
  return entries;
}

/**
 * Every private author note in the document, with its 0-based source line.
 *
 * Fences are tracked so a `<!-- note: … -->` written inside a code block is
 * not listed, and the front matter is skipped as `parse` and `outline` skip
 * it — a comment inside the metadata block is not part of the document, so
 * listing it would send the notes panel to a line the preview never renders.
 */
export function notes(source: string): NoteEntry[] {
  const lines = normalizedLines(source);
  const entries: NoteEntry[] = [];
  let fence: FenceMarker | null = null;
  let i = 0;
  const matter = parseFrontMatter(lines);
  if (matter !== null) i = matter.next;

  while (i < lines.length) {
    const line = lines[i];

    if (fence !== null) {
      if (fence.closes(line)) fence = null;
      i++;
      continue;
    }

    const open = FenceMarker.from(line);
    if (open !== null) {
      fence = open;
      i++;
      continue;
    }

    if (isCommentStart(line)) {
      const start = i;
      const raw: string[] = [];
      while (i < lines.length) {
        raw.push(lines[i]);
        const closed = scalarContains(lines[i], '-->');
        i++;
        if (closed) break;
      }
      const note = noteText(raw.join('\n'));
      if (note !== null) entries.push({ text: note, line: start });
      continue;
    }

    i++;
  }
  return entries;
}

/**
 * Which code points survive into an anchor slug.
 *
 * The Swift asks four Unicode properties: `isAlphabetic`, `numericType !=
 * nil`, the three mark categories, and the literal `_` / `-`. The mapping:
 *
 *   * `\p{Alphabetic}` is exactly `properties.isAlphabetic` — note it is
 *     *not* `\p{L}`, which would drop `Other_Alphabetic` characters;
 *   * `\p{Nd}\p{Nl}\p{No}` stands in for `numericType != nil`. The only
 *     characters with a numeric type outside those three categories are the
 *     CJK numeral ideographs (一, 十, 百, …), which are `Lo` and therefore
 *     already matched by `\p{Alphabetic}`, so the union is exact;
 *   * `\p{Mn}\p{Mc}\p{Me}` is exact.
 */
const SLUG_KEPT = /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}\p{Mn}\p{Mc}\p{Me}_-]/u;

/**
 * GitHub-style anchor slug for a heading, unique within one document via the
 * caller-maintained `used` counts ("title", "title-1", …).
 *
 * Keeps letters, digits, `_` and `-`; **U+0020 only** becomes a hyphen; all
 * other punctuation — including inline-markup characters, and including a
 * tab, an NBSP or an EM SPACE, which are dropped rather than converted — is
 * dropped. That is the same rule GitHub applies, so links written for GitHub
 * keep working. An empty result becomes `"section"`.
 *
 * Walks **code points** and keeps combining marks, which is what a
 * `Character` walk did by accident and Android's code-point walk does on
 * purpose: an NFD `café` keeps its accent because the mark rode along inside
 * the letter's grapheme. Where the two parted company was a mark on a
 * character the slug does not keep letter-wise — `-`, `_` or a space.
 * `"a -\u{0301}b"` dropped the hyphen *and* the mark on Apple (the cluster
 * equals neither `-` nor `" "`) and kept both on Android, so the same
 * heading had two different anchors and a link written on one platform
 * scrolled to nothing on the other. This is one of exactly two places in the
 * port that must not walk UTF-16 units: a surrogate half is neither a letter
 * nor a mark, and an astral letter would be dropped.
 *
 * The whole string is lowercased first and *then* iterated — not lowercased
 * per character — because the two differ for characters whose lowercase
 * mapping expands (U+0130 İ → i + U+0307 in both Swift and JavaScript).
 */
export function slug(text: string, used: Map<string, number>): string {
  let base = '';
  for (const cp of codePoints(text.toLowerCase())) {
    const ch = String.fromCodePoint(cp);
    if (SLUG_KEPT.test(ch)) base += ch;
    else if (cp === SPACE) base += '-';
    // Everything else is dropped.
  }
  let value = base;
  if (value === '') value = 'section';
  // `used` counts the *bare* slug. The first occurrence returns it unsuffixed
  // and the n-th returns `slug-(n-1)`.
  //
  // This can produce duplicate ids, and does so on GitHub too: headings
  // `Same`, `Same 1`, `Same` yield `same`, `same-1`, `same-1`, because the
  // counter for `same` was bumped to 1 by the first heading and the third
  // emits the id the second already took. Replicated, not fixed.
  const seen = used.get(value) ?? 0;
  used.set(value, seen + 1);
  return seen === 0 ? value : `${value}-${seen}`;
}

// MARK: - Thematic break

/**
 * A thematic break: three or more of `-`, `*` or `_`, all the same, with
 * spaces and tabs allowed anywhere between them.
 *
 * The filter is **only** U+0020 and U+0009 — narrower than every other
 * predicate in this file, which use the full Zs-based set. So
 * `"\u{00A0}---"` is *not* a rule (the NBSP survives the filter and fails
 * the all-same test) even though `trimWS` would have removed it. The
 * asymmetry is real and shipped.
 *
 * Counting UTF-16 units rather than scalars cannot change the answer: the
 * counts differ only when an astral character is present, and an astral
 * character is not `-`, `*` or `_`, so the all-same test already fails.
 */
function isThematicBreak(line: string): boolean {
  let count = 0;
  let allDashes = true;
  let allStars = true;
  let allUnderscores = true;
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c === SPACE || c === TAB) continue;
    count++;
    if (c !== DASH) allDashes = false;
    if (c !== STAR) allStars = false;
    if (c !== UNDERSCORE) allUnderscores = false;
  }
  if (count < 3) return false;
  return allDashes || allStars || allUnderscores;
}

// MARK: - Block quote

/** A quote line: any number of leading spaces, then `>`. */
function isQuote(line: string): boolean {
  return dropLeadingSpaces(line).charCodeAt(0) === GT;
}

/** Strip one `>` and **exactly one** optional space after it. */
function stripQuoteMarker(line: string): string {
  let s = dropLeadingSpaces(line);
  if (s.charCodeAt(0) === GT) s = s.slice(1);
  if (s.charCodeAt(0) === SPACE) s = s.slice(1);
  return s;
}

// MARK: - Lists

/**
 * Recognise an unordered (`-`, `*`, `+`) or ordered (`1.`, `1)`) list item,
 * returning its indentation level, ordinal, text and task state.
 *
 * The result has exactly the shape of a `ListItem`; the assembly loop
 * rewrites `text` as it absorbs continuation lines.
 *
 * Leading whitespace determines nesting depth (2 columns ≈ one level),
 * counting a tab as advancing to the next 4-column stop so tab-indented
 * items from externally-authored files are recognised. That is the mirror
 * image of `FenceMarker`, which counts spaces only — the asymmetry is real.
 *
 * Scalars, not `Character`s, and this is the demonstrated one:
 * `- \u{0301}[draft]` — a mark on the space after the bullet — was a
 * paragraph on Apple and a list on Android, because the cluster "space plus
 * mark" is not a space. Every comparison below is against a single ASCII
 * scalar for the same reason.
 */
function listMarker(line: string): ListItem | null {
  let indent = 0;
  let start = 0;
  while (start < line.length) {
    const c = line.charCodeAt(start);
    if (c === SPACE) indent += 1;
    else if (c === TAB) indent += 4 - (indent % 4);
    else break;
    start++;
  }
  const body = line.slice(start);
  if (body.length === 0) return null;

  const first = body.charCodeAt(0);
  let ordinal: number | null = null;
  let rest: string;

  if (first === DASH || first === STAR || first === PLUS) {
    rest = body.slice(1);
  } else if (isAsciiDigit(first)) {
    // Up to 9 leading digits then a `.` or `)` delimiter.
    let digits = 0;
    while (digits < body.length && isAsciiDigit(body.charCodeAt(digits))) digits++;
    if (digits > 9) return null;
    const afterDigits = body.slice(digits);
    const delim = afterDigits.charCodeAt(0);
    if (delim !== DOT && delim !== RPAREN) return null;
    // Always parses, for at most nine ASCII digits — the Swift's `?? 1`
    // fallback is unreachable. Leading zeros are lost: `007. item` has
    // ordinal 7 and renders as `7.`.
    ordinal = parseInt(body.slice(0, digits), 10);
    rest = afterDigits.slice(1);
  } else {
    return null;
  }

  // The marker must be followed by at least one space (or be at the end of
  // the line, which makes a bare `-` a valid item with empty text). A tab
  // does not count, so `-\tfoo` is not a list item.
  if (!(rest.length === 0 || rest.charCodeAt(0) === SPACE)) return null;
  let text = dropLeadingSpaces(rest);

  // GitHub task-list checkbox: `[ ]` / `[x]` immediately after the marker.
  // The two whole-string comparisons are against ASCII-only literals, which
  // in Swift is canonical equivalence rather than grapheme matching and
  // means what `===` means here; only the prefixes need the scalar form.
  // The unchecked box has no case to fold; the checked one is matched on the
  // lowercased copy, so `[x]` and `[X]` both tick.
  let task: boolean | null = null;
  if (scalarHasPrefix(text, '[ ] ') || text === '[ ]') {
    task = false;
    text = uncheckedText(text);
  } else if (scalarHasPrefix(text.toLowerCase(), '[x] ') || text.toLowerCase() === '[x]') {
    task = true;
    text = uncheckedText(text);
  }

  // A depth *tag*, not a tree: the renderer insets by `level * 1.6em` rather
  // than reconstructing nested lists from a model that has no nesting.
  return { text, level: Math.floor(indent / 2), ordinal, task };
}

/**
 * A task item's text with the three-unit `[ ]` / `[x]` box and the spaces
 * after it taken off.
 *
 * Three *scalars* in the Swift — dropping three graphemes would take a mark
 * the author put on the character after the box. Slicing three UTF-16 units
 * is equivalent, because the prefix test above has already established that
 * the first three units are ASCII.
 */
function uncheckedText(text: string): string {
  return dropLeadingSpaces(text.slice(3));
}

// MARK: - Tables (GFM)

interface TableHead {
  header: string[];
  alignments: ColumnAlignment[];
}

/**
 * Parse a GFM table head: a `header` row plus a `delimiter` row such as
 * `| :--- | :---: | ---: |`. Returns `null` if the pair isn't a table.
 *
 * The delimiter row must have **exactly** as many cells as the header row.
 * `:---` yields `leading`, indistinguishable from `---`: there is no
 * "explicitly left" alignment in this model.
 */
function parseTable(header: string, delimiter: string): TableHead | null {
  if (!scalarContains(header, '|')) return null;
  const delimTrim = trimWS(delimiter);
  if (!scalarContains(delimTrim, '-')) return null;
  // The RAW delimiter line is split, not the trimmed copy — `splitTableRow`
  // trims for itself.
  const delimCells = splitTableRow(delimiter, null);
  // Unreachable: `splitTableRow` always yields at least one cell. Kept
  // because the Swift keeps it.
  if (delimCells.length === 0) return null;

  const alignments: ColumnAlignment[] = [];
  for (const cell of delimCells) {
    // Every delimiter cell must look like `:?-+:?`.
    const c = trimWS(cell);
    if (c === '') return null;
    let hasDash = false;
    for (let k = 0; k < c.length; k++) {
      const ch = c.charCodeAt(k);
      if (ch !== DASH && ch !== COLON) return null;
      if (ch === DASH) hasDash = true;
    }
    if (!hasDash) return null;
    const left = c.charCodeAt(0) === COLON;
    const right = c.charCodeAt(c.length - 1) === COLON;
    alignments.push(left && right ? 'center' : right ? 'trailing' : 'leading');
  }

  const headerCells = splitTableRow(header, null);
  if (headerCells.length !== alignments.length) return null;
  return { header: headerCells, alignments };
}

/**
 * Split one table row into cell strings. A leading and a trailing pipe are
 * optional; escaped pipes (`\|`) stay inside a cell. When `columns` is
 * given, the result is padded with empty cells or truncated to that width.
 *
 * The trailing-pipe test is evaluated **after** the leading one has been
 * dropped, so a row of a single `|` yields one empty cell rather than none.
 * A backslash before anything other than `|` is kept, as is a trailing lone
 * backslash. Every cell is trimmed.
 */
function splitTableRow(row: string, columns: number | null): string[] {
  let t = trimWS(row);
  if (t.charCodeAt(0) === PIPE) t = t.slice(1);
  if (t.length > 0 && t.charCodeAt(t.length - 1) === PIPE) t = t.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (let k = 0; k < t.length; k++) {
    const ch = t[k];
    if (escaped) {
      // Keep the pipe literal; drop the escaping backslash.
      if (ch !== '|') current += '\\';
      current += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '|') {
      cells.push(trimWS(current));
      current = '';
    } else {
      current += ch;
    }
  }
  if (escaped) current += '\\';
  cells.push(trimWS(current));

  if (columns !== null) {
    while (cells.length < columns) cells.push('');
    if (cells.length > columns) return cells.slice(0, columns);
  }
  return cells;
}

// MARK: - Fence helper

/**
 * Parses and matches a fenced-code delimiter (``` or ~~~). Captures the
 * fence character, run length and indentation so the closing fence and body
 * de-indentation follow CommonMark's "at least as long, same char" rule
 * rather than a naive string compare.
 *
 * Scalars throughout, like the parser: ```` ```\u{0301}js ```` is a fence
 * whose third backtick carries a mark, and a `Character` walk counts a run
 * of two there — so the block was a code block on Android and a paragraph on
 * Apple, and the author's code was reflowed as prose and inline-formatted.
 */
class FenceMarker {
  /** The info string's first word, or `null`. Never lowercased here — the renderer folds case at dispatch time. */
  readonly language: string | null;
  private readonly charCode: number;
  private readonly count: number;
  private readonly indent: number;

  private constructor(charCode: number, count: number, indent: number, language: string | null) {
    this.charCode = charCode;
    this.count = count;
    this.indent = indent;
    this.language = language;
  }

  /** An opening fence, or `null`. */
  static from(line: string): FenceMarker | null {
    // Indentation counts U+0020 only, so a tab-indented fence is not a
    // fence — `body[0]` is the tab and fails the character test below. The
    // comment on the Swift's guard says "4+ spaces = code", but there is no
    // indented-code branch anywhere in this parser, so such a line falls
    // through to the *paragraph* branch. Replicate; do not add indented code.
    const indent = leadingSpaceCount(line);
    if (indent > 3) return null;
    const body = line.slice(indent);
    if (body.length === 0) return null;
    const first = body.charCodeAt(0);
    if (first !== BACKTICK && first !== TILDE) return null;
    let run = 0;
    while (run < body.length && body.charCodeAt(run) === first) run++;
    if (run < 3) return null;

    const info = trimWS(body.slice(run));
    // An info string on a backtick fence may not contain a backtick. A tilde
    // fence's may.
    if (first === BACKTICK && scalarContains(info, '`')) return null;

    // The info string is already trimmed, so its first space-separated word
    // is everything up to the first U+0020 — the same word Kotlin's
    // `split(" ").first()` takes. The split is on U+0020 alone while the
    // trim was the wider whitespace set, so ```` ```js\tfoo ```` has the
    // language `"js\tfoo"`: the tab is interior, neither trimmed nor a split
    // point.
    const space = info.indexOf(' ');
    const lang = space < 0 ? info : info.slice(0, space);
    return new FenceMarker(first, run, indent, lang === '' ? null : lang);
  }

  /**
   * A closing fence: the same character, at least as long, and nothing but
   * whitespace after it. The closing fence may be indented arbitrarily —
   * there is no three-space cap here, unlike on the opener.
   */
  closes(line: string): boolean {
    const rest = dropLeadingSpaces(line);
    let run = 0;
    while (run < rest.length && rest.charCodeAt(run) === this.charCode) run++;
    if (run < this.count) return false;
    return trimWS(rest.slice(run)) === '';
  }

  /**
   * Remove up to the opening fence's indentation from a body line, stopping
   * at the first non-space. Never removes more than the opener's indent and
   * never removes tabs, so an indented fence doesn't carry phantom leading
   * spaces into its code.
   */
  stripIndent(line: string): string {
    let removed = 0;
    while (removed < this.indent && line.charCodeAt(removed) === SPACE) removed++;
    return removed === 0 ? line : line.slice(removed);
  }
}
