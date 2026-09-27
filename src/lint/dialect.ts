//
//  dialect.ts
//  md.vscode — where md's Markdown and GitHub's part company, found in the
//  document rather than remembered from a README.
//
//  WHAT THIS IS FOR
//  ----------------
//  The README says it plainly: "A deliberate subset, not a CommonMark
//  engine." Raw HTML is shown as the characters you typed, there are no
//  reference-style links, a four-space indent is a paragraph rather than a
//  code block, and a table needs a blank line above it. Three shipping apps
//  decided all four, the exports are byte-compatible with them, and none of
//  it is going to change here.
//
//  What *can* change is that a document written for GitHub renders
//  differently in this preview **with no warning at all**. That is the one
//  surprise class unique to md: not a bug, not a missing feature, just a
//  quiet difference the author cannot see from inside the editor. This file
//  finds them and says what md does instead.
//
//  SEVERITY IS INFORMATION, ALWAYS, AND THAT IS NOT NEGOTIABLE
//  -----------------------------------------------------------
//  Every one of these constructs is perfectly good Markdown. A warning
//  squiggle under valid prose reads as "your document is wrong", which it is
//  not, and it would make the Problems pane useless for the errors that do
//  matter. The severity is fixed at Information in the one place that builds
//  a `vscode.Diagnostic` (`src/lint/diagnostics.ts`) and there is no setting
//  to raise it.
//
//  THE RULE THAT KEEPS THIS HONEST: NO SECOND PARSER
//  -------------------------------------------------
//  A lint that decides for itself what a code block is will, sooner or later,
//  disagree with the renderer — and then it is worse than nothing, because it
//  reports a difference that is not there. So:
//
//    * **Block structure comes from `parseWithLines()`.** Which lines are a
//      fenced code block, front matter, a private note, a paragraph, a list,
//      a footnote definition — all of it is read off the parser's own output,
//      never re-derived. The "would this really be a table?" question in
//      `tableAfterParagraph` is answered by handing the lines back to
//      `parse()` and looking at what it says.
//    * **"Is this inside a code span?" comes from `inline()`.** The span pass
//      protects code spans and maths before anything else happens, so the
//      question is asked by *running it*: each candidate is replaced with a
//      private-use sentinel, the text goes through `inline()`, and if the
//      sentinel comes out inside a `<code>` or a `.md-math…` span then the
//      author wrote it inside backticks or a formula and there is nothing to
//      report. That is what keeps a less-than sign in prose, and a `<b>`
//      written as an example inside backticks, from being flagged.
//    * **"Is this a footnote reference, and to what?" comes from `inline()`
//      too.** The candidate pattern here is deliberately wider than the
//      renderer's, and the renderer is then asked to name the id — so the
//      ASCII-only identifier rule lives in exactly one place, as it already
//      does for the parser and the HTML writer.
//
//  What is *not* borrowed, because the renderer has no opinion to borrow: the
//  shape of an HTML tag and the shape of a reference link. md has no notion
//  of either — it escapes the one and never had the other — so those two
//  patterns are this file's own, modelled on CommonMark's, and they are the
//  only place a false positive can come from. Both are pinned against the
//  cases that matter in `test/dialect.test.ts`.
//
//  DELIBERATE LIMITS, WRITTEN DOWN RATHER THAN DISCOVERED
//  ------------------------------------------------------
//    * A block's line span is taken as "from its own line up to the line
//      before the next block's". Lines the parser emits nothing for — an
//      ordinary `<!-- … -->` comment, blank lines — therefore fall into the
//      preceding block's span, which is harmless: they are skipped along with
//      it when it is opaque, and they carry nothing any rule matches when it
//      is not.
//    * Blocks nested inside a block quote carry no line of their own (the
//      parser re-parses the stripped inner text, whose line numbers do not
//      address the outer document), so a fenced code block written inside a
//      quote is not recognised as opaque. It is covered in practice anyway:
//      the run of backticks that opens such a fence makes the inline pass
//      read its body as one long code span, so the protection check already
//      answers "yes, that is code". Written down because it is luck rather
//      than design, and because the failure mode if it ever stops holding is
//      a false positive rather than a wrong render.
//    * A reference *use* is reported only when the label it names is actually
//      defined somewhere in the document. `arr[0][1]` in prose is the reason:
//      with no `[1]: …` line it is not a link on GitHub either, so there is
//      nothing to report. A reference *definition* is reported on sight,
//      because GitHub swallows the line whole and md prints it.
//    * A footnote *reference* is never reported, for exactly that reason: an
//      undefined `[^id]` is literal text in md, in markdown-it and on GitHub
//      alike, so there is no difference to name — and `[^a-z]` in a sentence
//      about regular expressions is a character class, not a citation. Only
//      an uncited *definition* is reported, because there GitHub swallows the
//      line and md prints the note at the foot.
//

