//
//  plot.ts
//  md.vscode — the ```plot fence: source text in, an SVG string out.
//
//  THE ONE PROPERTY WORTH PROTECTING
//  ---------------------------------
//  This module is **pure and synchronous**. No engine, no bundled asset, no
//  `<script>`, no network, no platform API — a string goes in and a string
//  comes out. That is what makes every surface work for free: the live
//  preview, the self-contained HTML export, print, PDF, EPUB, LaTeX and the
//  "export this diagram as SVG" command all receive a finished `<svg>` in the
//  bytes the renderer already returns. A plot-only document never loads an
//  engine and never touches a webview.
//
//  The one piece of state in this file is the render cache beneath
//  {@link renderPlot} — a memo on the fence text and on nothing else. It does
//  not weaken the property: the string returned for a given source is the
//  string that source would have produced anyway, and the memo is invisible to
//  every caller. It is there because the live preview re-renders the whole
//  document on every keystroke, and a plot is the first fence that costs real
//  milliseconds at this layer rather than in the page.
//
//  It is also why nothing here may reach for `vscode`, for `src/engines/**`,
//  or for a package: `src/render/**` is the parity core, and this file is the
//  reference the iOS, macOS and Android ports are written against. Everything
//  below is deliberately written in the subset of TypeScript that translates
//  literally into Swift and Kotlin — hand-written scanning instead of regular
//  expressions, plain discriminated unions instead of generics, explicit loops
//  instead of clever reductions.
//
//  WHAT IT IS A PORT OF, AND WHERE IT DELIBERATELY DIVERGES
//  -------------------------------------------------------
//  The geometry comes from nettrash.me's own plotter
//  (`frontend/src/components/math.rs`: `render_plot_svg`, `nice_step`,
//  `format_label`), so a figure drawn here lands where the site draws it. Four
//  behaviours of that plotter are **bugs**, and they are fixed here rather than
//  inherited — each one is called out at the code that fixes it:
//
//    1. `floor`, `ceil` and `round` draw nothing on the site (its preprocessor
//       rewrites every name to `math::…` while evalexpr binds those three
//       bare), so all 1001 samples fail. They work here.
//    2. A comparison yields a Boolean the site's eval closure throws away, so
//       `x > 0` is a blank chart. Here comparisons yield 1.0 / 0.0, which makes
//       `(x > 0) * sqrt(x)` the half-domain idiom it should be.
//    3. `^` is right-associative here — `2^3^2` is 512, not evalexpr's 64.
//    4. Everything is a double: `5/2` is 2.5, not evalexpr's integer 2.
//
//  and two more in the axis code, where the site's own output is visibly wrong:
//  tick labels are rounded rather than truncated (a tick at −4 printed "-3"),
//  and tick positions are computed by index rather than accumulated (a tick at
//  0 printed "-5.6e-17").
//
//  NUMBER FORMATTING IS THE CROSS-PLATFORM HAZARD
//  ----------------------------------------------
//  Rust's `{:.1e}` writes `1.0e3`; C's `%.1e` writes `1.0e+03`; Java the same;
//  JavaScript's `toExponential(1)` writes `1.0e+3`. Worse, the *rounding*
//  differs: 1250 is `1.2e3` in Rust (ties to even) and `1.3e+3` in Java and
//  JavaScript (ties away from zero). So the formatters at the foot of this file
//  are written by hand, round ties to even on the exact binary value, and emit
//  the Rust spelling. **Do not replace them with the platform's printf.**
//

import { escapeHTML } from './inline';

// MARK: - The entry point

/**
 * One ```plot fence, as the block of markup the renderer embeds.
 *
 * The container is emitted **unconditionally** — for a good plot, an empty
 * block and a broken one alike. Every export path counts `div.plot`
 * containers to pair a rendered figure with its source block, so a fence that
 * emitted nothing would shift every later diagram onto the wrong figure.
 *
 * A block that cannot be parsed keeps its source text visible under one
 * `plot: …` line, which is the family's rule for every rich block: never a
 * hole, never an error box.
 */
export function renderPlot(source: string): string {
  const cached = cacheLookup(source);
  if (cached !== null) return cached;
  let block: string;
  try {
    block = `<div class="plot">${plotSVG(source)}</div>`;
  } catch (err) {
    const message = err instanceof PlotError ? err.message : String(err);
    block = `<div class="plot"><pre>${escapeHTML(`plot: ${message}\n${source}`)}</pre></div>`;
  }
  // The failure is cached with the successes, deliberately: a half-typed fence
  // is a parse error on almost every keystroke, so the broken state is the one
  // a block spends most of its life in, and re-running the parser to produce
  // the same one-line message would be the whole point of this cache missed.
  cacheStore(source, block);
  return block;
}

// MARK: - The render cache
//
// WHY THERE IS ONE
// ----------------
// The live preview rebuilds the entire HTML document on every text change; the
// 0.35 s debounce delays the webview *reload*, not the render. Every other rich
// block is only escaped text at this layer — its engine runs later, in the page,
// asynchronously — so a plot is the first fence whose real cost is paid here,
// synchronously, per keystroke. Measured in a release build on a Mac: 4.87 ms
// for one default plot, 9.52 ms for the golden fence, 36 ms for an eight-series
// plot, 187 ms for a document holding four of those, and 289 ms for ten
// `samples: 5000` plots. The per-fence clamps bound a fence, not a document, and
// a phone is slower.
//
// {@link renderPlot} is a pure function of its source string and of nothing
// else — no theme, no options, no clock, no document position — so a cache keyed
// on that exact string is sound by construction. While prose is being typed
// around them, every plot in the document is a hit, and the per-keystroke cost
// of the ones the author is not editing goes to zero.
//
// This is the whole of the fix. The debounce and the preview coordinator are
// deliberately untouched: that path carries scroll sync and the document-token
// bookkeeping, and none of it is this change's business.
//
// WHY A PLAIN MAP NEEDS NO LOCK HERE
// ---------------------------------
// The Swift and Kotlin ports guard their copy of this table with a lock (an
// `NSLock` / `@Synchronized`), because the same renderer is reached from export
// paths that do not run on the main thread. JavaScript needs no such guard:
// the extension host is a single thread, and {@link renderPlot} is synchronous
// from the lookup through the store — there is no `await` between them for
// another task to interleave into — so lookup-render-store is already atomic.
// **That is why this is a bare `Map` and the ports are not.**

/**
 * How many rendered fences to remember.
 *
 * 32, which is the number the preview client already uses for its own diagram
 * cache (`preview/md-preview.ts`, `CACHE_LIMIT`) — the same problem, one layer
 * further out, and no reason for the two to disagree. It has to be a cap rather
 * than an open map: typing inside a fence mints a new key per keystroke, so an
 * unbounded table would retain every intermediate draft for the life of the
 * session, each one holding a finished SVG.
 */
const CACHE_LIMIT = 32;
/**
 * The largest container worth remembering, in UTF-16 code units — eight times
 * the default figure. See {@link cacheStore} for why there is a byte bound as
 * well as an entry bound.
 */
const LARGEST_MEMOISED_VALUE = 128 * 1024;

/**
 * Fence source to finished container, least-recently-used first.
 *
 * A `Map` iterates in insertion order, so re-inserting on a hit is what makes
 * the eviction below least-recently-*used* rather than least-recently-written —
 * without it the plot the author keeps re-rendering is the one that gets thrown
 * away. Values include the failure containers; see {@link renderPlot}.
 */
const cache = new Map<string, string>();

let hits = 0;
let misses = 0;

/** The remembered container for `source`, or `null` on a miss. */
function cacheLookup(source: string): string | null {
  const found = cache.get(source);
  if (found === undefined) {
    misses += 1;
    return null;
  }
  hits += 1;
  // Re-insert so this entry becomes the newest; see {@link cache}.
  cache.delete(source);
  cache.set(source, found);
  return found;
}

function cacheStore(source: string, block: string): void {
  // An oversized figure is not memoised. The entry ceiling bounds the *count*,
  // not the bytes, and one fence may legally reach 1.8 MB (24 series x
  // `samples: 5000` at 2000x2000), so 32 of those would retain ~57 MB for the
  // life of the process. A figure that large is also the one a memo helps
  // least: rare, and hundreds of milliseconds to draw either way. Everything
  // ordinary is far below the line — the default figure is 16,888 bytes — so
  // this bounds the memo at roughly 4 MB and costs the common case nothing.
  if (block.length > LARGEST_MEMOISED_VALUE) return;
  cache.delete(source);
  cache.set(source, block);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** What the cache has done so far. Exists so the tests can prove a hit. */
export interface PlotCacheStats {
  hits: number;
  misses: number;
  size: number;
  limit: number;
}

/** @see PlotCacheStats */
export function plotCacheStats(): PlotCacheStats {
  return { hits, misses, size: cache.size, limit: CACHE_LIMIT };
}

/** Empties the cache and the counters. For tests; nothing in the extension calls it. */
export function resetPlotCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}

