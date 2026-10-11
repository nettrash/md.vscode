//
//  textbundle.test.ts
//  md.vscode — TextBundle and TextPack export (#6), held to md.win's vectors.
//
//  Every case below is one of md.win's `TextBundleTests` (itself the macOS and
//  Kotlin suites' twin), so the five md writers rewrite a document the same
//  way: which references are local, the ICU whitespace a destination stops at,
//  how a second `logo.png` is named, what the pack holds and in what order.
//  The asset reader's containment cases use real temporary folders and
//  symlinks, as md.win's do.
//

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { isInside, readLocalAsset } from '../src/export/asset-reader';
import {
  INFO_JSON,
  bundleFiles,
  exportRewriting,
  isLocalRelativeReference,
  packEntries,
} from '../src/export/textbundle';
import { archive } from '../src/export/zip';

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
const decode = (b: Uint8Array) => Buffer.from(b).toString('utf8');
const one = async () => new Uint8Array([1]);

describe('info.json', () => {
  it('has the TextBundle shape, in the family’s canonical bytes', () => {
    const parsed = JSON.parse(INFO_JSON);
    expect(parsed).toEqual({ version: 2, type: 'net.daringfireball.markdown', transient: false });
    expect(INFO_JSON).toBe('{\n  "version": 2,\n  "type": "net.daringfireball.markdown",\n  "transient": false\n}');
    expect(utf8(INFO_JSON).length).toBe(81);
  });
});

describe('exportRewriting — the image-reference rewrite', () => {
  it('copies a found image and leaves the rest untouched', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const source = '![cat](photo.png) ![dog](missing.png) ![web](https://e/x.png)';
    const result = await exportRewriting(source, async (p) => (p === 'photo.png' ? png : null));
    expect(result.text).toBe('![cat](assets/photo.png) ![dog](missing.png) ![web](https://e/x.png)');
    expect(result.assets).toEqual([{ name: 'photo.png', data: png }]);
  });

  it('keeps an image title, in either quote, after any whitespace run', async () => {
    expect((await exportRewriting('![alt](pic.png "A cat")', one)).text).toBe('![alt](assets/pic.png "A cat")');
    expect((await exportRewriting("![alt](pic.png 'A cat')", one)).text).toBe("![alt](assets/pic.png 'A cat')");
    expect((await exportRewriting('![alt](pic.png\t"A cat")', one)).text).toBe('![alt](assets/pic.png\t"A cat")');
  });

  it('names a second logo.png apart, but reads one path once', async () => {
    const source = '![a](a/logo.png) ![b](b/logo.png) ![c](a/logo.png)';
    const calls: string[] = [];
    const result = await exportRewriting(source, async (p) => {
      calls.push(p);
      return new Uint8Array([7]);
    });
    expect(result.assets.map((a) => a.name)).toEqual(['logo.png', 'logo-2.png']);
    expect(result.text).toBe('![a](assets/logo.png) ![b](assets/logo-2.png) ![c](assets/logo.png)');
    expect(calls).toEqual(['a/logo.png', 'b/logo.png']);
  });

  it('disambiguates dotfiles, extensionless and double-extension names', async () => {
    const names = async (source: string) => (await exportRewriting(source, one)).assets.map((a) => a.name);
    expect(await names('![a](x/.keep) ![b](y/.keep)')).toEqual(['.keep', '.keep-2']);
    expect(await names('![a](x/README) ![b](y/README) ![c](z/README)')).toEqual(['README', 'README-2', 'README-3']);
    expect(await names('![a](x/a.tar.gz) ![b](y/a.tar.gz)')).toEqual(['a.tar.gz', 'a.tar-2.gz']);
  });

  it('dedupes names case-insensitively', async () => {
    const result = await exportRewriting('![a](x/Logo.PNG) ![b](y/logo.png) ![c](z/ICON.PNG) ![d](w/icon.png)', one);
    expect(result.assets.map((a) => a.name)).toEqual(['Logo.PNG', 'logo-2.png', 'ICON.PNG', 'icon-2.png']);
  });

  it('stops a destination at every ICU whitespace, and only there', async () => {
    for (const gap of [' ', '\u000b', '\u0085', ' ', ' ', ' ']) {
      const source = `![a](pic${gap}x.png)`;
      const result = await exportRewriting(source, one);
      expect(result.text, JSON.stringify(gap)).toBe(source);
      expect(result.assets).toEqual([]);
    }
    for (const notGap of ['​', '﻿']) {
      const result = await exportRewriting(`![a](pic${notGap}x.png)`, one);
      expect(result.text, JSON.stringify(notGap)).toBe(`![a](assets/pic${notGap}x.png)`);
    }
  });

  it('leaves the source alone when nothing resolves, and skips a folder reference', async () => {
    const source = '# Title\n\n![a](x.png) and `![b](y.png)`\n';
    const result = await exportRewriting(source, async () => null);
    expect(result.text).toBe(source);
    expect(result.assets).toEqual([]);
    const folder = await exportRewriting('![a](dir/)', one);
    expect(folder.text).toBe('![a](dir/)');
    expect(folder.assets).toEqual([]);
  });

  it('rewrites every occurrence in document order, the text between intact', async () => {
    const source = 'Начало ![a](a.png) середина ![b](sub/b.png "t") конец ![a](a.png).';
    const result = await exportRewriting(source, async (p) => utf8(p));
    expect(result.text).toBe('Начало ![a](assets/a.png) середина ![b](assets/b.png "t") конец ![a](assets/a.png).');
    expect(result.assets).toEqual([
      { name: 'a.png', data: utf8('a.png') },
      { name: 'b.png', data: utf8('sub/b.png') },
    ]);
  });
});