import { inline } from '../render/inline';
import { parse, parseWithLines } from '../render/parser';
import { normalizedLines, scalarContains, scalarHasPrefix, trimWS } from '../render/text';
import type { BlockKind, PlacedBlock } from '../render/types';

// MARK: - The public shape

/** The five rule groups, in the order the README and the settings list them. */
export const DIALECT_RULES = [
  'rawHtml',
  'referenceLink',
  'indentedCode',
  'tableAfterParagraph',
  'footnote',
] as const;

export type DialectRule = (typeof DIALECT_RULES)[number];

/**
 * Which rules are on. Absent means on, exactly as every other `md.*` boolean
 * is read — `!== false` — so a key a future version adds is enabled for a
 * reader whose settings predate it.
 */
export type RuleSwitches = Readonly<Partial<Record<DialectRule, boolean>>>;

/** Whether `rule` is on under `switches`. */
export function ruleEnabled(switches: RuleSwitches | undefined, rule: DialectRule): boolean {
  return switches?.[rule] !== false;
}

/**
 * A replacement of whole lines, which is every fix this file offers.
 *
 * Lines rather than character ranges because both fixes are structural — a
 * fence around a run, a blank line before a row — and a line range says what
 * is meant without a word about where the line ending is.
 */
export interface DialectFix {
  /** The action's title, as the lightbulb shows it. */
  readonly title: string;
  /** First line replaced, 0-based, inclusive. */
  readonly startLine: number;
  /** Last line replaced, 0-based, inclusive. */
  readonly endLine: number;
  /** What those lines become. */
  readonly lines: readonly string[];
}

/** One difference found, positioned in the source. All indices are 0-based. */
export interface DialectFinding {
  readonly rule: DialectRule;
  /** A stable id for this finding's variety, shown in the Problems pane's Code column. */
  readonly code: string;
  readonly line: number;
  /** UTF-16 offset within `line`. */
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  /** One sentence: what md does with this, and what to write instead. */
  readonly message: string;
  readonly fix: DialectFix | null;
}

// MARK: - Block spans

/** A run of source lines and the kind of block the parser made of them. */
interface Span {
  readonly kind: BlockKind | 'gap';
  /** Inclusive. */
  readonly start: number;
  /** Inclusive. */
  readonly end: number;
  /** The block itself, for the rules that read its content. `null` for a gap. */
  readonly placed: PlacedBlock | null;
}

/**
 * Block kinds whose lines are not prose and are never linted.
 *
 * `codeBlock` is the important one — everything inside a fence is meant to be
 * the characters it says, and flagging a `<div>` in a code sample would be
 * exactly the noise this file must not make. Front matter is a machine's
 * metadata, and a `<!-- note: … -->` is md's own syntax for an author's
 * private note: linting its comment markers as raw HTML would be circular.
 */
const OPAQUE: ReadonlySet<BlockKind | 'gap'> = new Set<BlockKind | 'gap'>([
  'codeBlock',
  'frontMatter',
  'note',
]);

/**
 * Every line of the document, attributed to the block the parser made of it.
 *
 * A block's end is the line before the next block begins, and the last
 * block's end is the last line — see the header for what that over-counts and
 * why it does not matter.
 */
