//
//  inline.ts
//  md.vscode — the span pass.
//
//  A port of the private `inline` / `protect` / `token` / `mathSpan` /
//  `escape` / `replace` family in `md/md/MarkdownHTML.swift`.
//
//  This function — not a browser delimiter scan — decides what is a formula.
//  Math is emitted as explicit `.md-mathi` / `.md-mathd` spans which
//  `rich/md-init.js` typesets with KaTeX; the alternative, KaTeX's own
//  auto-render pass over the whole body, would re-read ordinary prose ("$5 and
//  $10") as a formula. That is why `rich/auto-render.min.js` is bundled by the
//  apps and referenced by nothing.
//
//  THE PHASE ORDER IS THE SPECIFICATION. Any reordering silently changes the
//  output of real documents:
//
//      1. protect   code spans → $$…$$ → \[…\] → $…$ → \(…\)
//      2. escape    the whole remaining literal text (&, <, >, ")
//      3. spans     img(title) → img → link(title) → link → footnote ref
//                   → ** → __ → ~~ → * → _
//      4. breaks    soft newlines → "<br>\n"   (paragraphs only)
//      5. restore   the protected spans, ascending
//
//  Everything is escaped before phase 3, so every later pattern speaks in
//  *escaped* terms: a link title reads `&quot;…&quot;`, not `"…"`.
//

/**
 * ICU's `\w`, spelled out.
 *
 * `NSRegularExpression` is ICU, where `\w` is
 * `[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\u200C\u200D]` — so `ф`, `٣`, a combining
 * acute, `_`, ZWNJ/ZWJ and `Ⅹ` (U+2169, `Nl`, and Alphabetic) are all word
 * characters, while `½` (U+00BD, `No`) and `-` are not.
 *
 * **JavaScript's `\w` is `[A-Za-z0-9_]` and using it here would be a bug**: it
 * would read `ф$x$ф` as a formula and `ф_em_ф` as emphasis, because neither
 * Cyrillic letter would count as the word character that the currency guard and
 * the underscore-italic guard are looking for. That is the exact regression the
 * Kotlin port hit and now pins on-device.
 *
 * Divergence recorded, not resolved (port spec OQ-3): the three existing ports
 * spell this guard three different ways — Swift's HTML writer uses ICU `\w`,
 * Kotlin's uses `[\p{L}\p{N}_$]`, and *both* LaTeX writers use `[\p{L}\p{N}_]`.
 * They disagree on real input: `²$x$` is math on Apple and prose on Android;
 * `e◌́$x$` is the reverse. This file follows the **Swift HTML writer**, because
 * its bytes are the ones the golden corpus was captured from. Do not quietly
 * unify the three — that is a four-repo change.
 */
const WORD = String.raw`\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\u200C\u200D`;

/**
 * ICU's `\s`, spelled out.
 *
 * Measured: ICU `\s` matches TAB, U+000B, NBSP and U+2003 but **not** U+FEFF;
 * JavaScript's `\s` matches U+FEFF and is a different set again. The two link
 * and image patterns below use `\s` twice each (`[^)\s]+` for the URL and `\s+`
 * before a title), so it is written out rather than left to the engine.
 */
const SPACE = String.raw`\t\n\v\f\r\p{Z}`;

// ---------------------------------------------------------------------------
// Phase 1 — the protect patterns, in their mandatory order.
//
// `.dotMatchesLineSeparators` is what the Swift passes to every `protect`
// pattern, so the `s` flag is set here to match. It is inert for these five —
// none of them uses `.` — but it is the option the source asks for, and it is
// what keeps a `.` added later behaving the same way on both sides.
// ---------------------------------------------------------------------------

