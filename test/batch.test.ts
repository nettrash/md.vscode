//
//  batch.test.ts
//  md.vscode — the names a batch export writes under.
//
//  A single export cannot get this wrong: `showSaveDialog` owns the name, and
//  the host itself asks before overwriting anything. A batch has one dialogue
//  for many files, so the same three questions — what is it called, what if
//  that name is taken, what if the destination already holds one — are
//  answered by `src/export/batch.ts` instead, silently, twenty times in a row.
//  Silently is why they are pinned here: the failure mode is not an error
//  message, it is a folder that quietly holds nineteen files where twenty were
//  selected, and nobody counts.
//
//  The file-system-ish facts these tests assert are deliberate:
//
//    * the stem comes from the **source file**, never from the document's
//      front-matter title, so a folder of exports lines up with the folder it
//      came from;
//    * comparison is case-insensitive, because APFS and NTFS are, and treating
//      `Notes.html` and `notes.html` as two names would let the second
//      overwrite the first on the very systems this extension runs on;
//    * the suffix run starts at 2, because the file already sitting there is
//      the 1.
//

import { describe, expect, it } from 'vitest';

import {
  batchFileName,
  isMarkdownPath,
  MARKDOWN_EXTENSIONS,
  planBatchNames,
  sanitized,
  stemOfPath,
} from '../src/export/batch';

describe('stemOfPath — the name an export takes', () => {
  it('drops the directory and the extension', () => {
    expect(stemOfPath('/Users/nettrash/Notes/reading list.md')).toBe('reading list');
  });

  it('keeps a name that has no extension', () => {
    expect(stemOfPath('/tmp/README')).toBe('README');
  });

  it('keeps a dotfile whole — there is no stem to take', () => {
    expect(stemOfPath('/repo/.gitignore')).toBe('.gitignore');
  });

  it('falls back to Document rather than to an empty name', () => {
    expect(stemOfPath('/')).toBe('Document');
    expect(stemOfPath('')).toBe('Document');
  });

  it('reads a path with no directory at all', () => {
    expect(stemOfPath('notes.md')).toBe('notes');
  });
});

describe('batchFileName — stem plus extension', () => {
  it('is the stem and the format, and nothing of the source extension', () => {
    expect(batchFileName('/notes/trip.md', 'html', new Set())).toBe('trip.html');
    expect(batchFileName('/notes/trip.markdown', 'epub', new Set())).toBe('trip.epub');
    expect(batchFileName('/notes/trip.mkdn', 'tex', new Set())).toBe('trip.tex');
  });

  it('strips the characters a file system will not take', () => {
    // Legal on a Linux checkout, fatal on the Mac or Windows the export may
    // land on — the same `sanitized` every single export has always used.
    expect(batchFileName('/notes/re:port?.md', 'html', new Set())).toBe(
      `${sanitized('re:port?')}.html`,
    );
    expect(batchFileName('/notes/re:port?.md', 'html', new Set())).toBe('re-port-.html');
  });
});

describe('batchFileName — collisions', () => {
  it('takes the next ordinal when the plain name is spoken for', () => {
    expect(batchFileName('/a/README.md', 'html', new Set(['readme.html']))).toBe('README-2.html');
  });

  it('keeps counting past a taken suffix', () => {
    const taken = new Set(['readme.html', 'readme-2.html', 'readme-3.html']);
    expect(batchFileName('/a/README.md', 'html', taken)).toBe('README-4.html');
  });

  it('compares without case, because the file systems this runs on do not', () => {
    // The whole point: on APFS, writing `README.html` beside `readme.html`
    // replaces it. A case-sensitive check here would call them two names and
    // lose the first file.
    expect(batchFileName('/a/readme.md', 'html', new Set(['README.HTML']))).toBe('readme-2.html');
  });

  it('does not collide across formats — only the whole name counts', () => {
    expect(batchFileName('/a/README.md', 'epub', new Set(['readme.html']))).toBe('README.epub');
  });
});

describe('planBatchNames — a whole selection at once', () => {
  it('names every file, in the order it was selected', () => {
    const names = planBatchNames(['/a/one.md', '/b/two.md', '/c/three.md'], 'html');
    expect(names).toEqual(['one.html', 'two.html', 'three.html']);
  });

  it('separates two same-stemmed files from different folders', () => {
    const names = planBatchNames(['/a/README.md', '/b/README.md', '/c/README.md'], 'html');
    expect(names).toEqual(['README.html', 'README-2.html', 'README-3.html']);
  });

  it('steps around what the destination folder already holds', () => {
    const names = planBatchNames(['/a/notes.md', '/b/notes.md'], 'epub', [
      'notes.epub',
      'cover.png',
    ]);
    expect(names).toEqual(['notes-2.epub', 'notes-3.epub']);
  });

  it('never writes the same name twice', () => {
    const sources = ['/a/n.md', '/b/n.md', '/c/n.md', '/d/N.md', '/e/n.markdown'];
    const names = planBatchNames(sources, 'tex', ['n.tex']);
    expect(names).toHaveLength(sources.length);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(sources.length);
    expect(names).not.toContain('n.tex');
  });

  it('is empty for an empty selection', () => {
    expect(planBatchNames([], 'html')).toEqual([]);
  });
});

describe('isMarkdownPath — what a multi-selection is filtered to', () => {
  // `resourceLangId` in a menu `when` clause is evaluated against the file that
  // was clicked and says nothing about the rest of the selection, so a folder,
  // an image or a `.txt` can arrive in `uris`. Opening one of those would
  // report a failure the author did not ask for.
  it('accepts every spelling the family recognises', () => {
    for (const extension of MARKDOWN_EXTENSIONS) {
      expect(isMarkdownPath(`/notes/file${extension}`), extension).toBe(true);
    }
  });

  it('ignores case in the extension', () => {
    expect(isMarkdownPath('/notes/READ.MD')).toBe(true);
    expect(isMarkdownPath('/notes/READ.MkDn')).toBe(true);
  });

  it('refuses what is not Markdown, including a folder and a diagram file', () => {
    for (const p of ['/notes', '/notes/', '/notes/photo.png', '/notes/a.txt', '/notes/d.puml']) {
      expect(isMarkdownPath(p), p).toBe(false);
    }
  });
});