describe('isLocalRelativeReference', () => {
  it('classifies as md.win does', () => {
    expect(isLocalRelativeReference('photo.png')).toBe(true);
    expect(isLocalRelativeReference('images/photo.png')).toBe(true);
    for (const url of [
      'https://x/y.png',
      'http://x/y.png',
      'data:image/png;base64,AAAA',
      '/abs/photo.png',
      '#anchor',
      '',
      'mailto:me@example.com',
      'file:///x/y.png',
    ]) {
      expect(isLocalRelativeReference(url), url).toBe(false);
    }
  });

  it('is code-unit exact around combining marks', () => {
    expect(isLocalRelativeReference('café/photo.png')).toBe(true);
    expect(isLocalRelativeReference('https://hóst/x.png')).toBe(false);
    expect(isLocalRelativeReference('weird:́//name.png')).toBe(true);
  });

  it('folds schemes ASCII-only', () => {
    expect(isLocalRelativeReference('DATA:image/png;base64,AAAA')).toBe(false);
    expect(isLocalRelativeReference('MailTo:me@example.com')).toBe(false);
    // Swift's and Kotlin's full case mapping lower İ to "i" + U+0307, so neither
    // of these is a scheme on any sibling.
    expect(isLocalRelativeReference('MAİLTO:x.png')).toBe(true);
    expect(isLocalRelativeReference('datİ:x.png')).toBe(true);
  });
});