function spansOf(placed: readonly PlacedBlock[], lineCount: number): Span[] {
  const out: Span[] = [];
  if (placed.length > 0 && placed[0].line > 0) {
    out.push({ kind: 'gap', start: 0, end: placed[0].line - 1, placed: null });
  }
  for (let k = 0; k < placed.length; k++) {
    const start = placed[k].line;
    const end = k + 1 < placed.length ? placed[k + 1].line - 1 : lineCount - 1;
    out.push({ kind: placed[k].block.kind, start, end: Math.max(start, end), placed: placed[k] });
  }
  return out;
}

/** The block kind covering each line, for the rules that walk lines rather than blocks. */
function kindByLine(blocks: readonly Span[], lineCount: number): (BlockKind | 'gap')[] {
  const out: (BlockKind | 'gap')[] = new Array(lineCount).fill('gap');
  for (const span of blocks) {
    for (let line = span.start; line <= span.end && line < lineCount; line++) {
      out[line] = span.kind;
    }
  }
  return out;
}

/**
 * Lines inside an HTML comment written on its own line, which the parser
 * drops without emitting anything at all.
 *
 * Those lines need their own answer because a dropped comment leaves no block
 * behind, so the span above it swallows them — and a commented-out
 * `<!-- <img src="…"> -->` would otherwise be reported as raw HTML although
 * neither md nor GitHub shows a character of it. The two predicates are the
 * parser's own, spelled the same way: a comment starts where `<!--` follows
 * any number of spaces, and ends on the first line that contains `-->`.
 *
 * An *inline* comment — one with text before it on the line — is deliberately
 * not masked: md renders that one, which is why the README promises private
 * notes only for a comment on a line of its own.
 */
function commentMask(
  lines: readonly string[],
  kindAt: readonly (BlockKind | 'gap')[],
): boolean[] {
  const masked: boolean[] = new Array(lines.length).fill(false);
  for (let line = 0; line < lines.length; line++) {
    if (kindAt[line] === 'codeBlock' || kindAt[line] === 'frontMatter') continue;
    const body = lines[line].slice(leadingSpaces(lines[line]));
    if (!scalarHasPrefix(body, '<!--')) continue;
    while (line < lines.length) {
      masked[line] = true;
      if (scalarContains(lines[line], '-->')) break;
      line++;
    }
  }
  return masked;
}

// MARK: - "Did the author write this inside backticks?"

/**
 * The sentinel a candidate is replaced with while the inline pass decides
 * whether it was protected.
 *
 * U+E100 and U+E101 are private-use, like `inline()`'s own U+E000 / U+E001
 * pair and deliberately *not* the same two: nothing in the span pass escapes
 * them, no pattern matches them, and an author will not have typed them. The
 * decimal index between them is what tells the candidates apart afterwards,
 * so one run of `inline()` answers for a whole block.
 */
const SENTINEL_OPEN = '\u{E100}';
const SENTINEL_CLOSE = '\u{E101}';

/**
 * The two things `inline()` protects, as they appear in its output.
 *
 * Neither can nest and neither can contain a literal `<`, because their
 * contents are HTML-escaped before they are wrapped — so a non-greedy match
 * is exact here, not merely close enough.
 */
const PROTECTED_OUTPUT = /<code>[\s\S]*?<\/code>|<span class="md-math[id]">[\s\S]*?<\/span>/g;

/** A candidate occurrence inside one block's text, before it is known to be real. */
interface Occurrence {
  /** UTF-16 offset into the block text. */
  readonly start: number;
  /** UTF-16 offset one past the end. */
  readonly end: number;
  readonly text: string;
}

/** The key by which an occurrence is recognised again after the protection pass. */
const key = (o: Occurrence): string => `${o.start}:${o.end}`;

