//
//  asset-reader.ts
//  md.vscode — reading an image a document refers to, from beside it on disk.
//
//  md.win's `TextBundle.ReadAsset`, for a document on the local disk: the path
//  is resolved against the document's own folder and must stay strictly inside
//  it. A `../` that climbs out is "not found", never a read, and so is a symlink
//  beside the document that points elsewhere — both the folder and the file are
//  resolved to their real paths before the test. A folder is not an image.
//
//  The command layer uses this for `file:` documents and VS Code's file system,
//  with the same lexical test, for everything else.
//

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Whether `candidate` lies strictly inside `folder` — by `relative`, not by a
 * string prefix, so a document at a file-system root (`/notes.md`, `C:\\x.md`)
 * finds its neighbours, and a sibling named `..cover.png` is not mistaken for
 * a climb. `paths` is the platform's path module; a test passes the other one.
 */
export function isInside(folder: string, candidate: string, paths: typeof path = path): boolean {
  const relative = paths.relative(folder, candidate);
  if (relative === '' || paths.isAbsolute(relative)) return false;
  return relative.split(paths.sep)[0] !== '..';
}

/** The bytes of `relativePath` beside `documentPath`, or null when it is missing, a folder, or outside. */
export async function readLocalAsset(relativePath: string, documentPath: string | null): Promise<Uint8Array | null> {
  if (documentPath === null || path.isAbsolute(relativePath)) return null;
  const folder = path.dirname(documentPath);
  const candidate = path.resolve(folder, relativePath);
  if (!isInside(folder, candidate)) return null;
  try {
    const realFolder = await fs.promises.realpath(folder);
    const realCandidate = await fs.promises.realpath(candidate);
    if (!isInside(realFolder, realCandidate)) return null;
    if (!(await fs.promises.stat(realCandidate)).isFile()) return null;
    return new Uint8Array(await fs.promises.readFile(realCandidate));
  } catch {
    return null;
  }
}
