//
//  count.ts
//  md.vscode — the family's word and character count, as pure functions.
//
//  Every md app shows "211 words · 1,425 characters" under the page, and the
//  numbers must agree with them. Words are ICU word segments — what Foundation's
//  `enumerateSubstrings(.byWords)`, Kotlin's `BreakIterator` and md.win's
//  `IcuWordCounter` count, a segment ICU itself calls word-like — and characters
//  are user-perceived characters (grapheme clusters), which is Swift's
//  `String.count`. VS Code's Node carries full ICU, so `Intl.Segmenter` is that
//  same segmenter, dictionaries included: CJK and Thai count as they do on a Mac.
//
//  This lives outside `src/render`, which may not reach for `Intl.Segmenter` (the
//  render core is the byte-parity half and stays free of locale-dependent APIs).
//

/** Word-like segments in `text`. */
export function countWords(text: string): number {
  let words = 0;
  for (const segment of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) {
    if (segment.isWordLike) words++;
  }
  return words;
}

/** User-perceived characters in `text`. */
export function countCharacters(text: string): number {
  let characters = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) characters++;
  return characters;
}

const unit = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * The status-bar text: "211 words · 1,425 characters" for the document, and
 * "12 of 211 words · 70 of 1,425 characters" while some of it is selected.
 */
export function countLabel(
  document: { words: number; characters: number },
  selection?: { words: number; characters: number },
): string {
  if (selection === undefined || selection.characters === 0) {
    return `${unit(document.words, 'word', 'words')} · ${unit(document.characters, 'character', 'characters')}`;
  }
  return (
    `${selection.words.toLocaleString()} of ${unit(document.words, 'word', 'words')} · ` +
    `${selection.characters.toLocaleString()} of ${unit(document.characters, 'character', 'characters')}`
  );
}

/** Minutes to read `words` at 230 words a minute, never less than one. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 230));
}