/**
 * The occurrences the reader will actually see as literal text.
 *
 * One call to `inline()` for the whole block, with every candidate standing
 * in as a numbered sentinel. Anything that lands inside a `<code>` or a maths
 * span was written inside backticks or between dollars, and md renders it
 * exactly as GitHub would — there is no difference to report.
 *
 * Overlapping candidates cannot both be substituted, so the earlier one wins
 * and the other is dropped; the rules below are written so that overlaps are
 * vanishingly rare, and dropping one is a missed note rather than a wrong one.
 */
function unprotected(text: string, occurrences: readonly Occurrence[]): Set<string> {
  if (occurrences.length === 0) return new Set();

  const ordered = [...occurrences].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: Occurrence[] = [];
  let reach = -1;
  for (const occurrence of ordered) {
    if (occurrence.start < reach) continue;
    kept.push(occurrence);
    reach = occurrence.end;
  }

  // Back to front, so the offsets of the candidates still to be replaced stay
  // valid — the same discipline every substitution walk in this codebase
  // follows.
  let probe = text;
  for (let k = kept.length - 1; k >= 0; k--) {
    const occurrence = kept[k];
    probe =
      probe.slice(0, occurrence.start) +
      `${SENTINEL_OPEN}${k}${SENTINEL_CLOSE}` +
      probe.slice(occurrence.end);
  }

  const visible = inline(probe).replace(PROTECTED_OUTPUT, '');
  const survivors = new Set<string>();
  kept.forEach((occurrence, k) => {
    if (visible.includes(`${SENTINEL_OPEN}${k}${SENTINEL_CLOSE}`)) survivors.add(key(occurrence));
  });
  return survivors;
}

// MARK: - The patterns this file owns

/**
 * An HTML tag, near enough CommonMark's own inline grammar to agree with
 * GitHub about the cases anyone writes.
 *
 * The letter immediately after `<` is what keeps arithmetic out of it:
 * `1 < 2 and 3 > 4` has a space there and never matches, and `<` followed by
 * a digit is not a tag either. An autolink (`<https://…>`) is not matched —
 * a `:` cannot appear in a tag name — and that is deliberate: it is a
 * different divergence and not one of the five rules here.
 */
const HTML_TAG = new RegExp(
  '</?' +
    '[A-Za-z][A-Za-z0-9-]*' +
    '(?:\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s"\'=<>`]+))?)*' +
    '\\s*/?>',
  'g',
);

/**
 * A link reference definition — `[label]: /url "title"` — on its own line.
 *
 * Strict about the destination and the title on purpose. `[see]: the section
 * below` is *not* a definition to CommonMark either (the title is unquoted
 * junk), so GitHub prints it as a paragraph exactly as md does, and reporting
 * it would be reporting a difference that is not there. A label beginning `^`
 * is a footnote definition, which md does support and which the parser has
 * already taken as a block of its own.
 */
const REFERENCE_DEFINITION = new RegExp(
  '^ {0,3}\\[(?!\\^)([^\\]\\n]+)\\]:' +
    '[ \\t]*' +
    '(?:<[^<>\\n]*>|[^\\s<][^\\s]*)' +
    '(?:[ \\t]+(?:"[^"\\n]*"|\'[^\'\\n]*\'|\\([^)\\n]*\\)))?' +
    '[ \\t]*$',
  'gm',
);

/**
 * `[text][label]`, `[text][]` and their image forms. The shortcut `[label]`
 * alone is not matched: it is indistinguishable from ordinary bracketed
 * prose, and guessing there would cost more than it found.
 */
const REFERENCE_USE = /!?\[(?!\^)([^\]\n]+)\]\[([^\]\n]*)\]/g;

/**
 * Anything shaped like a footnote reference, ids included that md's own
 * pattern would refuse.
 *
 * Deliberately wider than `inline()`'s `[A-Za-z0-9_-]` set, because the
 * *decision* is then taken by running the span pass over the candidate rather
 * than by a second copy of that character class: `[^café]` comes back as
 * literal text and is dropped here, exactly as the reader will see it.
 */
const FOOTNOTE_CANDIDATE = /\[\^([^\]\n]*)\]/g;