/**
 * The `<svg>` element for a fence, or a {@link PlotError} describing why not.
 *
 * An empty block — no series at all — is not an error and draws nothing, the
 * same way an empty Mermaid block does.
 */
export function plotSVG(source: string): string {
  const spec = parsePlot(source);
  // A block with nothing in it draws nothing, the way an empty Mermaid block
  // does. A block the author *did* write in — directives but no series — is
  // not empty, and returning '' there would swallow what they typed into a
  // container with no figure and no explanation. Draw the empty axes those
  // directives describe: it shows the range and title took effect, and the
  // missing curve is then obviously the missing curve.
  if (spec.series.length === 0 && !spec.hasDirectives) return '';
  return draw(spec);
}

/** Everything that makes a block unrenderable, with the message the reader sees. */
export class PlotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlotError';
  }
}

// MARK: - The fence

/** A parsed ```plot block: the directives, resolved, and the series in order. */
export interface PlotSpec {
  xMin: number;
  xMax: number;
  /** null when `y: auto` (the default) — the range is fitted to the samples. */
  yMin: number | null;
  yMax: number | null;
  title: string;
  xLabel: string;
  yLabel: string;
  legend: 'on' | 'off' | 'auto';
  grid: boolean;
  axes: boolean;
  width: number;
  height: number;
  samples: number;
  series: Series[];
  /**
   * Whether the fence carried at least one directive.
   *
   * Distinguishes a genuinely empty block (draws nothing, like an empty Mermaid
   * block) from one the author wrote directives into but no series — which must
   * still draw, or their text vanishes into a container with nothing in it.
   */
  hasDirectives: boolean;
}

/**
 * One curve.
 *
 * Three shapes, one flat record rather than three classes: a `kind` tag and the
 * fields each kind uses, which is the shape that ports to a Swift `enum` with
 * associated values and to a Kotlin sealed class without either language
 * needing a downcast in the drawing code.
 */
export interface Series {
  kind: 'function' | 'parametric' | 'points';
  /** The author's own label, or null — in which case the legend shows `source`. */
  label: string | null;
  /** The source text of the series, verbatim, for the legend and for messages. */
  source: string;
  /** `function`: y = f(x). `parametric`: the x half. Unused by `points`. */
  expression: Node | null;
  /** `parametric` only: the y half. */
  yExpression: Node | null;
  /** `parametric` only: the parameter's name and range. */
  parameter: string;
  tMin: number;
  tMax: number;
  /** `points` only. */
  points: Point[];
}

export interface Point {
  x: number;
  y: number;
}

/** The directive keys. Anything else before a colon is a series, not an error. */
const DIRECTIVES = [
  'x', 'y', 'title', 'xlabel', 'ylabel', 'legend', 'grid', 'axes', 'width', 'height', 'samples',
];

const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 400;
const DEFAULT_SAMPLES = 1000;
const MIN_WIDTH = 160;
const MAX_WIDTH = 2000;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 2000;
const MIN_SAMPLES = 50;
const MAX_SAMPLES = 5000;
/**
 * The most series one fence may draw.
 *
 * `samples`, `width` and `height` are all clamped, but the series count is the
 * one input an author sets just by adding lines — and the live preview
 * re-renders the whole document on every keystroke. A thousand-series fence
 * takes ~1.8 s and builds a 13.8 MB string, which is a frozen editor rather
 * than a slow one. Twenty-four is well past any legible figure (the palette
 * holds eight) and cheap at the sampling limit.
 */
const MAX_SERIES = 24;
/**
 * The deepest an expression may nest.
 *
 * The parser and evaluator both recurse, so `((((…x…))))` or `x+x+x+…` can
 * exhaust the stack. A raw RangeError would reach the reader as
 * "plot: Maximum call stack size exceeded" — an internal message where §1.7
 * promises "plot: <what>". This turns it into one. The Swift and Kotlin ports
 * need the same guard: a stack overflow there is a crash, not an exception.
 */
const MAX_DEPTH = 128;
/**
 * The most nodes one expression may hold.
 *
 * The depth guard cannot see a long *flat* chain: `x+x+x+…` parses through the
 * left-associative loop at constant depth, then blows the stack in the
 * evaluator, which walks the resulting left-deep tree recursively. Budgeting
 * nodes at parse time catches both shapes in one place, before anything is
 * evaluated 1000 times over.
 */
const MAX_NODES = 4096;

/**
 * Read a fence into a {@link PlotSpec}.
 *
 * Blank lines are ignored, a line whose first non-space character is `#` is a
 * comment, and order is free — directives may follow series. A line is a
 * directive when it reads `key: value` **and the key is known**, so `f: x`
 * still plots rather than failing on an unknown directive.
 */
export function parsePlot(source: string): PlotSpec {
  const spec: PlotSpec = {
    xMin: -10,
    xMax: 10,
    yMin: null,
    yMax: null,
    title: '',
    xLabel: '',
    yLabel: '',
    legend: 'auto',
    grid: true,
    axes: true,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    samples: DEFAULT_SAMPLES,
    series: [],
    hasDirectives: false,
  };

  for (const raw of splitLines(source)) {
    const line = trim(raw);
    if (line.length === 0) continue;
    if (line.charAt(0) === '#') continue;
    const directive = matchDirective(line);
    if (directive !== null) {
      applyDirective(spec, directive.key, directive.value);
      spec.hasDirectives = true;
      continue;
    }
    if (spec.series.length === MAX_SERIES) {
      throw new PlotError(`too many series (limit ${MAX_SERIES})`);
    }
    spec.series.push(parseSeries(line));
  }

  if (!(spec.xMax > spec.xMin)) throw new PlotError('x range must be increasing');
  if (spec.yMin !== null && spec.yMax !== null && !(spec.yMax > spec.yMin)) {
    throw new PlotError('y range must be increasing');
  }
  return spec;
}

/**
 * `key: value`, whatever the key.
 *
 * Hand-scanned rather than matched with `^\s*([a-z][a-z-]*)\s*:\s*(.*)$`,
 * because the same scan has to exist in Swift and Kotlin.
 */
function matchKeyed(line: string): { key: string; value: string } | null {
  let index = 0;
  while (index < line.length && isSpace(line.charAt(index))) index++;
  const start = index;
  if (index >= line.length || !isLowerLetter(line.charAt(index))) return null;
  while (index < line.length && (isLowerLetter(line.charAt(index)) || line.charAt(index) === '-')) {
    index++;
  }
  const key = line.slice(start, index);
  while (index < line.length && isSpace(line.charAt(index))) index++;
  if (index >= line.length || line.charAt(index) !== ':') return null;
  return { key, value: trim(line.slice(index + 1)) };
}

/**
 * The same line, when the key is one this renderer knows.
 *
 * The known-key test is what keeps an unknown `key:` line from failing the
 * block: `f: x` is a series labelled `f`, not a complaint about a directive
 * nobody meant to write.
 */
function matchDirective(line: string): { key: string; value: string } | null {
  const keyed = matchKeyed(line);
  if (keyed === null || !contains(DIRECTIVES, keyed.key)) return null;
  return keyed;
}

function applyDirective(spec: PlotSpec, key: string, value: string): void {
  if (key === 'x') {
    const range = parseRange(value, 'x');
    spec.xMin = range.min;
    spec.xMax = range.max;
    return;
  }
  if (key === 'y') {
    if (lowercased(value) === 'auto') {
      spec.yMin = null;
      spec.yMax = null;
      return;
    }
    const range = parseRange(value, 'y');
    spec.yMin = range.min;
    spec.yMax = range.max;
    return;
  }
  if (key === 'title') {
    spec.title = value;
    return;
  }
  if (key === 'xlabel') {
    spec.xLabel = value;
    return;
  }
  if (key === 'ylabel') {
    spec.yLabel = value;
    return;
  }
  if (key === 'legend') {
    const word = lowercased(value);
    if (word === 'on' || word === 'off' || word === 'auto') {
      spec.legend = word;
      return;
    }
    throw new PlotError("legend must be 'on', 'off' or 'auto'");
  }
  if (key === 'grid' || key === 'axes') {
    const word = lowercased(value);
    if (word !== 'on' && word !== 'off') throw new PlotError(`${key} must be 'on' or 'off'`);
    if (key === 'grid') spec.grid = word === 'on';
    else spec.axes = word === 'on';
    return;
  }
  if (key === 'width') {
    spec.width = clampInteger(number(value, 'width'), MIN_WIDTH, MAX_WIDTH);
    return;
  }
  if (key === 'height') {
    spec.height = clampInteger(number(value, 'height'), MIN_HEIGHT, MAX_HEIGHT);
    return;
  }
  // `samples`, the only key left.
  spec.samples = clampInteger(number(value, 'samples'), MIN_SAMPLES, MAX_SAMPLES);
}

