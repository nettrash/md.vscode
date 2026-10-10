//
//  epub-metadata.test.ts
//  md.vscode — EPUB metadata and cover from front matter (#7).
//
//  These vectors are the family's: md for iPhone and iPad, Mac, Android and
//  Windows carry the same ones, so the five package documents agree on which
//  keys count, which values are accepted, and the exact lines they become.
//

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { contentOPF, metadataLines, packDocumentEpub } from '../src/export/epub';
import {
  DEFAULT_METADATA,
  MAX_COVER_BYTES,
  coverReference,
  epubMetadata,
  recogniseCover,
} from '../src/export/epub-metadata';
import { frontMatter } from '../src/render/parser';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = Uint8Array.from(Buffer.from('GIF89a\x01\x00', 'latin1'));
const WEBP = Uint8Array.from(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1'));

const lines = (matter: string, cover = recogniseCover(null)) =>
  metadataLines(epubMetadata(frontMatter(`---\n${matter}\n---\n\n# Body\n`)), cover);

describe('metadata lines from front matter', () => {
  it('is the one language line every md EPUB has always carried when there is no front matter', () => {
    expect(metadataLines(epubMetadata(null), null)).toEqual(['<dc:language>en</dc:language>']);
    expect(metadataLines(DEFAULT_METADATA, null)).toEqual(['<dc:language>en</dc:language>']);
    expect(lines('title: Only a title')).toEqual(['<dc:language>en</dc:language>']);
  });

  it('writes every key, in the family order', () => {
    expect(
      lines(
        [
          'title: The Book',
          'author: Ada Lovelace',
          'language: ru',
          'date: 2026-10-10',
          'description: Notes on the "Engine" & more',
          'series: Analytical',
          'series_index: 2',
        ].join('\n'),
        recogniseCover(PNG),
      ),
    ).toEqual([
      '<dc:creator>Ada Lovelace</dc:creator>',
      '<dc:language>ru</dc:language>',
      '<dc:date>2026-10-10</dc:date>',
      '<dc:description>Notes on the &quot;Engine&quot; &amp; more</dc:description>',
      '<meta property="belongs-to-collection" id="series">Analytical</meta>',
      '<meta refines="#series" property="collection-type">series</meta>',
      '<meta refines="#series" property="group-position">2</meta>',
      '<meta name="cover" content="cover-image"/>',
    ]);
  });

  it('matches keys case-insensitively, first non-empty value wins, quotes stripped', () => {
    expect(lines('Author:\nAUTHOR: "Grace Hopper"\nauthor: Someone Else')).toEqual([
      '<dc:creator>Grace Hopper</dc:creator>',
      '<dc:language>en</dc:language>',
    ]);
  });

  it('takes a language tag and falls back to en for anything else', () => {
    for (const [value, expected] of [
      ['en', 'en'],
      ['pt-BR', 'pt-BR'],
      ['zh-Hant-TW', 'zh-Hant-TW'],
      ['ast', 'ast'],
      ['English', 'en'],
      ['e', 'en'],
      ['en_US', 'en'],
      ['en-', 'en'],
      ['ру', 'en'],
      ['en-toolongsubtag', 'en'],
    ]) {
      expect(epubMetadata(frontMatter(`---\nlanguage: ${value}\n---\n`)).language, value).toBe(expected);
    }
  });

  it('takes a W3C date and leaves anything else out', () => {
    for (const value of ['2026', '2026-10', '2026-10-10', '2026-10-10T09:30Z', '2026-10-10T09:30:15+03:00']) {
      expect(epubMetadata(frontMatter(`---\ndate: ${value}\n---\n`)).date, value).toBe(value);
    }
    for (const value of ['10/10/2026', 'October 2026', '2026-10-10 09:30', '2026-10-10T09:30', '26-10-10', '２０２６']) {
      expect(epubMetadata(frontMatter(`---\ndate: ${value}\n---\n`)).date, value).toBeNull();
    }
  });

  it('gives a series its position only when the index is a number, and ignores an index without a series', () => {
    expect(lines('series: S\nseries_index: 2.5')).toContain('<meta refines="#series" property="group-position">2.5</meta>');
    expect(lines('series: S\nseries_index: two')).not.toContain('<meta refines="#series" property="group-position">two</meta>');
    expect(lines('series: S\nseries_index: two')).toHaveLength(3);
    expect(lines('series_index: 3')).toEqual(['<dc:language>en</dc:language>']);
  });

  it('escapes as the rest of the package document does, apostrophe left alone', () => {
    expect(lines("author: O'Brien <ob@example.com>")[0]).toBe("<dc:creator>O'Brien &lt;ob@example.com&gt;</dc:creator>");
  });
});

describe('the cover reference', () => {
  it('decodes a base64 data: image and refuses any other data:', () => {
    const b64 = Buffer.from(PNG).toString('base64');
    expect(coverReference(`data:image/png;base64,${b64}`)).toEqual({ kind: 'data', data: PNG });
    expect(coverReference(`DATA:image/png;BASE64,${b64}`)).toEqual({ kind: 'data', data: PNG });
    expect(coverReference('data:image/svg+xml,<svg/>')).toBeNull();
    expect(coverReference('data:image/png;base64,')).toBeNull();
    expect(coverReference('data:image/png;base64,abc')).toBeNull();
    expect(coverReference('data:image/png;base64,ab!d')).toBeNull();
  });

  it('fetches https only', () => {
    expect(coverReference('https://example.com/c.png')).toEqual({ kind: 'https', url: 'https://example.com/c.png' });
    expect(coverReference('HTTPS://example.com/c.png')).toEqual({ kind: 'https', url: 'HTTPS://example.com/c.png' });
    expect(coverReference('http://example.com/c.png')).toBeNull();
    expect(coverReference('ftp://example.com/c.png')).toBeNull();
    expect(coverReference('file:///tmp/c.png')).toBeNull();
  });

  it('reads a relative path from beside the document, and nothing absolute', () => {
    expect(coverReference('cover.png')).toEqual({ kind: 'local', path: 'cover.png' });
    expect(coverReference('images/cover.jpg')).toEqual({ kind: 'local', path: 'images/cover.jpg' });
    expect(coverReference('../cover.png')).toEqual({ kind: 'local', path: '../cover.png' });
    for (const value of ['/tmp/cover.png', '\\\\server\\c.png', 'C:\\c.png', 'c:/c.png', '#cover', 'mailto:x', '', null]) {
      expect(coverReference(value), String(value)).toBeNull();
    }
  });
});

describe('recognising a cover by its bytes', () => {
  it('knows PNG, JPEG, GIF and WebP', () => {
    expect(recogniseCover(PNG)).toMatchObject({ extension: 'png', mediaType: 'image/png' });
    expect(recogniseCover(JPEG)).toMatchObject({ extension: 'jpg', mediaType: 'image/jpeg' });
    expect(recogniseCover(GIF)).toMatchObject({ extension: 'gif', mediaType: 'image/gif' });
    expect(recogniseCover(WEBP)).toMatchObject({ extension: 'webp', mediaType: 'image/webp' });
  });

  it('skips anything else, an empty file and an oversized one', () => {
    expect(recogniseCover(Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBeNull();
    expect(recogniseCover(Uint8Array.from(Buffer.from('RIFF\x24\x00\x00\x00WAVE', 'latin1')))).toBeNull();
    expect(recogniseCover(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(recogniseCover(new Uint8Array(0))).toBeNull();
    expect(recogniseCover(null)).toBeNull();
    const big = new Uint8Array(MAX_COVER_BYTES + 1);
    big.set(PNG);
    expect(recogniseCover(big)).toBeNull();
  });
});

describe('the package document', () => {
  const base = {
    title: 'T',
    identifier: 'urn:uuid:x',
    modified: '2026-10-10T00:00:00Z',
    units: [{ id: 'content', href: 'content.xhtml' }],
    images: ['images/content-01.png'],
  };

  it('is byte-identical to 1.5 without front matter', () => {
    expect(contentOPF(base)).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">',
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
        '<dc:identifier id="book-id">urn:uuid:x</dc:identifier>',
        '<dc:title>T</dc:title>',
        '<dc:language>en</dc:language>',
        '<meta property="dcterms:modified">2026-10-10T00:00:00Z</meta>',
        '</metadata>',
        '<manifest>',
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '<item id="css" href="style.css" media-type="text/css"/>',
        '<item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="img1" href="images/content-01.png" media-type="image/png"/>',
        '</manifest>',
        '<spine>',
        '<itemref idref="content"/>',
        '</spine>',
        '</package>',
      ].join('\n'),
    );
  });

  it('lists the cover last in the manifest and keeps it out of the spine', () => {
    const opf = contentOPF({ ...base, metadata: epubMetadata(null), cover: recogniseCover(JPEG) });
    expect(opf).toContain(
      '<item id="img1" href="images/content-01.png" media-type="image/png"/>\n' +
        '<item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>\n</manifest>',
    );
    expect(opf).toContain('<dc:language>en</dc:language>\n<meta name="cover" content="cover-image"/>\n<meta property="dcterms:modified">');
    expect(opf).not.toContain('<itemref idref="cover-image"/>');
  });

  it('packs the cover after the snapshots, into a file unzip reads', () => {
    const epub = packDocumentEpub({
      title: 'T',
      body: '<h1 id="body">Body</h1>',
      images: [{ href: 'images/content-01.png', data: PNG }],
      outline: [],
      modified: '2026-10-10T00:00:00Z',
      metadata: epubMetadata(frontMatter('---\nauthor: A\nlanguage: de\n---\n')),
      cover: recogniseCover(PNG),
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-epub-cover-'));
    try {
      const file = path.join(dir, 'T.epub');
      fs.writeFileSync(file, epub);
      const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n');
      expect(names.slice(-2)).toEqual(['OEBPS/images/content-01.png', 'OEBPS/images/cover.png']);
      const opf = execFileSync('unzip', ['-p', file, 'OEBPS/content.opf'], { encoding: 'utf8' });
      expect(opf).toContain('<dc:creator>A</dc:creator>\n<dc:language>de</dc:language>\n<meta name="cover" content="cover-image"/>');
      expect([...execFileSync('unzip', ['-p', file, 'OEBPS/images/cover.png'])]).toEqual([...PNG]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