describe('the bundle and the pack', () => {
  it('holds text.md as UTF-8 without a BOM, info.json and the assets', () => {
    const assets = [{ name: 'p.png', data: new Uint8Array([1, 2]) }];
    const files = bundleFiles({ text: '# Hi\n', assets });
    expect(decode(files.text)).toBe('# Hi\n');
    expect(decode(files.info)).toBe(INFO_JSON);
    expect(files.assets).toEqual(assets);
    expect([...bundleFiles({ text: 'П', assets: [] }).text]).toEqual([0xd0, 0x9f]);
  });

  it('nests the pack under <name>.textbundle/, with an empty assets/ only when there are none', () => {
    const entries = packEntries('Doc', { text: '# Hi\n', assets: [{ name: 'p.png', data: new Uint8Array([1, 2]) }] });
    expect(entries.map((e) => e.name)).toEqual([
      'Doc.textbundle/info.json',
      'Doc.textbundle/text.md',
      'Doc.textbundle/assets/p.png',
    ]);
    expect(decode(entries[1].data)).toBe('# Hi\n');
    expect([...entries[2].data]).toEqual([1, 2]);
    const bare = packEntries('Doc', { text: 'plain\n', assets: [] });
    expect(bare.map((e) => e.name)).toEqual([
      'Doc.textbundle/info.json',
      'Doc.textbundle/text.md',
      'Doc.textbundle/assets/',
    ]);
  });

  it('archives into a pack a foreign reader opens', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const rewrite = await exportRewriting('![c](photo.png)', async () => png);
    const pack = archive(packEntries('Doc', rewrite));
    expect([...pack.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-textpack-'));
    try {
      const file = path.join(dir, 'Doc.textpack');
      fs.writeFileSync(file, pack);
      const listing = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n');
      expect(listing).toEqual(['Doc.textbundle/info.json', 'Doc.textbundle/text.md', 'Doc.textbundle/assets/photo.png']);
      expect(execFileSync('unzip', ['-p', file, 'Doc.textbundle/text.md'], { encoding: 'utf8' })).toBe('![c](assets/photo.png)');
      expect([...execFileSync('unzip', ['-p', file, 'Doc.textbundle/assets/photo.png'])]).toEqual([...png]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readLocalAsset — containment', () => {
  const roots: string[] = [];
  const folder = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-textbundle-')));
    roots.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds a file beside the document and nothing else', async () => {
    const root = folder();
    const docs = path.join(root, 'docs');
    fs.mkdirSync(path.join(docs, 'images'), { recursive: true });
    const document = path.join(docs, 'notes.md');
    fs.writeFileSync(document, '# n\n');
    fs.writeFileSync(path.join(docs, 'photo.png'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(docs, 'images', 'deep.png'), Buffer.from([4]));
    fs.writeFileSync(path.join(root, 'outside.png'), Buffer.from([9]));

    expect([...((await readLocalAsset('photo.png', document)) ?? [])]).toEqual([1, 2, 3]);
    expect([...((await readLocalAsset('images/deep.png', document)) ?? [])]).toEqual([4]);
    expect([...((await readLocalAsset('images/../photo.png', document)) ?? [])]).toEqual([1, 2, 3]);
    expect(await readLocalAsset('missing.png', document)).toBeNull();
    expect(await readLocalAsset('images', document)).toBeNull();
    expect(await readLocalAsset('../outside.png', document)).toBeNull();
    expect(await readLocalAsset('images/../../outside.png', document)).toBeNull();
    expect(await readLocalAsset(path.join(root, 'outside.png'), document)).toBeNull();
    expect(await readLocalAsset('photo.png', null)).toBeNull();
  });

  it('resolves symlinks before the containment test', async () => {
    const root = folder();
    const docs = path.join(root, 'docs');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(docs);
    fs.mkdirSync(elsewhere);
    const document = path.join(docs, 'notes.md');
    fs.writeFileSync(document, '# n\n');
    fs.writeFileSync(path.join(elsewhere, 'secret.png'), Buffer.from([0x53]));
    fs.writeFileSync(path.join(docs, 'real.png'), Buffer.from([0x52]));
    fs.symlinkSync(path.join(elsewhere, 'secret.png'), path.join(docs, 'link.png'));
    fs.symlinkSync(elsewhere, path.join(docs, 'imgs'));
    fs.symlinkSync(path.join(docs, 'real.png'), path.join(docs, 'same.png'));

    expect(await readLocalAsset('link.png', document)).toBeNull();
    expect(await readLocalAsset('imgs/secret.png', document)).toBeNull();
    expect([...((await readLocalAsset('same.png', document)) ?? [])]).toEqual([0x52]);
  });
});

describe('isInside — containment by relative path', () => {
  it('finds a neighbour of a document at a file-system root', () => {
    expect(isInside('/', '/photo.png', path.posix)).toBe(true);
    expect(isInside('C:\\', 'C:\\photo.png', path.win32)).toBe(true);
    expect(isInside('/docs', '/docs/a/b.png', path.posix)).toBe(true);
  });

  it('refuses the folder itself, a climb, a sibling folder and another drive', () => {
    expect(isInside('/docs', '/docs', path.posix)).toBe(false);
    expect(isInside('/docs', '/outside.png', path.posix)).toBe(false);
    expect(isInside('/docs', '/docs-2/a.png', path.posix)).toBe(false);
    expect(isInside('C:\\docs', 'D:\\docs\\a.png', path.win32)).toBe(false);
  });

  it('does not mistake a name that starts with two dots for a climb', () => {
    expect(isInside('/docs', '/docs/..cover.png', path.posix)).toBe(true);
  });
});

describe('the zip writer’s UTF-8 name flag', () => {
  const flagsOf = (zip: Uint8Array) => {
    const view = Buffer.from(zip);
    const local = view.readUInt16LE(6);
    const at = view.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    return { local, central: view.readUInt16LE(at + 8) };
  };

  it('stays clear for ASCII names, so every EPUB keeps its bytes', () => {
    expect(flagsOf(archive([{ name: 'OEBPS/content.opf', data: utf8('x') }]))).toEqual({ local: 0, central: 0 });
  });

  it('is set for a non-ASCII name, and a reader then finds the file by it', () => {
    const pack = archive(packEntries('Заметки', { text: '![](assets/фото.png)', assets: [{ name: 'фото.png', data: new Uint8Array([1]) }] }));
    expect(flagsOf(pack)).toEqual({ local: 0x0800, central: 0x0800 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-textpack-utf8-'));
    try {
      const file = path.join(dir, 'p.textpack');
      fs.writeFileSync(file, pack);
      // Python's zipfile follows the specification — UTF-8 when bit 11 is set,
      // CP437 otherwise — where macOS's bundled unzip mangles the name either way.
      const script = 'import sys, zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))';
      const listing = execFileSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' }).trim().split('\n');
      expect(listing).toEqual(['Заметки.textbundle/info.json', 'Заметки.textbundle/text.md', 'Заметки.textbundle/assets/фото.png']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
