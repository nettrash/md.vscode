//
//  textbundle.ts
//  md.vscode — the TextBundle and TextPack writer, the family's sixth export.
//
//  A port of md.win's `src/Md.Core/Export/TextBundle.cs` (itself the Swift and
//  Kotlin writers' twin): text.md, the canonical info.json, and assets/ holding
//  every image the document references by a relative path, with those
//  references rewritten to `assets/…`. Remote and data: images stay as written
//  and nothing is fetched. `test/textbundle.test.ts` carries md.win's own
//  vectors, so the five writers rewrite the same document the same way.
//
//  Pure: no `vscode`, no file system. Reading an asset is the caller's — the
//  command layer resolves it through VS Code's file system, contained to the
//  document's own folder — and is handed in as `resolve`.
//

import type { ZipEntry } from './zip';

/** The info.json every bundle we write carries — the family's fixed canonical document. */
export const INFO_JSON = '{\n  "version": 2,\n  "type": "net.daringfireball.markdown",\n  "transient": false\n}';

export const TEXT_FILE_NAME = 'text.md';
export const INFO_FILE_NAME = 'info.json';
export const ASSETS_DIRECTORY_NAME = 'assets';
export const BUNDLE_EXTENSION = '.textbundle';
export const PACK_EXTENSION = '.textpack';

/** One image copied into a bundle's assets/. */
export interface Asset {
  name: string;
  data: Uint8Array;
}

/** The document as the bundle stores it, and the images that go with it. */
export interface Rewrite {
  text: string;
  assets: Asset[];
}

/** ASCII-only prefix fold, as md.win: a Turkish İ never becomes an "i" here. */
function startsWithAsciiIgnoringCase(text: string, needle: string): boolean {
  if (text.length < needle.length) return false;
  for (let i = 0; i < needle.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5a) c += 32;
    if (c !== needle.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Whether an image destination names a local file by relative path — the only
 * kind that can be copied into assets/. Anything with a scheme, an inline data:
 * image, an absolute path and a bare fragment are left untouched.
 */
export function isLocalRelativeReference(url: string): boolean {
  if (url.length === 0) return false;
  if (url.includes('://')) return false;
  if (startsWithAsciiIgnoringCase(url, 'data:')) return false;
  if (startsWithAsciiIgnoringCase(url, 'mailto:')) return false;
  if (url.startsWith('/')) return false;
  if (url.startsWith('#')) return false;
  return true;
}

/**
 * The image syntax the HTML writer draws as `<img>`, so what gets an asset is
 * exactly what shows as an image. The whitespace class is ICU's `\s`, spelled
 * out as md.win spells it: TAB, LF, VT, FF, CR, NEL and every Z — not U+200B,
 * not U+FEFF. `d` gives the destination's own index, `u` makes `\p{Z}` work.
 */
const IMAGE_REFERENCE =
  /!\[[^\]]*\]\(([^)\t\n\v\f\r\u0085\p{Z}]+)(?:[\t\n\v\f\r\u0085\p{Z}]+(?:"[^"]*"|'[^']*'))?\)/dgu;

/** The last `/`-separated component — empty for a trailing slash. */
function lastComponent(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** photo.png → photo-2.png; README → README-2; a dotfile keeps its whole name as the stem. */
function disambiguated(name: string, counter: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-${counter}${name.slice(dot)}` : `${name}-${counter}`;
}

/**
 * Rewrite the document for a bundle: every local image reference `resolve` can
 * satisfy is copied into assets/ and its destination rewritten to
 * `assets/<name>`; one it cannot satisfy stays exactly as written. Only the URL
 * is replaced, so a following "title" survives. The same path used twice is one
 * asset, read once; two different paths sharing a file name are told apart
 * (`logo-2.png`), case-insensitively.
 */
export async function exportRewriting(
  source: string,
  resolve: (relativePath: string) => Promise<Uint8Array | null>,
): Promise<Rewrite> {
  const assets: Asset[] = [];
  const assetForPath = new Map<string, string>();
  const usedNames = new Set<string>();
  const edits: { start: number; end: number; replacement: string }[] = [];

  for (const match of source.matchAll(IMAGE_REFERENCE)) {
    const url = match[1];
    const span = match.indices?.[1];
    if (url === undefined || span === undefined || !isLocalRelativeReference(url)) continue;

    const existing = assetForPath.get(url);
    if (existing !== undefined) {
      edits.push({ start: span[0], end: span[1], replacement: `assets/${existing}` });
      continue;
    }
    const data = await resolve(url);
    if (data === null) continue;
    const baseName = lastComponent(url);
    if (baseName.length === 0) continue;

    let name = baseName;
    for (let counter = 2; usedNames.has(name.toLowerCase()); counter++) name = disambiguated(baseName, counter);
    usedNames.add(name.toLowerCase());
    assetForPath.set(url, name);
    assets.push({ name, data });
    edits.push({ start: span[0], end: span[1], replacement: `assets/${name}` });
  }

  if (edits.length === 0) return { text: source, assets };
  let text = '';
  let cursor = 0;
  for (const edit of edits) {
    text += source.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return { text: text + source.slice(cursor), assets };
}

const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

/** The bundle's files: text.md (UTF-8, no BOM), info.json, and the assets. */
export function bundleFiles(rewrite: Rewrite): { text: Uint8Array; info: Uint8Array; assets: Asset[] } {
  return { text: utf8(rewrite.text), info: utf8(INFO_JSON), assets: rewrite.assets };
}

/**
 * A .textpack's entries, nested under `<folderName>.textbundle/` as every md
 * app writes them: info.json, text.md, then the assets — or an explicit empty
 * `assets/` entry, so the folder is always there.
 */
export function packEntries(folderName: string, rewrite: Rewrite): ZipEntry[] {
  const root = `${folderName}${BUNDLE_EXTENSION}/`;
  const files = bundleFiles(rewrite);
  const entries: ZipEntry[] = [
    { name: root + INFO_FILE_NAME, data: files.info },
    { name: root + TEXT_FILE_NAME, data: files.text },
  ];
  if (files.assets.length === 0) entries.push({ name: `${root}${ASSETS_DIRECTORY_NAME}/`, data: new Uint8Array(0) });
  else for (const asset of files.assets) entries.push({ name: `${root}${ASSETS_DIRECTORY_NAME}/${asset.name}`, data: asset.data });
  return entries;
}
