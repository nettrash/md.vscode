//
//  batch.ts
//  md.vscode — the names a batch export writes under, and nothing else.
//
//  A single export asks `showSaveDialog` for a destination and the host
//  settles every hard question for us: where the file goes, what it is
//  called, and what happens when something of that name is already there.
//  A batch has one dialogue for many files, so each of those questions has
//  to be answered here instead, by a rule that can be read and tested:
//
//    * the name is the **source file's stem** plus the format's extension —
//      `notes.md` becomes `notes.html`, never the document's front-matter
//      title, because a folder of exports should line up with the folder it
//      came from;
//    * a name already claimed — by an earlier file in the same batch, or by
//      something already sitting in the destination — takes a `-2`, then a
//      `-3`, and so on. Two `README.md` from two folders land side by side
//      as `README.html` and `README-2.html` rather than one silently
//      overwriting the other;
//    * comparison is case-insensitive, because the file systems this runs
//      on (APFS, NTFS) mostly are: `Notes.html` and `notes.html` are one
//      name, and treating them as two would turn the collision rule into
//      the very overwrite it exists to prevent.
//
//  Everything here is pure string work over paths. No `vscode`, no `fs`:
//  the whole point is that the rule is decidable in a unit test rather than
//  only observable by exporting twenty files and looking at a folder.
//

import * as path from 'node:path';

import { trimWSNL } from '../render/text';

/**
 * A file name from a title, with the characters no file system will take.
 *
 * The set is the apps' own — `/ \ : ? % * | " < >` — and so is the shape of the
 * replacement: it is a split-join, so a run of two offending characters becomes
 * **two** dashes, not one. Empty after trimming falls back to `Document`, the
 * same word the apps use.
 */
export function sanitized(name: string): string {
  const joined = name.split(/[/\\:?%*|"<>]/).join('-');
  const trimmed = trimWSNL(joined);
  return trimmed.length > 0 ? trimmed : 'Document';
}

/**
 * The file name without its extension — the title every export uses.
 *
 * Takes a path rather than a document so that the same rule serves a
 * `TextDocument` about to be exported and a URI sitting unopened in a
 * multi-selection. A dotfile keeps its whole name (`.gitignore` has no stem
 * to speak of), and anything that leaves nothing behind falls back to
 * `Document`.
 */
export function stemOfPath(filePath: string): string {
  const name = path.basename(filePath);
  const extension = path.extname(name);
  const stem = extension.length > 0 && extension.length < name.length
    ? name.slice(0, -extension.length)
    : name;
  return stem.length > 0 ? stem : 'Document';
}

/**
 * The ten spellings of a Markdown file the family recognises.
 *
 * VS Code's own `markdown` language claims eight of them and `package.json`
 * adds the last two. This is a **cheap yes** and nothing more: it is asked
 * first by `batchTargets` so that a folder of `.md` files need not be opened
 * one by one to establish what their names already say. It is deliberately
 * *not* the filter a multi-selection is judged by — the editor's own language
 * list is longer than this one and grows with the editor (`.ronn`,
 * `.workbook`, the Cursor rule files), so a file this list has never heard of
 * still reaches an export when the host calls it Markdown.
 */
export const MARKDOWN_EXTENSIONS: readonly string[] = [
  '.md',
  '.markdown',
  '.mdown',
  '.markdn',
  '.mdtext',
  '.mdtxt',
  '.mkd',
  '.mkdn',
  '.mdwn',
  '.mkdown',
];

/** Whether a path is one of the Markdown spellings above, case ignored. */
export function isMarkdownPath(filePath: string): boolean {
  const extension = path.extname(path.basename(filePath)).toLowerCase();
  return MARKDOWN_EXTENSIONS.includes(extension);
}

/**
 * The name one export takes in a destination folder, given the names already
 * spoken for.
 *
 * `taken` is read in whatever case it arrives in and folded here, rather than
 * the caller being trusted to have lowercased it: the case rule is the one
 * that loses a file when it is wrong, so it lives in the function that
 * depends on it and not in a comment above the call.
 */
export function batchFileName(
  sourcePath: string,
  extension: string,
  taken: Iterable<string>,
): string {
  const claimed = new Set<string>();
  for (const name of taken) claimed.add(name.toLowerCase());

  const stem = sanitized(stemOfPath(sourcePath));
  const plain = `${stem}.${extension}`;
  if (!claimed.has(plain.toLowerCase())) return plain;

  // Starts at 2 — the file already there is the 1. No upper bound: the loop
  // terminates because each candidate is distinct and `claimed` is finite.
  for (let ordinal = 2; ; ordinal++) {
    const candidate = `${stem}-${ordinal}.${extension}`;
    if (!claimed.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Every name a batch will write, in the order the files were selected.
 *
 * `existing` is what the destination folder already holds, read once before
 * the loop rather than re-stat'ed per file: one listing, and the collision
 * rule then runs entirely in memory.
 */
export function planBatchNames(
  sourcePaths: readonly string[],
  extension: string,
  existing: Iterable<string> = [],
): string[] {
  const taken = new Set<string>();
  for (const name of existing) taken.add(name);

  return sourcePaths.map((sourcePath) => {
    const name = batchFileName(sourcePath, extension, taken);
    taken.add(name);
    return name;
  });
}