/**
 * `A..B`.
 *
 * Both ends are parsed as constant expressions rather than bare number
 * literals, so `x: -pi..pi` and `x: 0..2*pi` work. A number literal is the
 * simplest such expression, so nothing that the stricter reading accepts is
 * lost, and an end that mentions a variable is an error rather than a silent
 * zero.
 */
function parseRange(value: string, key: string): { min: number; max: number } {
  const at = indexOfPair(value, '.', '.');
  if (at < 0) throw new PlotError(`${key} range must be written min..max`);
  const min = constant(value.slice(0, at), key);
  const max = constant(value.slice(at + 2), key);
  if (!(max > min)) throw new PlotError(`${key} range must be increasing`);
  return { min, max };
}

/** A constant expression: no variable, finite. */
function constant(text: string, key: string): number {
  const trimmed = trim(text);
  if (trimmed.length === 0) throw new PlotError(`${key} range must be written min..max`);
  const value = evaluate(parseExpression(trimmed, ''), '', 0);
  if (!isFiniteNumber(value)) throw new PlotError(`${key} range must be finite`);
  return value;
}

function number(value: string, key: string): number {
  const parsed = evaluate(parseExpression(trim(value), ''), '', 0);
  if (!isFiniteNumber(parsed)) throw new PlotError(`${key} must be a number`);
  return parsed;
}

/** A pixel count or a sample count: rounded to a whole number, then clamped. */
function clampInteger(value: number, low: number, high: number): number {
  const whole = roundTiesAway(value);
  if (whole < low) return low;
  if (whole > high) return high;
  return whole;
}

/**
 * One series line.
 *
 * The label is everything left of the first top-level `=` that is not part of
 * `==`, `<=`, `>=` or `!=`. There is no ambiguity to resolve: the expression
 * language has no assignment, so a bare `=` is always a label separator.
 */
function parseSeries(line: string): Series {
  let label: string | null = null;
  let body = line;
  const at = labelSeparator(line);
  if (at >= 0) {
    label = trim(line.slice(0, at));
    body = trim(line.slice(at + 1));
    if (label.length === 0) label = null;
  } else if (!isPointsLine(line)) {
    // `f: x` — a `key:` line whose key is no directive of ours. The key is the
    // label and the rest is the series, which is what lets an unknown
    // directive plot instead of failing the block. `points:` is the one
    // colon that means something else, and it is claimed above.
    const keyed = matchKeyed(line);
    if (keyed !== null && keyed.value.length > 0) {
      label = keyed.key;
      body = keyed.value;
    }
  }
  if (body.length === 0) throw new PlotError('a series needs an expression');

  const points = parsePointsSeries(label, body);
  if (points !== null) return points;
  const parametric = parseParametricSeries(label, body);
  if (parametric !== null) return parametric;

  return {
    kind: 'function',
    label,
    source: body,
    expression: parseExpression(body, 'x'),
    yExpression: null,
    parameter: 'x',
    tMin: 0,
    tMax: 0,
    points: [],
  };
}

/** The index of the label `=`, or −1. */
function labelSeparator(line: string): number {
  let depth = 0;
  for (let index = 0; index < line.length; index++) {
    const c = line.charAt(index);
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '=' && depth === 0) {
      // `==` is a comparison, and `<=`, `>=`, `!=` end with one.
      if (index + 1 < line.length && line.charAt(index + 1) === '=') return -1;
      if (index > 0) {
        const before = line.charAt(index - 1);
        if (before === '=' || before === '<' || before === '>' || before === '!') return -1;
      }
      return index;
    }
  }
  return -1;
}

const POINTS_PREFIX = 'points:';

/** Does this line open a points series? */
function isPointsLine(line: string): boolean {
  if (line.length < POINTS_PREFIX.length) return false;
  return lowercased(line.slice(0, POINTS_PREFIX.length)) === POINTS_PREFIX;
}

/** `points: x,y x,y …`, or null when this is not a points series. */
function parsePointsSeries(label: string | null, body: string): Series | null {
  if (!isPointsLine(body)) return null;
  const prefix = POINTS_PREFIX;

  const points: Point[] = [];
  for (const token of splitWhitespace(body.slice(prefix.length))) {
    const comma = token.indexOf(',');
    if (comma < 0) throw new PlotError(`points must be x,y pairs — '${token}' is not one`);
    points.push({
      x: constant(token.slice(0, comma), 'point'),
      y: constant(token.slice(comma + 1), 'point'),
    });
  }
  if (points.length === 0) throw new PlotError('points needs at least one x,y pair');
  return {
    kind: 'points',
    label,
    source: body,
    expression: null,
    yExpression: null,
    parameter: '',
    tMin: 0,
    tMax: 0,
    points,
  };
}

/**
 * `(fx(t), fy(t)) for t in A..B`, or null when this is not a parametric series.
 *
 * The test is deliberately narrow — an opening parenthesis whose match is
 * followed by the word `for`, with exactly one top-level comma inside — so that
 * `(x+1)*2` stays an ordinary function of x.
 */
function parseParametricSeries(label: string | null, body: string): Series | null {
  if (body.charAt(0) !== '(') return null;
  const close = matchingParenthesis(body, 0);
  if (close < 0) return null;
  const tail = trim(body.slice(close + 1));
  if (!startsWithWord(tail, 'for')) return null;

  const inside = body.slice(1, close);
  const comma = topLevelComma(inside);
  if (comma < 0) throw new PlotError('a parametric series needs (x(t), y(t))');

  // `for t in A..B`
  const rest = trim(tail.slice(3));
  let index = 0;
  while (index < rest.length && isIdentifierPart(rest.charAt(index))) index++;
  const parameter = rest.slice(0, index);
  if (parameter.length === 0 || !isIdentifierStart(parameter.charAt(0))) {
    throw new PlotError("expected a parameter name after 'for'");
  }
  const afterName = trim(rest.slice(index));
  if (!startsWithWord(afterName, 'in')) throw new PlotError(`expected 'in' after '${parameter}'`);
  const range = parseRange(trim(afterName.slice(2)), parameter);

  return {
    kind: 'parametric',
    label,
    source: body,
    expression: parseExpression(trim(inside.slice(0, comma)), parameter),
    yExpression: parseExpression(trim(inside.slice(comma + 1)), parameter),
    parameter,
    tMin: range.min,
    tMax: range.max,
    points: [],
  };
}

// MARK: - The expression language: tokens

/**
 * A token.
 *
 * `kind` is one of `number`, `name`, `operator`, `(`, `)`, `,`, `end`; `text`
 * carries the spelling of a name or an operator and `value` the value of a
 * number. One flat record rather than a union, because the parser only ever
 * asks two questions of a token and a union would cost every port a downcast.
 */
interface Token {
  kind: string;
  text: string;
  value: number;
}

const TOKEN_NUMBER = 'number';
const TOKEN_NAME = 'name';
const TOKEN_OPERATOR = 'operator';
const TOKEN_OPEN = '(';
const TOKEN_CLOSE = ')';
const TOKEN_COMMA = ',';
const TOKEN_END = 'end';

/** The two-character operators, longest match first — `<=` before `<`. */
const LONG_OPERATORS = ['||', '&&', '==', '!=', '<=', '>='];
const SHORT_OPERATORS = ['+', '-', '*', '/', '%', '^', '<', '>', '!'];

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const c = text.charAt(index);
    if (isSpace(c)) {
      index++;
      continue;
    }
    if (isDigit(c) || (c === '.' && index + 1 < text.length && isDigit(text.charAt(index + 1)))) {
      const scanned = scanNumber(text, index);
      tokens.push({ kind: TOKEN_NUMBER, text: text.slice(index, scanned.end), value: scanned.value });
      index = scanned.end;
      continue;
    }
    if (isIdentifierStart(c)) {
      const start = index;
      while (index < text.length && isIdentifierPart(text.charAt(index))) index++;
      tokens.push({ kind: TOKEN_NAME, text: text.slice(start, index), value: 0 });
      continue;
    }
    if (c === '(') {
      tokens.push({ kind: TOKEN_OPEN, text: c, value: 0 });
      index++;
      continue;
    }
    if (c === ')') {
      tokens.push({ kind: TOKEN_CLOSE, text: c, value: 0 });
      index++;
      continue;
    }
    if (c === ',') {
      tokens.push({ kind: TOKEN_COMMA, text: c, value: 0 });
      index++;
      continue;
    }
    const two = index + 1 < text.length ? text.slice(index, index + 2) : '';
    if (two.length === 2 && contains(LONG_OPERATORS, two)) {
      tokens.push({ kind: TOKEN_OPERATOR, text: two, value: 0 });
      index += 2;
      continue;
    }
    if (contains(SHORT_OPERATORS, c)) {
      tokens.push({ kind: TOKEN_OPERATOR, text: c, value: 0 });
      index++;
      continue;
    }
    throw new PlotError(`unexpected character '${c}'`);
  }
  tokens.push({ kind: TOKEN_END, text: '', value: 0 });
  return tokens;
}