/** `inline()`'s own answer to "is this a footnote reference, and to what?". */
const FOOTNOTE_PLACEHOLDER = /^<sup class="md-fnref" data-fn="([A-Za-z0-9_-]+)"><\/sup>$/;

/**
 * The id `inline()` reads out of a `[^…]` candidate, or `null` when it reads
 * none. The renderer's rule, asked of the renderer.
 */
function footnoteId(candidate: string): string | null {
  const match = FOOTNOTE_PLACEHOLDER.exec(inline(candidate));
  return match === null ? null : match[1];
}

/** CommonMark's label matching: trim, collapse internal whitespace, case-fold. */
function normalisedLabel(label: string): string {
  return trimWS(label).replace(/\s+/g, ' ').toLowerCase();
}

// MARK: - Lines

/**
 * How many leading U+0020 SPACE characters `line` has — the parser's own
 * definition of indentation, where a tab is content and not an indent.
 */
function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 0x20) n++;
  return n;
}

const isBlank = (line: string): boolean => trimWS(line) === '';

/** Turns an offset into a block's text back into a document position. */
type Locator = (offset: number) => { line: number; column: number };

function locator(text: string, firstLine: number): Locator {
  // Offsets of each line start within `text`. The block text is built by
  // joining source lines with "\n", so this is exact for a CRLF document too:
  // `normalizedLines` has already taken the carriage returns off.
  const starts: number[] = [0];
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '\n') starts.push(k + 1);
  }
  return (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: firstLine + low, column: offset - starts[low] };
  };
}

/** A tag or a label, quoted for a message and cut short if it is a paragraph. */
function quoted(text: string): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length <= 40 ? `"${flat}"` : `"${flat.slice(0, 39)}…"`;
}

/**
 * Whether every character of `line` could belong to a table's delimiter row —
 * `|`, `-`, `:` and whitespace — and at least one of them is a dash.
 *
 * A prefilter and nothing more: `parseTable` is not exported and must not be
 * reimplemented here, so what this decides is only *whether to ask*. Every
 * line it lets through is then handed to `parse()`, which gives the real
 * answer; every line it stops was never going to be a delimiter row.
 */
function isDelimiterRun(line: string): boolean {
  let dash = false;
  let content = false;
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c === 0x2d) {
      dash = true;
      content = true;
    } else if (c === 0x7c || c === 0x3a) {
      content = true;
    } else if (c !== 0x20 && c !== 0x09) {
      return false;
    }
  }
  return dash && content;
}

/**
 * A fence long enough to hold `body` — three backticks unless the text itself
 * opens a line with as many or more, in which case one longer than the
 * longest such run. A fix that produced a fence the content closes early
 * would be worse than no fix at all.
 */
