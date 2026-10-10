//
//  epub-metadata.ts
//  md.vscode — an EPUB's metadata and cover from the document's front matter.
//
//  The package document used to carry a title, an identifier and a language
//  fixed at "en", and nothing else: a book exported from md reached a reader's
//  library with no author, no date and no cover. From 1.6 every md EPUB writer
//  reads these front-matter keys — the same keys, the same rules, the same
//  lines in the same order, so the five ports' package documents agree:
//
//    author        → <dc:creator>
//    language      → <dc:language>, when it is a language tag; otherwise "en"
//    date          → <dc:date>, when it is a W3C date; otherwise left out
//    description   → <dc:description>
//    series        → a belongs-to-collection of collection-type "series",
//    series_index    with its group-position when the index is a number
//    cover         → a cover-image item, when the image can be read
//
//  A key is matched as `title:` already is: case-insensitively, the first
//  non-empty value winning, trimmed of whitespace and newlines.
//
//  The cover is the one key that needs reading. It is used when its bytes can
//  be had — a `data:` image, an `https:` image, or a file beside the document —
//  and are a PNG, JPEG, GIF or WebP by their own magic numbers; anything else
//  is skipped silently and the book is written without a cover. The reading is
//  the caller's; this module only classifies the reference and the bytes.
//
//  Pure: no `vscode`, no file system, no network.
//

import type { MetadataField } from '../render/types';
import { trimWSNL } from '../render/text';

/** What a document's front matter adds to its package document. */
export interface EpubMetadata {
  creator: string | null;
  /** Always set: the front matter's tag, or "en". */
  language: string;
  date: string | null;
  description: string | null;
  series: string | null;
  seriesIndex: string | null;
}

/** A cover image, recognised by its bytes. */
export interface EpubCover {
  /** `png`, `jpg`, `gif` or `webp` — the archive name is `images/cover.<extension>`. */
  extension: string;
  mediaType: string;
  data: Uint8Array;
}

/** The metadata a document with no front matter gets: the package document as it always was. */
export const DEFAULT_METADATA: EpubMetadata = {
  creator: null,
  language: 'en',
  date: null,
  description: null,
  series: null,
  seriesIndex: null,
};

/** A cover larger than this is skipped: a reader shows a thumbnail, not a poster. */
export const MAX_COVER_BYTES = 20 * 1024 * 1024;

/** The first non-empty value of `key`, matched case-insensitively — `documentTitle`'s rule. */
export function fieldValue(fields: readonly MetadataField[] | null, key: string): string | null {
  for (const field of fields ?? []) {
    if (field.key.toLowerCase() !== key) continue;
    const value = trimWSNL(field.value);
    if (value.length > 0) return value;
  }
  return null;
}

/** A BCP 47-shaped tag, ASCII only: `en`, `ru`, `pt-BR`, `zh-Hant-TW`. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
/** W3CDTF, which is what EPUB asks of dc:date: a year, a month, a day, or a full moment with its zone. */
const W3C_DATE = /^[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:Z|[+-][0-9]{2}:[0-9]{2}))?)?)?$/;
/** A position in a series: `3`, `2.5`. */
const SERIES_INDEX = /^[0-9]+(?:\.[0-9]+)?$/;

/** The package document's metadata from a document's front matter. */
export function epubMetadata(fields: readonly MetadataField[] | null): EpubMetadata {
  const language = fieldValue(fields, 'language');
  const date = fieldValue(fields, 'date');
  const series = fieldValue(fields, 'series');
  const seriesIndex = fieldValue(fields, 'series_index');
  return {
    creator: fieldValue(fields, 'author'),
    language: language !== null && LANGUAGE_TAG.test(language) ? language : 'en',
    date: date !== null && W3C_DATE.test(date) ? date : null,
    description: fieldValue(fields, 'description'),
    series,
    seriesIndex: series !== null && seriesIndex !== null && SERIES_INDEX.test(seriesIndex) ? seriesIndex : null,
  };
}

/** Where a `cover:` value says the image is. */
export type CoverReference =
  | { kind: 'data'; data: Uint8Array }
  | { kind: 'https'; url: string }
  | { kind: 'local'; path: string };

const startsWithAsciiIgnoringCase = (text: string, prefix: string): boolean =>
  text.length >= prefix.length && text.slice(0, prefix.length).replace(/[A-Z]/g, (c) => c.toLowerCase()) === prefix;

/**
 * Classify a `cover:` value, or null when it can never be read: a `data:` URI
 * that is not base64, an `http:` or any other scheme, an absolute path, a
 * fragment. A `data:` image is decoded here; a payload that is not strict
 * base64 is null too.
 */
export function coverReference(value: string | null): CoverReference | null {
  if (value === null || value.length === 0) return null;
  if (startsWithAsciiIgnoringCase(value, 'data:')) {
    const comma = value.indexOf(',');
    if (comma < 0) return null;
    const header = value.slice(5, comma);
    if (!/;base64$/i.test(header)) return null;
    const payload = value.slice(comma + 1);
    if (payload.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) return null;
    return { kind: 'data', data: new Uint8Array(Buffer.from(payload, 'base64')) };
  }
  if (startsWithAsciiIgnoringCase(value, 'https://')) return { kind: 'https', url: value };
  if (value.includes('://') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return null;
  if (value.startsWith('/') || value.startsWith('\\') || value.startsWith('#')) return null;
  return { kind: 'local', path: value };
}

/** A cover from its bytes: PNG, JPEG, GIF or WebP by magic number, and no larger than the cap. */
export function recogniseCover(data: Uint8Array | null): EpubCover | null {
  if (data === null || data.length === 0 || data.length > MAX_COVER_BYTES) return null;
  const at = (offset: number, bytes: readonly number[]) =>
    data.length >= offset + bytes.length && bytes.every((b, i) => data[offset + i] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { extension: 'png', mediaType: 'image/png', data };
  if (at(0, [0xff, 0xd8, 0xff])) return { extension: 'jpg', mediaType: 'image/jpeg', data };
  if (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return { extension: 'gif', mediaType: 'image/gif', data };
  }
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return { extension: 'webp', mediaType: 'image/webp', data };
  return null;
}

/** The cover's archive path inside OEBPS/. */
export function coverHref(cover: EpubCover): string {
  return `images/cover.${cover.extension}`;
}
