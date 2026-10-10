//
//  items.ts
//  md.vscode — the rows of Go to Heading… and Go to Note…, as pure functions.
//
//  The apps have a Contents menu and a Notes menu; these are the same two lists
//  as VS Code QuickPicks. Both come from the parser the preview renders with
//  (`outline`, `notes`), so a heading md does not draw as a heading is not
//  offered, and a note inside a code fence or the front matter is not either.
//

import type { NoteEntry, OutlineEntry } from '../render/types';

export interface GoToRow {
  /** What the list shows. Headings are indented two spaces per level below the top one. */
  label: string;
  /** "H2 · line 14" or "line 31". */
  description: string;
  /** 0-based source line to reveal. */
  line: number;
}

/** A note is shown on one line, at most this many characters of it. */
export const NOTE_PREVIEW_LENGTH = 80;

export function headingRows(entries: readonly OutlineEntry[]): GoToRow[] {
  const top = entries.reduce((min, e) => Math.min(min, e.level), 6);
  return entries.map((e) => ({
    label: ' '.repeat(Math.max(0, e.level - top)) + e.text,
    description: `H${e.level} · line ${e.line + 1}`,
    line: e.line,
  }));
}

export function noteRows(entries: readonly NoteEntry[]): GoToRow[] {
  return entries.map((e) => {
    const flat = e.text.replace(/\s+/g, ' ').trim();
    const label = flat.length > NOTE_PREVIEW_LENGTH ? flat.slice(0, NOTE_PREVIEW_LENGTH - 1).trimEnd() + '…' : flat;
    return { label: label === '' ? '(empty note)' : label, description: `line ${e.line + 1}`, line: e.line };
  });
}