/**
 * A number literal: `123`, `1.5`, `.5`, `5.`, `1e-3`, `1.2E+4`. No hex, no
 * digit separators.
 *
 * The digits are handed to the platform's own decimal→binary conversion, which
 * is correctly rounded everywhere this ships (it is the one place where the
 * platform is more trustworthy than anything written by hand).
 */
function scanNumber(text: string, start: number): { end: number; value: number } {
  let index = start;
  while (index < text.length && isDigit(text.charAt(index))) index++;
  if (index < text.length && text.charAt(index) === '.') {
    index++;
    while (index < text.length && isDigit(text.charAt(index))) index++;
  }
  if (index < text.length && (text.charAt(index) === 'e' || text.charAt(index) === 'E')) {
    let lookahead = index + 1;
    if (lookahead < text.length && (text.charAt(lookahead) === '+' || text.charAt(lookahead) === '-')) {
      lookahead++;
    }
    if (lookahead < text.length && isDigit(text.charAt(lookahead))) {
      index = lookahead;
      while (index < text.length && isDigit(text.charAt(index))) index++;
    }
  }
  const literal = text.slice(start, index);
  const value = Number(literal);
  if (Number.isNaN(value)) throw new PlotError(`'${literal}' is not a number`);
  return { end: index, value };
}

// MARK: - The expression language: the tree

/**
 * An expression node.
 *
 * `kind` is `number`, `variable`, `unary`, `binary` or `call`. As with
 * {@link Token} this is one record with the fields each kind uses, so the tree
 * ports to Swift and Kotlin without generics.
 */
export interface Node {
  kind: string;
  /** `number`. */
  value: number;
  /** `variable` (its name), `unary` / `binary` (the operator), `call` (the function). */
  text: string;
  /** `unary` (the operand), `binary` (the left side). */
  left: Node | null;
  /** `binary`. */
  right: Node | null;
  /** `call`. */
  arguments: Node[];
}

function numberNode(value: number): Node {
  return { kind: 'number', value, text: '', left: null, right: null, arguments: [] };
}

function variableNode(name: string): Node {
  return { kind: 'variable', value: 0, text: name, left: null, right: null, arguments: [] };
}

function unaryNode(operator: string, operand: Node): Node {
  return { kind: 'unary', value: 0, text: operator, left: operand, right: null, arguments: [] };
}

function binaryNode(operator: string, left: Node, right: Node): Node {
  return { kind: 'binary', value: 0, text: operator, left, right, arguments: [] };
}

function callNode(name: string, args: Node[]): Node {
  return { kind: 'call', value: 0, text: name, left: null, right: null, arguments: args };
}

/**
 * The function roster — exactly the site's names and arity, and nothing else.
 *
 * `min`, `max`, `if`, `log` and evalexpr's other builtins are deliberately
 * absent: the roster is the contract four implementations share, and a name
 * that works in one of them and not the others is worse than a name that works
 * in none.
 */
const FUNCTIONS = [
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'sqrt', 'cbrt', 'abs', 'exp', 'exp2', 'ln', 'log2', 'log10',
  'floor', 'ceil', 'round',
  'atan2', 'pow', 'hypot',
];

/** The three two-argument functions; everything else in {@link FUNCTIONS} takes one. */
const BINARY_FUNCTIONS = ['atan2', 'pow', 'hypot'];

function arity(name: string): number {
  return contains(BINARY_FUNCTIONS, name) ? 2 : 1;
}

/** Precedence, loosest to tightest. `^` is the only right-associative level. */
function precedence(operator: string): number {
  if (operator === '||') return 1;
  if (operator === '&&') return 2;
  if (operator === '==' || operator === '!=') return 3;
  if (operator === '<' || operator === '<=' || operator === '>' || operator === '>=') return 3;
  if (operator === '+' || operator === '-') return 4;
  if (operator === '*' || operator === '/' || operator === '%') return 5;
  if (operator === '^') return 6;
  return 0;
}

const POWER_PRECEDENCE = 6;

/**
 * Parse `text` as an expression in which `variable` is the only free name
 * (besides the constants `pi` and `e`). Pass `''` for a constant expression.
 *
 * Precedence climbing, hand-written — no dependency, and the same twenty lines
 * in every port.
 */
export function parseExpression(text: string, variable: string): Node {
  const parser = new Parser(tokenize(text), variable);
  const node = parser.expression(1);
  parser.expectEnd();
  return node;
}

class Parser {
  private readonly tokens: Token[];
  private readonly variable: string;
  private index = 0;
  private depth = 0;
  private nodes = 0;

  constructor(tokens: Token[], variable: string) {
    this.tokens = tokens;
    this.variable = variable;
  }

  /** Charge one node against the budget, so a flat chain cannot outrun the depth guard. */
  private count(): void {
    if (++this.nodes > MAX_NODES) throw new PlotError('expression too large');
  }

  expression(minimum: number): Node {
    if (++this.depth > MAX_DEPTH) throw new PlotError('expression nested too deeply');
    try {
      return this.expressionInner(minimum);
    } finally {
      this.depth--;
    }
  }

  private expressionInner(minimum: number): Node {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      if (token.kind !== TOKEN_OPERATOR) break;
      const level = precedence(token.text);
      if (level === 0 || level < minimum) break;
      this.index++;
      // `^` is RIGHT-associative — `2^3^2` is 2^(3^2) = 512. The site's
      // evalexpr makes it left-associative and answers 64; this is the
      // deliberate divergence, not an accident of the algorithm.
      const next = token.text === '^' ? level : level + 1;
      const right = this.expression(next);
      this.count();
      left = binaryNode(token.text, left, right);
    }
    return left;
  }

  private unary(): Node {
    const token = this.peek();
    if (token.kind === TOKEN_OPERATOR && (token.text === '-' || token.text === '+' || token.text === '!')) {
      this.index++;
      // The operand is parsed at the `^` level, which is what makes unary minus
      // bind *looser* than exponentiation: `-x^2` is −(x²), and `-2^2` is −4.
      const operand = this.expression(POWER_PRECEDENCE);
      this.count();
      return unaryNode(token.text, operand);
    }
    return this.primary();
  }

  private primary(): Node {
    const token = this.peek();
    if (token.kind === TOKEN_NUMBER) {
      this.index++;
      return numberNode(token.value);
    }
    if (token.kind === TOKEN_OPEN) {
      this.index++;
      const inner = this.expression(1);
      if (this.peek().kind !== TOKEN_CLOSE) throw new PlotError("expected ')'");
      this.index++;
      return inner;
    }
    if (token.kind === TOKEN_NAME) {
      this.index++;
      return this.name(token.text);
    }
    if (token.kind === TOKEN_END) throw new PlotError('the expression ends too early');
    if (token.kind === TOKEN_CLOSE) throw new PlotError("unmatched ')'");
    throw new PlotError(`unexpected '${token.text}'`);
  }

  private name(spelling: string): Node {
    if (this.peek().kind === TOKEN_OPEN) {
      if (!contains(FUNCTIONS, spelling)) throw new PlotError(`unknown function '${spelling}'`);
      this.index++;
      const args: Node[] = [];
      if (this.peek().kind !== TOKEN_CLOSE) {
        args.push(this.expression(1));
        while (this.peek().kind === TOKEN_COMMA) {
          this.index++;
          args.push(this.expression(1));
        }
      }
      if (this.peek().kind !== TOKEN_CLOSE) throw new PlotError("expected ')'");
      this.index++;
      const wanted = arity(spelling);
      if (args.length !== wanted) {
        throw new PlotError(
          `${spelling} takes ${wanted} argument${wanted === 1 ? '' : 's'}, not ${args.length}`,
        );
      }
      return callNode(spelling, args);
    }
    if (spelling === 'pi' || spelling === 'e') return numberNode(spelling === 'pi' ? Math.PI : Math.E);
    if (this.variable.length > 0 && spelling === this.variable) return variableNode(spelling);
    if (contains(FUNCTIONS, spelling)) throw new PlotError(`${spelling} is a function — write ${spelling}(…)`);
    throw new PlotError(`unknown name '${spelling}'`);
  }

  expectEnd(): void {
    const token = this.peek();
    if (token.kind === TOKEN_END) return;
    if (token.kind === TOKEN_CLOSE) throw new PlotError("unmatched ')'");
    throw new PlotError(`unexpected '${token.text}'`);
  }

  private peek(): Token {
    return this.tokens[this.index];
  }
}