function fenceFor(body: readonly string[]): string {
  let longest = 0;
  for (const line of body) {
    const trimmed = trimWS(line);
    let run = 0;
    while (run < trimmed.length && trimmed.charCodeAt(run) === 0x60) run++;
    if (run > longest) longest = run;
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

// MARK: - The entry point

/**
 * Every difference between what md will draw and what a CommonMark engine
 * would, in one document.
 *
 * Pure: no editor, no filesystem, no configuration beyond the switches handed
 * in. Findings come back in document order, which is the order the Problems
 * pane wants them in.
 */
export function dialectFindings(source: string, switches?: RuleSwitches): DialectFinding[] {
  const lines = normalizedLines(source);
  const placed = parseWithLines(source);
  const blocks = spansOf(placed, lines.length);
  const kindAt = kindByLine(blocks, lines.length);
  const masked = commentMask(lines, kindAt);
  const findings: DialectFinding[] = [];

  // Two of the five rules cannot be decided block by block. A reference use
  // is only a difference when its label is defined *somewhere*, and a
  // footnote definition is only uncited when nothing in the whole document
  // cites it — so both are gathered first and reported after the walk.
  interface Pending {
    readonly name: string;
    readonly text: string;
    readonly line: number;
    readonly column: number;
    readonly endLine: number;
    readonly endColumn: number;
  }
  const definedLabels = new Set<string>();
  const referencedFootnotes = new Set<string>();
  const pendingUses: Pending[] = [];

  for (const span of blocks) {
    if (OPAQUE.has(span.kind)) continue;
    const text = lines.slice(span.start, span.end + 1).join('\n');
    const at = locator(text, span.start);
    /** A line the parser drops wholesale is no one's difference. */
    const shown = (offset: number): boolean => !masked[at(offset).line];

    // Everything that needs the "is it inside backticks?" test is collected
    // first and asked in one go: one `inline()` per block rather than one per
    // candidate.
    const tags: Occurrence[] = [];
    const definitions: { occurrence: Occurrence; label: string }[] = [];
    const uses: { occurrence: Occurrence; label: string }[] = [];
    const references: { occurrence: Occurrence; id: string }[] = [];

    for (const match of text.matchAll(HTML_TAG)) {
      if (!shown(match.index)) continue;
      tags.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    }
    for (const match of text.matchAll(REFERENCE_DEFINITION)) {
      if (!shown(match.index)) continue;
      // The reported range is the `[label]:` part alone — not the whole line,
      // because a squiggle under a URL reads as a complaint about the URL, and
      // not the up-to-three spaces CommonMark allows in front of it either.
      const indent = leadingSpaces(match[0]);
      const head = match[0].indexOf(']:') + 2;
      definitions.push({
        occurrence: {
          start: match.index + indent,
          end: match.index + head,
          text: match[0].slice(indent, head),
        },
        label: match[1],
      });
    }
    for (const match of text.matchAll(REFERENCE_USE)) {
      if (!shown(match.index)) continue;
      // `[text][]` is the collapsed form: the label is the text.
      uses.push({
        occurrence: { start: match.index, end: match.index + match[0].length, text: match[0] },
        label: match[2].length > 0 ? match[2] : match[1],
      });
    }
    if (span.kind !== 'footnoteDefinition') {
      // A reference written inside a footnote definition is not a reference at
      // all: definitions render to nothing in the body, so `withFootnotes`
      // never sees the placeholder and prints it back as literal text. Reading
      // them here would call an uncited note cited.
      for (const match of text.matchAll(FOOTNOTE_CANDIDATE)) {
        if (!shown(match.index)) continue;
        const id = footnoteId(match[0]);
        if (id === null) continue;
        references.push({
          occurrence: { start: match.index, end: match.index + match[0].length, text: match[0] },
          id,
        });
      }
    }

    const survivors = unprotected(text, [
      ...tags,
      ...definitions.map((entry) => entry.occurrence),
      ...uses.map((entry) => entry.occurrence),
      ...references.map((entry) => entry.occurrence),
    ]);
    const visible = (occurrence: Occurrence): boolean => survivors.has(key(occurrence));

    for (const tag of tags) {
      if (!visible(tag) || !ruleEnabled(switches, 'rawHtml')) continue;
      const from = at(tag.start);
      const to = at(tag.end);
      findings.push({
        rule: 'rawHtml',
        code: 'md.dialect.rawHtml',
        line: from.line,
        column: from.column,
        endLine: to.line,
        endColumn: to.column,
        message:
          `md renders raw HTML as text, so ${quoted(tag.text)} appears exactly as written ` +
          'rather than as markup. Use Markdown for the effect, or backticks to show the tag.',
        fix: null,
      });
    }

    for (const definition of definitions) {
      if (!visible(definition.occurrence)) continue;
      // Recorded whatever the switch says: a use is judged against the labels
      // the document defines, and turning a rule off must not change which
      // uses are differences.
      definedLabels.add(normalisedLabel(definition.label));
      if (!ruleEnabled(switches, 'referenceLink')) continue;
      const from = at(definition.occurrence.start);
      const to = at(definition.occurrence.end);
      findings.push({
        rule: 'referenceLink',
        code: 'md.dialect.referenceDefinition',
        line: from.line,
        column: from.column,
        endLine: to.line,
        endColumn: to.column,
        message:
          'md has no link reference definitions, so this line is printed as ordinary text ' +
          'instead of disappearing. Write the address inline, as [text](url).',
        fix: null,
      });
    }

    for (const use of uses) {
      if (!visible(use.occurrence)) continue;
      const from = at(use.occurrence.start);
      const to = at(use.occurrence.end);
      pendingUses.push({
        name: normalisedLabel(use.label),
        text: use.occurrence.text,
        line: from.line,
        column: from.column,
        endLine: to.line,
        endColumn: to.column,
      });
    }

    // A reference is gathered for one purpose only: to answer, at the end,
    // whether each definition is cited. The reference itself is never a
    // finding — see the footnote arm below for why.
    for (const reference of references) {
      if (!visible(reference.occurrence)) continue;
      referencedFootnotes.add(reference.id);
    }
  }

  if (ruleEnabled(switches, 'referenceLink')) {
    for (const use of pendingUses) {
      if (!definedLabels.has(use.name)) continue;
      findings.push({
        rule: 'referenceLink',
        code: 'md.dialect.referenceUse',
        line: use.line,
        column: use.column,
        endLine: use.endLine,
        endColumn: use.endColumn,
        message:
          `md has no reference-style links, so ${quoted(use.text)} is printed as written, ` +
          'and the definition it names goes unused. Write the address inline, as [text](url).',
        fix: null,
      });
    }
  }

  if (ruleEnabled(switches, 'footnote')) {
    // Only the uncited *definition*. A reference with nothing behind it is
    // not reported, because it is not a difference: md leaves `[^id]` in the
    // text exactly as written, and so does every CommonMark engine — there is
    // nothing for this file to tell the author that the preview does not
    // already show them. It is also the same principle the reference-link arm
    // above follows, and for the same reason: `[^a-z]` in a sentence about
    // regular expressions is prose, not a citation.
    for (const entry of placed) {
      if (entry.block.kind !== 'footnoteDefinition') continue;
      if (referencedFootnotes.has(entry.block.id)) continue;
      const marker = `[^${entry.block.id}]:`;
      const raw = lines[entry.line] ?? '';
      const column = Math.max(0, raw.indexOf(marker));
      findings.push({
        rule: 'footnote',
        code: 'md.dialect.footnoteNeverCited',
        line: entry.line,
        column,
        endLine: entry.line,
        endColumn: column + marker.length,
        message:
          `Nothing cites [^${entry.block.id}]. md still prints the note, after the cited ones ` +
          'at the foot of the document, but with no number in the text and no link back to it.',
        fix: null,
      });
    }
  }

  if (ruleEnabled(switches, 'indentedCode')) {
    findings.push(...indentedCodeFindings(lines, blocks, kindAt));
  }
  if (ruleEnabled(switches, 'tableAfterParagraph')) {
    findings.push(...tableFindings(lines, blocks));
  }

  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

// MARK: - Four-space indented code

/**
 * A paragraph that begins four spaces in, where CommonMark would have opened
 * a code block.
 *
 * Only a paragraph the parser *started* at an indented line can be one: an
 * indented line under a paragraph already in progress is a continuation line
 * on both sides of the fence, so there is no difference to report. What
 * stands immediately above decides the rest, and three answers mean "not code
 * anywhere": a list, a block quote and a footnote definition all take an
 * indented block underneath as their own continued content, so an author who
 * indented under one of them meant exactly what every engine does with it.
 */
function indentedCodeFindings(
  lines: readonly string[],
  blocks: readonly Span[],
  kindAt: readonly (BlockKind | 'gap')[],
): DialectFinding[] {
  const findings: DialectFinding[] = [];
  const CONTINUES_ABOVE: ReadonlySet<BlockKind | 'gap'> = new Set<BlockKind | 'gap'>([
    'list',
    'quote',
    'footnoteDefinition',
  ]);

  for (let k = 0; k < blocks.length; k++) {
    const span = blocks[k];
    if (span.kind !== 'paragraph') continue;
    if (leadingSpaces(lines[span.start]) < 4) continue;
    if (k > 0 && CONTINUES_ABOVE.has(blocks[k - 1].kind)) continue;

    // How far CommonMark's code block would run: over blank lines, on through
    // every further indented line, and stopping at the first line md made
    // something other than a paragraph of — a fence must never swallow a list
    // or a table that renders correctly today.
    let last = span.start;
    let line = span.start;
    while (line < lines.length) {
      if (isBlank(lines[line])) {
        line++;
        continue;
      }
      if (leadingSpaces(lines[line]) < 4 || kindAt[line] !== 'paragraph') break;
      last = line;
      line++;
    }

    const body = lines.slice(span.start, last + 1);
    const indent = Math.min(
      ...body.filter((entry) => !isBlank(entry)).map((entry) => leadingSpaces(entry)),
    );
    const dedented = body.map((entry) => (isBlank(entry) ? '' : entry.slice(indent)));
    const fence = fenceFor(dedented);

    findings.push({
      rule: 'indentedCode',
      code: 'md.dialect.indentedCode',
      line: span.start,
      column: 0,
      endLine: span.start,
      endColumn: lines[span.start].length,
      message:
        'md has no indented code blocks: four spaces start a paragraph here, not code, so ' +
        'the indentation and the monospaced type are lost. Fence the block instead.',
      fix: {
        title: 'Wrap the indented block in a fenced code block',
        startLine: span.start,
        endLine: last,
        lines: [fence, ...dedented, fence],
      },
    });

    // Every span the run covered has now been reported on; do not report them
    // again one by one.
    while (k + 1 < blocks.length && blocks[k + 1].start <= last) k++;
  }

  return findings;
}

// MARK: - A table with no blank line above it

/**
 * A table written on the line straight after a paragraph.
 *
 * md's paragraph loop carries no table lookahead — the rule is stated in the
 * parser and in §11 of the spec, and it is shipped in three apps — so the
 * header row, the delimiter row and every row under them are swallowed into
 * the paragraph and render as text with `<br>`s between them. One blank line
 * is the whole fix.
 *
 * Whether a pair of lines really would make a table is decided by handing
 * them back to `parse()`, which is the same code that will decide it once the
 * blank line is there.
 */
function tableFindings(lines: readonly string[], blocks: readonly Span[]): DialectFinding[] {
  const findings: DialectFinding[] = [];

  for (const span of blocks) {
    if (span.kind !== 'paragraph' || span.placed === null) continue;
    const block = span.placed.block;
    if (block.kind !== 'paragraph') continue;
    // The paragraph's own lines, which is where the swallowed table must be —
    // not the span, which runs on over the blank lines that follow.
    const last = span.start + block.text.split('\n').length - 1;

    for (let line = span.start + 1; line < last; line++) {
      // Cheap first, and the authoritative answer only for a pair that could
      // possibly be one: a header row has a pipe, and the line under it is
      // made of nothing but the four characters a delimiter row may contain.
      // Without that second test a paragraph of a thousand `a | b` lines
      // would hand a thousand slices to `parse()`.
      if (!lines[line].includes('|') || !isDelimiterRun(lines[line + 1])) continue;
      const first = parse(lines.slice(line, last + 1).join('\n'))[0];
      if (first === undefined || first.kind !== 'table') continue;

      findings.push({
        rule: 'tableAfterParagraph',
        code: 'md.dialect.tableAfterParagraph',
        line,
        column: 0,
        endLine: line,
        endColumn: lines[line].length,
        message:
          'md needs a blank line above a table. Written directly under a paragraph these ' +
          'rows stay part of it and render as text, not as a table.',
        fix: {
          title: 'Add a blank line above the table',
          startLine: line,
          endLine: line,
          lines: ['', lines[line]],
        },
      });
      // Past the delimiter row: the rows below it cannot start a second table.
      line++;
    }
  }

  return findings;
}
