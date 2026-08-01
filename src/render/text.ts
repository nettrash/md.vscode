//
//  text.ts
//  md.vscode — text primitives the whole parity core is built on.
//
//  A port of the parts of `md/md/ScalarText.swift` the parser actually uses,
//  plus the two whitespace sets Foundation gave the Swift for free.
//
//  WHY THIS FILE EXISTS AT ALL
//  ---------------------------
//  Swift's `Character` is an extended grapheme cluster, so an ASCII delimiter
//  followed by a combining mark, a variation selector or a ZWJ is one
//  `Character` that is *not equal* to the plain ASCII one:
//
//      "%\u{0301}".contains("%")      // false
//      "[\u{FE0F}".hasPrefix("[")     // false
//      ">\u{0301} quoted".first == ">"// false
//
//  Every one of those was a real, silent divergence: a list, a code fence, a
//  table, a footnote definition, a quote and a heading each found on Android
//  and missed on Apple — and an HTML comment whose `-->` carried a mark never
//  closed and swallowed the rest of the document. `ScalarText` is Swift's fix.
//
//  JavaScript strings are UTF-16 code units — the same model Kotlin uses, and
//  the one the Android port already gets right. So the fix is free here: plain
//  `indexOf` / `startsWith` / `s[i]` are already scalar-correct for this
//  grammar, because every delimiter is a single ASCII scalar and no half of a
//  surrogate pair can ever equal an ASCII delimiter.
//
//  Therefore, in this port:
//    * the block scanner iterates UTF-16 code units (matches Kotlin exactly);
//    * `slug()` iterates CODE POINTS, because slugs keep astral letters;
//    * nothing anywhere is grapheme-aware. Never reach for `Intl.Segmenter`,
//      and never use a `v`-flag regex doing `\p{RGI_Emoji}`-style cluster
//      matching — that would reintroduce precisely the Swift bug.
//

/**
 * `CharacterSet.whitespaces` — Unicode general category **Zs** ∪ U+0009.
 *
 * Deliberately NOT `\s` and NOT `String.prototype.trim()`: JS trims
 * `WhiteSpace ∪ LineTerminator`, which adds `\n \r \v \f     ﻿`
 * — wrong at both ends.
 *
 * Note the exclusions, each load-bearing:
 *   * **U+200B ZERO WIDTH SPACE** is not Zs. Including it would align the same
 *     pasted spreadsheet differently on two platforms over an invisible
 *     character (called out explicitly in `MarkdownHTML.delimitedTable`).
 *   * U+180E MONGOLIAN VOWEL SEPARATOR has been `Cf`, not `Zs`, since
 *     Unicode 6.3.
 *   * U+000A/U+000D/U+000B/U+000C/U+0085/U+2028/U+2029 are newlines, not
 *     spaces — they belong to `WHITESPACE_AND_NEWLINES` only.
 */
const WHITESPACE = new Set([
  0x0009, 0x0020, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x202f, 0x205f, 0x3000,
]);

/** `CharacterSet.whitespacesAndNewlines` — the set above ∪ the line terminators. */
const WHITESPACE_AND_NEWLINES = new Set([
  ...WHITESPACE,
  0x000a, 0x000b, 0x000c, 0x000d, 0x0085, 0x2028, 0x2029,
]);

export function isWhitespace(code: number): boolean {
  return WHITESPACE.has(code);
}

export function isWhitespaceOrNewline(code: number): boolean {
  return WHITESPACE_AND_NEWLINES.has(code);
}

function trimWith(s: string, set: Set<number>): string {
  let start = 0;
  let end = s.length;
  while (start < end && set.has(s.charCodeAt(start))) start++;
  while (end > start && set.has(s.charCodeAt(end - 1))) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

/**
 * Foundation's `trimmingCharacters(in: .whitespaces)`.
 *
 * Foundation trims *scalars*, not graphemes: `" \u{0301}abc"` trims to
 * `"\u{0301}abc"` — the space goes even though space-plus-mark is one
 * `Character`. That is exactly Kotlin's `trimSpaces()`, and exactly this.
 */
export function trimWS(s: string): string {
  return trimWith(s, WHITESPACE);
}

/** Foundation's `trimmingCharacters(in: .whitespacesAndNewlines)`. Used only by `noteText`. */
export function trimWSNL(s: string): string {
  return trimWith(s, WHITESPACE_AND_NEWLINES);
}

export function trimLeadingWS(s: string): string {
  let start = 0;
  while (start < s.length && WHITESPACE.has(s.charCodeAt(start))) start++;
  return start === 0 ? s : s.slice(start);
}

export function trimTrailingWS(s: string): string {
  let end = s.length;
  while (end > 0 && WHITESPACE.has(s.charCodeAt(end - 1))) end--;
  return end === s.length ? s : s.slice(0, end);
}

/**
 * `ScalarText.contains` — the needle's scalars appear in order.
 *
 * **An empty needle is never found** (Swift returns `false`), unlike JS's
 * `String.prototype.includes('')`, which returns `true`. Call sites rely on it.
 */
export function scalarContains(text: string, needle: string): boolean {
  return needle.length > 0 && text.includes(needle);
}

/** `ScalarText.hasPrefix` — exact scalar prefix. An empty prefix is `true`. */
export function scalarHasPrefix(text: string, prefix: string): boolean {
  return text.startsWith(prefix);
}

/** `ScalarText.hasSuffix` — exact scalar suffix. An empty suffix is `true`. */
export function scalarHasSuffix(text: string, suffix: string): boolean {
  return text.endsWith(suffix);
}

/**
 * `ScalarText.firstIndex(of:in:from:)` — first index ≥ `from`, or `null`.
 * `null` when the needle is empty or longer than the haystack.
 */
export function scalarFirstIndex(text: string, needle: string, from = 0): number | null {
  if (needle.length === 0 || needle.length > text.length) return null;
  const i = text.indexOf(needle, from);
  return i < 0 ? null : i;
}

/**
 * Split `source` into lines, one pass, treating **CRLF as one terminator**.
 *
 * A port of `normalizedLines(_:)`. Deliberately not
 * `replacingOccurrences` + `components(separatedBy:)`: those match grapheme
 * clusters, which is only *nearly* right by accident, and this runs on every
 * keystroke.
 *
 * `\r`, `\n` and `\r\n` each end exactly one line. A trailing terminator does
 * not produce an extra empty line beyond the one Swift produces — the final
 * `current` is always appended.
 */
export function normalizedLines(source: string): string[] {
  const lines: string[] = [];
  let current = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\r') {
      if (i + 1 < source.length && source[i + 1] === '\n') i++;
      lines.push(current);
      current = '';
    } else if (c === '\n') {
      lines.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Iterate a string by **code point**, as Swift's `String.UnicodeScalarView`
 * does. Used by `slug()`, which must keep astral letters intact — a surrogate
 * half is not a letter and would be dropped.
 */
export function codePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0)!);
  return out;
}