// MARK: - Evaluation

/**
 * Evaluate `node` with `variable` bound to `value`.
 *
 * Every value is an IEEE-754 double and **evaluation never fails**: a domain
 * error is NaN or ±∞, which breaks the curve where it happens rather than
 * failing the block. Everything that can be wrong about an expression —
 * an unknown name, the wrong number of arguments, a missing parenthesis — was
 * settled once, at parse time.
 *
 * Comparisons and the Boolean operators yield 1.0 and 0.0, which is the second
 * deliberate divergence from the site: there they produce a Boolean the eval
 * closure discards, so `(x > 0) * sqrt(x)` draws nothing at all.
 */
export function evaluate(node: Node, variable: string, value: number): number {
  if (node.kind === 'number') return node.value;
  if (node.kind === 'variable') return node.text === variable ? value : Number.NaN;
  if (node.kind === 'unary') {
    const operand = evaluate(node.left as Node, variable, value);
    if (node.text === '-') return -operand;
    if (node.text === '+') return operand;
    return operand === 0 ? 1 : 0;
  }
  if (node.kind === 'binary') {
    const left = evaluate(node.left as Node, variable, value);
    const right = evaluate(node.right as Node, variable, value);
    return binary(node.text, left, right);
  }
  // A call.
  const first = evaluate(node.arguments[0], variable, value);
  if (node.arguments.length === 2) {
    const second = evaluate(node.arguments[1], variable, value);
    if (node.text === 'atan2') return Math.atan2(first, second);
    if (node.text === 'pow') return powIEEE(first, second);
    return Math.hypot(first, second);
  }
  return unary(node.text, first);
}

/**
 * `pow`, with the five special cases JavaScript answers NaN to.
 *
 * C99 §F.9.4.4 and IEEE 754-2019 §9.2 agree: `pow(+1, y)` is 1 for **every** y,
 * NaN included, and `pow(±1, ±inf)` is 1. Swift's `pow` and Rust's `powf` — the
 * site's own arithmetic — follow that. JavaScript and Java do not: ECMA-262's
 * Number::exponentiate returns NaN as soon as the exponent is NaN, and again
 * when the base has magnitude 1 and the exponent is infinite, and Java's
 * `Math.pow` answers the same. So the four ports split 2-vs-2 on exactly these
 * five inputs, and on no others:
 *
 *     pow(1, NaN)  pow(1, +inf)  pow(1, -inf)  pow(-1, +inf)  pow(-1, -inf)
 *
 * SPEC §1.3 says everything here is an IEEE-754 double, and one raised to
 * anything is one, so Swift and Rust are right and this is where the JavaScript
 * reference is brought into line. The Kotlin port needs the same three lines
 * for the same reason; Swift and Rust need none.
 * Nothing else moves: `pow(NaN, 0)` is already 1 everywhere, `pow(-1, NaN)` is
 * NaN everywhere, and every finite pair already agrees to the bit.
 *
 * Both spellings route through here — the `pow(a, b)` call in {@link evaluate}
 * and the `^` operator in {@link binary} — because a document must not be able
 * to tell them apart either.
 */
function powIEEE(base: number, exponent: number): number {
  if (base === 1) return 1;
  if (base === -1 && (exponent === Number.POSITIVE_INFINITY || exponent === Number.NEGATIVE_INFINITY)) {
    return 1;
  }
  return Math.pow(base, exponent);
}

function binary(operator: string, left: number, right: number): number {
  if (operator === '+') return left + right;
  if (operator === '-') return left - right;
  if (operator === '*') return left * right;
  // Division is real division: `5/2` is 2.5. evalexpr's integer division
  // answers 2, which is a trap in a plotting language.
  if (operator === '/') return left / right;
  if (operator === '%') return left % right;
  if (operator === '^') return powIEEE(left, right);
  if (operator === '==') return left === right ? 1 : 0;
  if (operator === '!=') return left !== right ? 1 : 0;
  if (operator === '<') return left < right ? 1 : 0;
  if (operator === '<=') return left <= right ? 1 : 0;
  if (operator === '>') return left > right ? 1 : 0;
  if (operator === '>=') return left >= right ? 1 : 0;
  if (operator === '&&') return left !== 0 && right !== 0 ? 1 : 0;
  return left !== 0 || right !== 0 ? 1 : 0;
}

function unary(name: string, v: number): number {
  if (name === 'sin') return Math.sin(v);
  if (name === 'cos') return Math.cos(v);
  if (name === 'tan') return Math.tan(v);
  if (name === 'asin') return Math.asin(v);
  if (name === 'acos') return Math.acos(v);
  if (name === 'atan') return Math.atan(v);
  if (name === 'sinh') return Math.sinh(v);
  if (name === 'cosh') return Math.cosh(v);
  if (name === 'tanh') return Math.tanh(v);
  if (name === 'asinh') return Math.asinh(v);
  if (name === 'acosh') return Math.acosh(v);
  if (name === 'atanh') return Math.atanh(v);
  if (name === 'sqrt') return Math.sqrt(v);
  if (name === 'cbrt') return Math.cbrt(v);
  if (name === 'abs') return Math.abs(v);
  if (name === 'exp') return Math.exp(v);
  if (name === 'exp2') return Math.pow(2, v);
  if (name === 'ln') return Math.log(v);
  if (name === 'log2') return Math.log2(v);
  if (name === 'log10') return Math.log10(v);
  // floor / ceil / round DRAW. On the site they silently produce nothing:
  // `preprocess_math_expr` rewrites every roster name to `math::…` while
  // evalexpr binds exactly these three bare, so `math::floor` is unbound and
  // all 1001 samples fail. `round` is ties-away-from-zero, as Rust's is —
  // never the platform's ties-to-even or ties-up rounding.
  if (name === 'floor') return Math.floor(v);
  if (name === 'ceil') return Math.ceil(v);
  return roundTiesAway(v);
}

// MARK: - Drawing

/** The palette, purple first so a one-series plot matches the site's colour. */
const PALETTE = ['#673AB7', '#E5390F', '#0F9D58', '#F4B400', '#00838F', '#C2185B', '#5D4037', '#455A64'];

/** The site's margin, and the room each extra asks for beyond it. */
const MARGIN = 40;
const TITLE_ROOM = 24;
const AXIS_LABEL_ROOM = 18;
const LEGEND_MINIMUM = 72;
const LEGEND_PADDING = 28;
const LEGEND_FONT = 11;
/** Never let the extras eat the figure: the plot area keeps at least this. */
const MIN_PLOT = 40;

/** One sampled point of a series, and whether it may be drawn. */
interface Sample {
  x: number;
  y: number;
}