/** Code spans. First, so `` `$x$` `` inside backticks stays literal code. */
const CODE_SPAN = /`([^`]+)`/gsu;

/** `$$…$$` display math. */
const DISPLAY_DOLLARS = /\$\$([\s\S]+?)\$\$/gsu;

/** `\[…\]` display math. */
const DISPLAY_BRACKETS = /\\\[([\s\S]+?)\\\]/gsu;

/**
 * `$…$` inline math **with the currency guard** — the single most load-bearing
 * regex in this file.
 *
 * `(?<![\w$])` / `(?![\w$])`: a delimiting `$` may be neither preceded nor
 * followed by a word character or another `$`. That is the whole reason
 * "it costs $5 and $10 today" survives as prose, and why `a$x$b` and `5$x$` do
 * not become formulas. `[^$\n]` additionally forbids a newline inside inline
 * math, so `$x\ny$` is prose too.
 */
const INLINE_DOLLARS = new RegExp(
  String.raw`(?<![${WORD}$])\$([^$\n]+?)\$(?![${WORD}$])`,
  'gsu',
);

/** `\(…\)` inline math. */
const INLINE_PARENS = /\\\(([^\n]+?)\\\)/gsu;

// ---------------------------------------------------------------------------
// Phase 3 — span syntax → tags, in their mandatory order.
//
// These compile with no dotAll, exactly as the Swift's `replace` does, so the
// `(.*?)` of a link title cannot cross a newline.
//
// Residual, documented gap: ICU excludes U+000B, U+000C and U+0085 from `.` as
// well, JavaScript does not. A link title containing a vertical tab therefore
// matches here and not on Apple. Left as the Swift wrote it rather than
// respelled, because the port spec respells only `\w` and `\s`, and a reader
// diffing the two files should find the same pattern text.
// ---------------------------------------------------------------------------

/** `![alt](src "title")` — titled images first, or the untitled pattern below
 *  would stop at the first `)` and the title would leak into the document. */
const IMAGE_TITLED = new RegExp(
  String.raw`!\[([^\]]*)\]\(([^)${SPACE}]+)[${SPACE}]+&quot;(.*?)&quot;\)`,
  'gu',
);

/** `![alt](src)`. */
const IMAGE = new RegExp(String.raw`!\[([^\]]*)\]\(([^)${SPACE}]+)\)`, 'gu');

/** `[label](url "title")` — after both image patterns, because image syntax is
 *  link syntax with a leading `!` and the link pass would otherwise eat it. */
const LINK_TITLED = new RegExp(
  String.raw`\[([^\]]+)\]\(([^)${SPACE}]+)[${SPACE}]+&quot;(.*?)&quot;\)`,
  'gu',
);

/** `[label](url)`. Alt text may be empty (`*`), a link label may not (`+`). */
const LINK = new RegExp(String.raw`\[([^\]]+)\]\(([^)${SPACE}]+)\)`, 'gu');

/**
 * `[^id]` — a footnote reference, left as a placeholder for `withFootnotes`.
 *
 * Ids are ASCII `[A-Za-z0-9_-]` because the parser accepts exactly that set for
 * a definition: there is then nothing to escape into an `id` attribute, and no
 * definition can be written that no reference is able to name.
 */
const FOOTNOTE_REF = /\[\^([A-Za-z0-9_-]+)\]/gu;

/** `**bold**` — before `*italic*`, so `**` wins and `***x***` nests. */
const STRONG_STARS = /\*\*([^*]+)\*\*/gu;

/** `__bold__`. */
const STRONG_UNDERSCORES = /__([^_]+)__/gu;

/** `~~struck~~`. */
const DELETED = /~~([^~]+)~~/gu;

/** `*italic*`. The content class is "no delimiter inside", so `**a*b**` is not
 *  matched as bold by the pass above and not matched here either. */
const EMPHASIS_STARS = /\*([^*]+)\*/gu;

/**
 * `_italic_`, **word-boundary-guarded so `snake_case` survives**.
 * `call some_long_name now` produces no `<em>`; `__bold__` has already been
 * consumed by the pass above.
 */
const EMPHASIS_UNDERSCORES = new RegExp(
  String.raw`(?<![${WORD}])_([^_]+)_(?![${WORD}])`,
  'gu',
);

/**
 * The placeholder a protected span leaves behind: U+E000, the decimal index,
 * U+E001.
 *
 * Private-use characters, so `escape()` never touches them and no span pattern
 * can match one. They are also why `` $$ `x` $$ `` leaks raw U+E000/U+E001 into
 * the output — see the note on restore, at the foot of `inline`.
 */
function token(index: number): string {
  return `\u{E000}${index}\u{E001}`;
}

/**
 * The four-character HTML escape, in this order.
 *
 * `&` **must** be first or the three replacements after it get double-escaped.
 * `'` is deliberately not escaped. `"` is, so that a link URL — which lands in
 * a double-quoted `href` and whose characters are not otherwise constrained —
 * cannot break out and inject attributes or event handlers into the page. That
 * one line is the whole XSS story in this family of apps:
 *
 *     [a]("onerror=alert(1))  →  <a href="&quot;onerror=alert(1">a</a>
 *
 * There is no raw-HTML passthrough anywhere in the renderer and no autolink
 * support, so `<b>hi</b>` and `<https://nettrash.me>` both render as their own
 * text. That is a deliberate subset, not an omission.
 */
export function escapeHTML(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** A KaTeX target element. `md-init.js` renders `.md-mathi` inline and
 *  `.md-mathd` in display mode; the LaTeX is escaped for HTML, but KaTeX reads
 *  the decoded `textContent`, so `<`, `>` and `&` in a formula are fine. */
function mathSpan(latex: string, display: boolean): string {
  return `<span class="md-math${display ? 'd' : 'i'}">${escapeHTML(latex)}</span>`;
}

/**
 * Replace every match of `pattern` (capture group 1) with a unique private-use
 * token, appending `transform(group1)` to `store`.
 *
 * Matches are rewritten **back-to-front** so the earlier ranges stay valid —
 * the same discipline every substitution walk in this codebase follows. Note
 * the consequence, which is load-bearing for byte parity: because the walk runs
 * backwards while `index = store.length` counts forwards, the *last* match in
 * the text takes the *lowest* index of the pass. Restore then runs ascending,
 * which is what produces the token leak documented in `inline`.
 */
function protect(
  pattern: RegExp,
  text: string,
  store: string[],
  transform: (content: string) => string,
): string {
  const matches = [...text.matchAll(pattern)];
  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const content = match[1];
    const start = match.index;
    // Swift guards with `where match.numberOfRanges >= 2`; a pattern with no
    // group 1 contributes nothing rather than protecting an empty string.
    if (content === undefined || start === undefined) continue;
    const index = store.length;
    store.push(transform(content));
    result = result.slice(0, start) + token(index) + result.slice(start + match[0].length);
  }
  return result;
}

/**
 * Convert a block's inline Markdown to HTML.
 *
 * `softBreaks` is passed only by the paragraph renderer. It is not part of the
 * module contract's one-argument signature but it cannot live outside this
 * function: the conversion has to happen between the span pass and restore, so
 * that a multi-line display-math span keeps its own internal newlines instead
 * of having `<br>`s injected into the formula.
 */
export function inline(text: string, softBreaks = false): string {
  const protectedSpans: string[] = [];
  let working = text;

  // 1. Protect, in order: code spans, then display math ($$…$$, \[…\]), then
  //    inline math ($…$, \(…\)). Code wins over math, so `$x$` inside backticks
  //    stays literal code. The inline `$…$` form carries the currency guard so
  //    "$5 and $10" is left as prose.
  working = protect(CODE_SPAN, working, protectedSpans, (c) => `<code>${escapeHTML(c)}</code>`);
  working = protect(DISPLAY_DOLLARS, working, protectedSpans, (c) => mathSpan(c, true));
  working = protect(DISPLAY_BRACKETS, working, protectedSpans, (c) => mathSpan(c, true));
  working = protect(INLINE_DOLLARS, working, protectedSpans, (c) => mathSpan(c, false));
  working = protect(INLINE_PARENS, working, protectedSpans, (c) => mathSpan(c, false));
  //    A footnote reference needs no protection: `[^id]` has no `](`, so no
  //    link or image pattern can match it, and one written inside backticks is
  //    already a code token by now. Protecting it would not even work — the
  //    token would land inside an image's alt text and restoring it would
  //    inject the markup there anyway.

  // 2. Escape the literal text. The protection tokens are private-use, so they
  //    pass through untouched.
  working = escapeHTML(working);

  // 3. Span syntax → tags. Every one of these is a replace-*all*: the Swift
  //    calls `stringByReplacingMatches`, so each pattern carries `g` here.
  working = working.replace(IMAGE_TITLED, '<img src="$2" alt="$1" title="$3">');
  working = working.replace(IMAGE, '<img src="$2" alt="$1">');
  working = working.replace(LINK_TITLED, '<a href="$2" title="$3">$1</a>');
  working = working.replace(LINK, '<a href="$2">$1</a>');
  //    Footnote references come after images and links, and must. The markup a
  //    reference becomes is full of quotes and angle brackets, so converting it
  //    first would let an image carry it into an `alt` attribute — straight
  //    through the quoting this pass relies on — and let a link wrap it in an
  //    `<a>` inside another `<a>`. Running last means a reference written
  //    inside a link's own label simply stops that label from being a link,
  //    which is the harmless failure.
  //
  //    The number and the target are not known yet: they depend on the order of
  //    first reference across the whole document, so this leaves a placeholder
  //    for `withFootnotes` in html.ts to resolve.
  working = working.replace(FOOTNOTE_REF, '<sup class="md-fnref" data-fn="$1"></sup>');
  working = working.replace(STRONG_STARS, '<strong>$1</strong>');
  working = working.replace(STRONG_UNDERSCORES, '<strong>$1</strong>');
  working = working.replace(DELETED, '<del>$1</del>');
  working = working.replace(EMPHASIS_STARS, '<em>$1</em>');
  working = working.replace(EMPHASIS_UNDERSCORES, '<em>$1</em>');

  // 4. Soft line breaks (paragraphs only), before restoring the protected spans
  //    so a multi-line display-math span keeps its own internal newlines. The
  //    emitted form is `<br>` followed by a real newline, so a two-line
  //    paragraph is still two lines of source in the generated HTML.
  if (softBreaks) {
    working = working.replaceAll('\n', '<br>\n');
  }

  // 5. Restore the protected spans, ascending.
  //
  //    KNOWN LATENT BUG, REPRODUCED DELIBERATELY. A later protect pass can
  //    swallow an earlier pass's token — a code span inside a math span is the
  //    only way to reach it — and because restore runs ascending, the enclosed
  //    token is restored before its enclosing HTML is back in `working`. The
  //    raw private-use characters then survive into the page:
  //
  //        "$$ `x` $$"  →  <span class="md-mathd"> U+E000 0 U+E001 </span>
  //
  //    Restoring descending, or restoring twice, fixes it. Neither is done
  //    here: the three shipping apps all have this behaviour, byte parity is
  //    the contract, and fixing it is a four-repo product decision.
  //
  //    The replacement is passed as a *function*. `String.replaceAll` with a
  //    string replacement interprets `$$`, `$&`, `` $` `` and `$'` — so
  //    restoring a protected `` `$$` `` with a plain string would silently emit
  //    `<code>$</code>`. A function replacement is taken literally.
  for (let index = 0; index < protectedSpans.length; index++) {
    const html = protectedSpans[index];
    working = working.replaceAll(token(index), () => html);
  }
  return working;
}