function draw(spec: PlotSpec): string {
  // Sample first: `y: auto` fits the range to what the series actually produce,
  // so the samples have to exist before the geometry does. They are kept and
  // reused for the drawing pass — sampling twice would be both slower and one
  // more chance for the two passes to disagree.
  const sampled: Sample[][] = [];
  for (const series of spec.series) sampled.push(sample(series, spec));

  const yRange = resolveY(spec, sampled);
  const yMin = yRange.min;
  const yMax = yRange.max;

  const labels: string[] = [];
  for (const series of spec.series) labels.push(series.label !== null ? series.label : series.source);
  const showLegend =
    spec.legend === 'on' ||
    (spec.legend === 'auto' && (spec.series.length >= 2 || hasExplicitLabel(spec.series)));

  const width = spec.width;
  const height = spec.height;

  let legendWidth = 0;
  if (showLegend) {
    let longest = 0;
    for (const label of labels) longest = Math.max(longest, textWidth(label, LEGEND_FONT));
    legendWidth = Math.max(LEGEND_MINIMUM, Math.ceil(longest) + LEGEND_PADDING);
    legendWidth = Math.min(legendWidth, Math.max(0, width - 2 * MARGIN - MIN_PLOT));
    if (legendWidth < LEGEND_MINIMUM / 2) legendWidth = 0;
  }

  const horizontal = fitMargins(
    width,
    MARGIN + (spec.yLabel.length > 0 ? AXIS_LABEL_ROOM : 0),
    MARGIN + legendWidth,
  );
  const vertical = fitMargins(
    height,
    MARGIN + (spec.title.length > 0 ? TITLE_ROOM : 0),
    MARGIN + (spec.xLabel.length > 0 ? AXIS_LABEL_ROOM : 0),
  );
  const left = horizontal.low;
  const top = vertical.low;
  const plotW = width - left - horizontal.high;
  const plotH = height - top - vertical.high;

  const xMin = spec.xMin;
  const xMax = spec.xMax;
  const sx = (x: number): number => left + ((x - xMin) / (xMax - xMin)) * plotW;
  const sy = (y: number): number => top + ((yMax - y) / (yMax - yMin)) * plotH;

  const xStep = niceStep(xMax - xMin);
  const yStep = niceStep(yMax - yMin);
  const xTicks = ticks(xMin, xMax, xStep);
  const yTicks = ticks(yMin, yMax, yStep);

  let out = '';
  out += `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"`;
  out += ` width="${width}" height="${height}" role="img">`;
  // The accessible name. No `id` anywhere in this SVG, deliberately: a document
  // may hold two plots, VS Code patches its preview with morphdom, and a
  // duplicated id is how one figure ends up wearing another's clip path. An
  // `<svg role="img">` takes its name from its own `<title>` with no
  // `aria-labelledby` to point at, so there is nothing to number.
  out += `<title>${escapeHTML(accessibleName(spec, labels))}</title>`;

  // Ink is `currentColor` with opacity throughout — never the site's #e0e0e0 /
  // #999 / #666 / #ccc. `renderBlock` is theme-blind in all four repos, so the
  // one SVG has to be right in the light preview, the dark preview, print, an
  // exported page and a saved standalone file. `currentColor` is what does
  // that; a baked grey is a light-mode assumption. For the same reason there is
  // no `style="background:white"` on the root, and no `<style>` element: SVG
  // `<style>` inside an HTML document is document-scoped and leaks.
  if (spec.grid) {
    out += '<g stroke="currentColor" stroke-width="0.5" opacity="0.15">';
    for (const tick of xTicks) {
      const at = fixed(sx(tick), 1);
      out += `<line x1="${at}" y1="${fixed(top, 1)}" x2="${at}" y2="${fixed(top + plotH, 1)}"/>`;
    }
    for (const tick of yTicks) {
      const at = fixed(sy(tick), 1);
      out += `<line x1="${fixed(left, 1)}" y1="${at}" x2="${fixed(left + plotW, 1)}" y2="${at}"/>`;
    }
    out += '</g>';
  }

  if (spec.axes) {
    out += '<g stroke="currentColor" stroke-width="1" opacity="0.4">';
    if (yMin <= 0 && yMax >= 0) {
      const at = fixed(sy(0), 1);
      out += `<line x1="${fixed(left, 1)}" y1="${at}" x2="${fixed(left + plotW, 1)}" y2="${at}"/>`;
    }
    if (xMin <= 0 && xMax >= 0) {
      const at = fixed(sx(0), 1);
      out += `<line x1="${at}" y1="${fixed(top, 1)}" x2="${at}" y2="${fixed(top + plotH, 1)}"/>`;
    }
    out += '</g>';

    out += '<g font-size="10" fill="currentColor" opacity="0.65" font-family="sans-serif">';
    for (const tick of xTicks) {
      out +=
        `<text x="${fixed(sx(tick), 1)}" y="${fixed(top + plotH + 15, 1)}" text-anchor="middle">` +
        `${escapeHTML(formatLabel(tick))}</text>`;
    }
    for (const tick of yTicks) {
      out +=
        `<text x="${fixed(left - 5, 1)}" y="${fixed(sy(tick), 1)}" text-anchor="end" ` +
        `dominant-baseline="middle">${escapeHTML(formatLabel(tick))}</text>`;
    }
    out += '</g>';

    out +=
      `<rect x="${fixed(left, 1)}" y="${fixed(top, 1)}" width="${fixed(plotW, 1)}" ` +
      `height="${fixed(plotH, 1)}" fill="none" stroke="currentColor" stroke-width="1" opacity="0.25"/>`;
  }

  if (spec.title.length > 0) {
    out +=
      // Centred on the plot area, not on the canvas: the xlabel below is, and
      // a legend gutter would otherwise push the two out of line with each
      // other.
      `<text x="${fixed(left + plotW / 2, 1)}" y="${fixed(top - 14, 1)}" text-anchor="middle" ` +
      `font-size="13" font-weight="600" fill="currentColor" opacity="0.85" ` +
      `font-family="sans-serif">${escapeHTML(spec.title)}</text>`;
  }
  if (spec.xLabel.length > 0) {
    out +=
      `<text x="${fixed(left + plotW / 2, 1)}" y="${fixed(height - 8, 1)}" text-anchor="middle" ` +
      `font-size="11" fill="currentColor" opacity="0.85" font-family="sans-serif">` +
      `${escapeHTML(spec.xLabel)}</text>`;
  }
  if (spec.yLabel.length > 0) {
    const x = fixed(14, 1);
    const y = fixed(top + plotH / 2, 1);
    out +=
      `<text x="${x}" y="${y}" text-anchor="middle" transform="rotate(-90 ${x} ${y})" ` +
      `font-size="11" fill="currentColor" opacity="0.85" font-family="sans-serif">` +
      `${escapeHTML(spec.yLabel)}</text>`;
  }

  for (let index = 0; index < spec.series.length; index++) {
    out += polylines(sampled[index], spec.series[index], colour(index), sx, sy, xMin, xMax, yMin, yMax);
  }

  if (legendWidth > 0) {
    const x = width - horizontal.high + 8;
    out += '<g font-size="11" font-family="sans-serif">';
    for (let index = 0; index < labels.length; index++) {
      const y = top + 12 + index * 16;
      out +=
        `<line x1="${fixed(x, 1)}" y1="${fixed(y - 4, 1)}" x2="${fixed(x + 14, 1)}" ` +
        `y2="${fixed(y - 4, 1)}" stroke="${colour(index)}" stroke-width="2"/>`;
      out +=
        `<text x="${fixed(x + 20, 1)}" y="${fixed(y, 1)}" fill="currentColor" opacity="0.85">` +
        `${escapeHTML(labels[index])}</text>`;
    }
    out += '</g>';
  }

  out += '</svg>';
  return out;
}

/**
 * The polylines of one series.
 *
 * A point is drawable when it is finite **and** inside the window. Anything
 * else ends the current run and the next drawable point starts a new one —
 * which is what makes `tan(x)` seven branches instead of one figure-wide spike.
 * A run of a single point is still emitted, exactly as the site emits it.
 */
function polylines(
  samples: Sample[],
  series: Series,
  stroke: string,
  sx: (x: number) => number,
  sy: (y: number) => number,
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number,
): string {
  let out = '';
  let run = '';
  let started = false;
  const marks: string[] = [];
  for (const point of samples) {
    const drawable =
      isFiniteNumber(point.x) &&
      isFiniteNumber(point.y) &&
      point.x >= xMin &&
      point.x <= xMax &&
      point.y >= yMin &&
      point.y <= yMax;
    if (drawable) {
      const at = `${fixed(sx(point.x), 2)},${fixed(sy(point.y), 2)}`;
      run += started ? ` ${at}` : at;
      started = true;
      if (series.kind === 'points') {
        marks.push(
          `<circle cx="${fixed(sx(point.x), 2)}" cy="${fixed(sy(point.y), 2)}" r="2.5" fill="${stroke}"/>`,
        );
      }
    } else if (started) {
      out += `<polyline points="${run}" fill="none" stroke="${stroke}" stroke-width="2"/>`;
      run = '';
      started = false;
    }
  }
  if (run.length > 0) {
    out += `<polyline points="${run}" fill="none" stroke="${stroke}" stroke-width="2"/>`;
  }
  for (const mark of marks) out += mark;
  return out;
}

/**
 * The samples of one series.
 *
 * `x_i = xMin + (i / samples) * (xMax - xMin)`, `i` in `0…samples` **inclusive**
 * — that expression and not the cheaper `xMin + i * dx`, which differs in the
 * last bits for 221 of the 1001 default samples and does change the output.
 */
function sample(series: Series, spec: PlotSpec): Sample[] {
  const out: Sample[] = [];
  if (series.kind === 'points') {
    for (const point of series.points) out.push({ x: point.x, y: point.y });
    return out;
  }
  if (series.kind === 'parametric') {
    const span = series.tMax - series.tMin;
    for (let i = 0; i <= spec.samples; i++) {
      const t = series.tMin + (i / spec.samples) * span;
      out.push({
        x: evaluate(series.expression as Node, series.parameter, t),
        y: evaluate(series.yExpression as Node, series.parameter, t),
      });
    }
    return out;
  }
  const span = spec.xMax - spec.xMin;
  for (let i = 0; i <= spec.samples; i++) {
    const x = spec.xMin + (i / spec.samples) * span;
    out.push({ x, y: evaluate(series.expression as Node, 'x', x) });
  }
  return out;
}

/**
 * `y: auto` — fit the finite samples, then pad 5 % on each side.
 *
 * A series that produces nothing finite contributes nothing; when no series
 * does, the range falls back to −1…1. A flat series has no span to take 5 % of,
 * so it is padded by 5 % of its own value, or by 1 when that is zero too.
 */
function resolveY(spec: PlotSpec, sampled: Sample[][]): { min: number; max: number } {
  if (spec.yMin !== null && spec.yMax !== null) return { min: spec.yMin, max: spec.yMax };
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const samples of sampled) {
    for (const point of samples) {
      if (!isFiniteNumber(point.y)) continue;
      if (point.y < low) low = point.y;
      if (point.y > high) high = point.y;
    }
  }
  if (!isFiniteNumber(low) || !isFiniteNumber(high)) return { min: -1, max: 1 };
  const span = high - low;
  if (span > 0) return padded(low - span * 0.05, high + span * 0.05, low, high);
  const padding = Math.abs(high) * 0.05;
  const pad = padding > 0 ? padding : 1;
  return padded(low - pad, high + pad, low, high);
}

/**
 * The padded range, or the unpadded one when padding overflowed to infinity.
 *
 * `high - low` overflows for a series straddling ~1e308, and `high + pad`
 * overflows for a flat series above ~1.71e308. Either way every `sy()` would
 * come out NaN and the emitted polyline would read `points="40.00,NaN …"` — a
 * curve that silently vanishes with no `plot:` line to explain it. Falling
 * back to the unpadded bounds keeps such a plot drawable; if even those are
 * not finite the caller's `-1..1` default has already been returned.
 */
function padded(min: number, max: number, low: number, high: number): { min: number; max: number } {
  if (isFiniteNumber(min) && isFiniteNumber(max) && max > min) return bounded(min, max);
  if (high > low) return bounded(low, high);
  return bounded(low - 1, high + 1);
}

/**
 * A range whose *width* is finite, not merely whose ends are.
 *
 * `sy()` divides by `yMax - yMin`, so a series spanning ~1e308 makes that
 * subtraction overflow even though both bounds are ordinary doubles — and then
 * every coordinate is NaN and the curve silently vanishes. Clamping each end to
 * a quarter of MAX_VALUE keeps the width representable; anything beyond is
 * outside the window and the break rule already omits it, which is the same
 * treatment any other out-of-range point gets.
 */
function bounded(min: number, max: number): { min: number; max: number } {
  if (!(max > min)) return { min: -1, max: 1 };
  // Only a range whose *width* overflows needs help. Halving both ends halves
  // the width — both ends are finite here, so this always terminates in one
  // step — and leaves a genuinely huge but narrow range such as
  // [1.69e308, 1.71e308] exactly as the author asked for it.
  if (isFiniteNumber(max - min)) return { min, max };
  return { min: min / 2, max: max / 2 };
}

function accessibleName(spec: PlotSpec, labels: string[]): string {
  if (spec.title.length > 0) return spec.title;
  if (labels.length === 0) return 'Plot';
  return `Plot of ${labels.join(', ')}`;
}

function hasExplicitLabel(series: Series[]): boolean {
  for (const one of series) if (one.label !== null) return true;
  return false;
}

function colour(index: number): string {
  return PALETTE[index % PALETTE.length];
}

/**
 * An estimate of a string's width at `size` pixels, for the legend gutter only.
 *
 * 0.6 em per character is the usual approximation for a sans-serif face and
 * needs no font metrics, which is what keeps this module free of the platform.
 * It is used to reserve space, never to position anything, so an estimate that
 * is a few pixels out costs a few pixels of gutter.
 */
function textWidth(text: string, size: number): number {
  return countCharacters(text) * size * 0.6;
}

/**
 * Two margins that leave at least {@link MIN_PLOT} between them.
 *
 * Without this a 160 × 120 figure carrying a title, both axis labels and a
 * legend would compute a negative plot area and draw itself inside out.
 */
function fitMargins(total: number, low: number, high: number): { low: number; high: number } {
  if (total - low - high >= MIN_PLOT) return { low, high };
  const room = Math.max(0, total - MIN_PLOT);
  const sum = low + high;
  if (sum <= 0) return { low: 0, high: 0 };
  const scaled = Math.floor((room * low) / sum);
  return { low: scaled, high: room - scaled };
}

// MARK: - Axes

/**
 * The site's tick spacing, ported exactly.
 *
 * ```
 * rough = range / 8 ; mag = 10^floor(log10 rough) ; norm = rough / mag
 * step  = (norm<=1.5 ? 1 : norm<=3 ? 2 : norm<=7 ? 5 : 10) * mag
 * ```
 */
export function niceStep(range: number): number {
  const rough = range / 8;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalised = rough / magnitude;
  let step = 10;
  if (normalised <= 1.5) step = 1;
  else if (normalised <= 3) step = 2;
  else if (normalised <= 7) step = 5;
  return step * magnitude;
}

/** How far past `max` a tick may land and still be drawn: one part in 10⁹ of a step. */
const TICK_EPSILON = 1e-9;
/** A safety valve. `niceStep` gives eight to eleven ticks; a thousand is a bug. */
const MAX_TICKS = 1000;

/**
 * The ticks of one axis.
 *
 * **Computed by index, never accumulated.** The site does `gx += step`, which
 * on `[-1, 1]` at step 0.2 reaches −5.55e−17 instead of 0 and prints the tick
 * at the origin as "-5.6e-17". `first + i * step` lands on an exact zero
 * wherever the arithmetic can, which is the whole fix.
 *
 * The epsilon is the other half of it: a tick that *is* the maximum can miss it
 * by one ulp (`[0.0001, 0.0009]` at step 0.0001 computes 9.000000000000001e-4),
 * and dropping the last tick of an axis because of a rounding error is a
 * visible defect.
 */
export function ticks(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  if (!(step > 0) || !isFiniteNumber(step)) return out;
  const first = Math.ceil(min / step) * step;
  const limit = max + step * TICK_EPSILON;
  for (let i = 0; i < MAX_TICKS; i++) {
    const tick = first + i * step;
    if (tick > limit) break;
    out.push(tick);
  }
  return out;
}

/**
 * A tick's label, ported from the site's `format_label` **with the two
 * corrections its own output argues for**:
 *
 * ```
 * v == 0                      -> "0"
 * |v| >= 1000 or |v| < 0.01   -> exponential, one fraction digit
 * |v - round(v)| < 1e-9       -> integer, ROUNDED (the site truncates)
 * otherwise                   -> two fraction digits
 * ```
 *
 * The site prints `val as i64`, which truncates: a tick at −4 that arrives as
 * −3.9999999999999996 prints "-3", out of order, in the middle of the axis.
 */
export function formatLabel(v: number): string {
  if (v === 0) return '0';
  if (Number.isNaN(v)) return formatFixed(v, 2);
  const magnitude = Math.abs(v);
  if (magnitude >= 1000 || magnitude < 0.01) return formatExponential(v, 1);
  const rounded = roundTiesAway(v);
  if (Math.abs(v - rounded) < 1e-9) return formatFixed(rounded, 0);
  return formatFixed(v, 2);
}

// MARK: - Number formatting, by hand

/**
 * Significant digits taken from the *exact* binary value.
 *
 * Twenty-five is enough to decide any rounding this file performs, and the
 * argument is worth writing down because every port depends on it. A double is
 * a dyadic rational m/2^k; a decimal tie at the second significant digit (or at
 * the second fraction digit) is a rational k/10^m with a small m. Two such
 * numbers that are not equal differ by at least 1/(2^52 · 10^m) — about 10⁻¹⁸
 * relatively — which is a hundred million times larger than the 10⁻²⁵ the last
 * of these digits resolves. So a digit string that reads "…5000…0" here *is* an
 * exact tie, and ties-to-even is safe to apply to it.
 *
 * Getting these digits is the one platform call that has to be right:
 *
 *   * TypeScript — `toExponential(24)`, which ECMA-262 defines as correctly
 *     rounded from the exact value.
 *   * Swift — `String(format: "%.24e", v)`; the C library converts exactly.
 *   * Kotlin — `java.math.BigDecimal(v)`, which is exact by construction.
 *     **Not** `String.format("%.24e", v)`: Java's Formatter pads with zeros
 *     past the seventeenth digit, which would turn 0.0125 (really
 *     0.012500000000000000693…) into an exact tie and round it the wrong way.
 */
const SIGNIFICANT_DIGITS = 25;

function significantDigits(value: number): { digits: string; exponent: number } {
  const text = value.toExponential(SIGNIFICANT_DIGITS - 1);
  const marker = text.indexOf('e');
  const mantissa = text.slice(0, marker);
  const exponent = Number(text.slice(marker + 1));
  let digits = '';
  for (let index = 0; index < mantissa.length; index++) {
    const c = mantissa.charAt(index);
    if (c !== '.') digits += c;
  }
  return { digits, exponent };
}

/**
 * Rust's `{:.<n>e}` — `1.0e3`, `-5.0e-3`, `4.9e-324`.
 *
 * No `+` on the exponent and no zero padding (C and Java write `1.0e+03`), and
 * ties round to even on the exact value (JavaScript's own `toExponential`
 * rounds 1250 up to `1.3e+3`, where Rust writes `1.2e3`).
 */
export function formatExponential(v: number, fractionDigits: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Number.POSITIVE_INFINITY) return 'inf';
  if (v === Number.NEGATIVE_INFINITY) return '-inf';
  const sign = isNegative(v) ? '-' : '';
  const magnitude = Math.abs(v);
  if (magnitude === 0) {
    return `${sign}0${fractionDigits > 0 ? `.${zeros(fractionDigits)}` : ''}e0`;
  }
  const scanned = significantDigits(magnitude);
  const rounded = roundDigits(scanned.digits, fractionDigits + 1);
  const exponent = scanned.exponent + (rounded.overflow ? 1 : 0);
  const digits = rounded.digits;
  const fraction = fractionDigits > 0 ? `.${digits.slice(1)}` : '';
  return `${sign}${digits.charAt(0)}${fraction}e${exponent}`;
}

/**
 * Rust's `{:.<n>}` — `2.50`, `-0.00`, `1000.00`.
 *
 * Ties to even on the exact value: 0.125 is `0.12` and 8.125 is `8.12`, where
 * `toFixed` writes `0.13` and `8.13`. The sign survives a rounded-away zero
 * (`-0.00`), which is what Rust prints and what keeps the two comparable.
 */
export function formatFixed(v: number, fractionDigits: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Number.POSITIVE_INFINITY) return 'inf';
  if (v === Number.NEGATIVE_INFINITY) return '-inf';
  const sign = isNegative(v) ? '-' : '';
  const magnitude = Math.abs(v);

  let whole = '0';
  let fraction = '';
  if (magnitude !== 0) {
    const scanned = significantDigits(magnitude);
    const wholeLength = scanned.exponent + 1;
    if (wholeLength <= 0) {
      fraction = zeros(-wholeLength) + scanned.digits;
    } else if (wholeLength >= scanned.digits.length) {
      whole = scanned.digits + zeros(wholeLength - scanned.digits.length);
    } else {
      whole = scanned.digits.slice(0, wholeLength);
      fraction = scanned.digits.slice(wholeLength);
    }
  }

  if (fraction.length <= fractionDigits) {
    fraction += zeros(fractionDigits - fraction.length);
  } else {
    const kept = fraction.slice(0, fractionDigits);
    const next = fraction.charCodeAt(fractionDigits) - 48;
    let up = next > 5;
    if (next === 5) {
      let more = false;
      for (let index = fractionDigits + 1; index < fraction.length; index++) {
        if (fraction.charAt(index) !== '0') {
          more = true;
          break;
        }
      }
      if (more) up = true;
      else {
        const previous =
          fractionDigits > 0
            ? fraction.charCodeAt(fractionDigits - 1) - 48
            : whole.charCodeAt(whole.length - 1) - 48;
        up = previous % 2 === 1;
      }
    }
    if (!up) {
      fraction = kept;
    } else {
      const carried = increment(kept);
      if (carried.overflow) {
        // `.99` + 1 is `1.00`: the fraction goes back to zeros and the carry
        // lands on the integer part, which is the one place a digit string is
        // allowed to grow (999 -> 1000).
        fraction = zeros(fractionDigits);
        whole = increment(whole).digits;
      } else {
        fraction = carried.digits;
      }
    }
  }

  return `${sign}${whole}${fractionDigits > 0 ? `.${fraction}` : ''}`;
}

/** `formatFixed`, for the coordinates the emitter writes. */
function fixed(v: number, fractionDigits: number): string {
  return formatFixed(v, fractionDigits);
}

/**
 * Round a digit string to `keep` digits, ties to even, reporting whether the
 * carry ran off the front — in which case the digits are `1` followed by zeros
 * and the caller owes the exponent a 1.
 */
function roundDigits(digits: string, keep: number): { digits: string; overflow: boolean } {
  if (keep >= digits.length) return { digits: digits + zeros(keep - digits.length), overflow: false };
  const kept = digits.slice(0, keep);
  const next = digits.charCodeAt(keep) - 48;
  let up = next > 5;
  if (next === 5) {
    let more = false;
    for (let index = keep + 1; index < digits.length; index++) {
      if (digits.charAt(index) !== '0') {
        more = true;
        break;
      }
    }
    if (more) up = true;
    else up = (digits.charCodeAt(keep - 1) - 48) % 2 === 1;
  }
  if (!up) return { digits: kept, overflow: false };
  const carried = increment(kept);
  if (!carried.overflow) return { digits: carried.digits, overflow: false };
  // "999" + 1 is "1000"; renormalised to `keep` digits that is "100" one
  // decimal place further left.
  return { digits: `1${zeros(keep - 1)}`, overflow: true };
}

/** `digits` + 1, keeping the length; `overflow` says the carry ran off the front. */
function increment(digits: string): { digits: string; overflow: boolean } {
  const out: string[] = [];
  for (let index = 0; index < digits.length; index++) out.push(digits.charAt(index));
  let index = out.length - 1;
  while (index >= 0) {
    if (out[index] === '9') {
      out[index] = '0';
      index--;
    } else {
      out[index] = String.fromCharCode(out[index].charCodeAt(0) + 1);
      return { digits: out.join(''), overflow: false };
    }
  }
  return { digits: `1${out.join('')}`, overflow: true };
}

/**
 * Rust's `f64::round`: halfway cases go away from zero.
 *
 * Not `Math.round`, which sends −2.5 to −2, and not the `floor(v + 0.5)` trick,
 * which sends 0.49999999999999994 to 1.
 */
function roundTiesAway(v: number): number {
  const whole = Math.trunc(v);
  const fraction = v - whole;
  if (fraction >= 0.5) return whole + 1;
  if (fraction <= -0.5) return whole - 1;
  return whole;
}

function isNegative(v: number): boolean {
  return v < 0 || (v === 0 && 1 / v < 0);
}

function zeros(count: number): string {
  return count > 0 ? '0'.repeat(count) : '';
}

// MARK: - Small string helpers
//
// Written out rather than reached for, because the four ports have four
// different ideas of what `trim` and `split` mean and the differences are
// exactly the kind that survive a code review.

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t';
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isLowerLetter(c: string): boolean {
  return c >= 'a' && c <= 'z';
}

function isIdentifierStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

function isIdentifierPart(c: string): boolean {
  return isIdentifierStart(c) || isDigit(c);
}

function isFiniteNumber(v: number): boolean {
  return !Number.isNaN(v) && v !== Number.POSITIVE_INFINITY && v !== Number.NEGATIVE_INFINITY;
}

function trim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text.charAt(start))) start++;
  while (end > start && isSpace(text.charAt(end - 1))) end--;
  return text.slice(start, end);
}

function lowercased(text: string): string {
  // The locale-independent one, never `toLocaleLowerCase`: a Turkish locale
  // spells `AUTO` with a dotless ı and the directive would stop matching.
  return text.toLowerCase();
}

/** Lines, on CRLF, LF or CR — the parser's own set, not the wide Unicode one. */
function splitLines(source: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let index = 0; index < source.length; index++) {
    const c = source.charAt(index);
    if (c === '\n') {
      out.push(current);
      current = '';
    } else if (c === '\r') {
      out.push(current);
      current = '';
      if (index + 1 < source.length && source.charAt(index + 1) === '\n') index++;
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

function splitWhitespace(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index++) {
    const c = text.charAt(index);
    if (isSpace(c)) {
      if (current.length > 0) out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function contains(list: readonly string[], value: string): boolean {
  for (const one of list) if (one === value) return true;
  return false;
}

/** The index of the first `first``second` pair, or −1. */
function indexOfPair(text: string, first: string, second: string): number {
  for (let index = 0; index + 1 < text.length; index++) {
    if (text.charAt(index) === first && text.charAt(index + 1) === second) return index;
  }
  return -1;
}

/** The index of the `)` matching the `(` at `open`, or −1. */
function matchingParenthesis(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const c = text.charAt(index);
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The index of the first comma at parenthesis depth 0, or −1. */
function topLevelComma(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const c = text.charAt(index);
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) return index;
  }
  return -1;
}

/** Does `text` begin with `word` as a whole word? */
function startsWithWord(text: string, word: string): boolean {
  if (text.length < word.length) return false;
  if (text.slice(0, word.length) !== word) return false;
  if (text.length === word.length) return true;
  return !isIdentifierPart(text.charAt(word.length));
}

/** Characters, counting an astral pair as one — the closest analogue of Swift's `Character`. */
function countCharacters(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}
