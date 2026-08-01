//
//  zip.ts
//  md.vscode — the hand-rolled zip container the EPUB writer packs into.
//
//  A port of `StoredZip` in `md/md/DocumentExport.swift`, widened by exactly
//  one degree of freedom: an entry may be DEFLATE'd as well as stored. The
//  EPUB path never uses that freedom (see below); it exists because Node hands
//  us `deflateRawSync` for free and a future `.textpack` writer would want it.
//
//  WHY THIS IS HAND-WRITTEN AND NOT JSZip / archiver / adm-zip
//  ----------------------------------------------------------
//  Every general-purpose zip library writes the real modification time into
//  each entry and defaults to DEFLATE. Both are byte differences from what the
//  three shipping apps produce, on every single export, for no gain that a
//  reader can see. This writer instead stamps a **fixed DOS date of
//  1980-01-01** into every entry, exactly as Swift and Kotlin do: the OPF
//  carries the real `dcterms:modified`, so the archive itself has nothing to
//  say about when it was made, and a stable archive is trivially testable.
//  ~120 lines of arithmetic buys byte parity with three other platforms.
//
//  THE ONE RULE THIS WRITER DOES NOT ENFORCE
//  -----------------------------------------
//  An EPUB's `mimetype` entry must come **first** and must be **stored**, and
//  the OCF specification is emphatic about it — readers sniff the first entry's
//  payload at a fixed offset, so a compressed or later-placed `mimetype` is
//  rejected outright by Apple Books, Kobo and `epubcheck` alike. That is the
//  caller's contract, not this file's: `epub.ts` builds its entry list in the
//  required order and asks for no compression, and `assertEpubOrder` below is
//  offered so a caller can say so out loud.
//

import { deflateRawSync } from 'node:zlib';

/** One archive member. */
export interface ZipEntry {
  /** The path inside the archive. Always `/`-separated, never absolute. */
  name: string;
  data: Uint8Array;
  /**
   * DEFLATE this entry rather than storing it. **Defaults to false**, and the
   * EPUB packer never sets it: stored-only is what the apps emit, and the byte
   * parity contract covers the whole container.
   */
  compress?: boolean;
}

/** The mimetype an EPUB's first entry must carry, byte for byte. */
export const EPUB_MIMETYPE = 'application/epub+zip';

// MARK: - CRC-32

/**
 * The zip / PNG CRC-32 table, polynomial `0xEDB88320`, built once.
 *
 * `>>> 0` after every shift because JavaScript's bitwise operators work on
 * *signed* 32-bit integers: without it the table fills with negatives, the
 * final `crc ^ 0xFFFFFFFF` comes out negative too, and the four bytes written
 * to the header are the two's-complement of what every other zip writer emits.
 * The archive then opens fine in a lenient reader and fails `epubcheck`.
 */
const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? ((value >>> 1) ^ 0xedb88320) >>> 0 : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

/** Standard CRC-32, init and final `0xFFFFFFFF`. Returns an unsigned 32-bit value. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc >>> 8) ^ TABLE[(crc ^ data[i]) & 0xff]) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// MARK: - The archive

/**
 * The fixed DOS date, 1980-01-01, and the fixed DOS time, midnight.
 *
 * 0x0021 is `(year - 1980) << 9 | month << 5 | day` with year 1980, month 1,
 * day 1 — the earliest date the format can express, which is as close to "no
 * timestamp" as a zip entry gets.
 */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

/** Method codes. 0 is STORED, 8 is raw DEFLATE (RFC 1951, no zlib wrapper). */
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/**
 * Pack `entries` into a zip archive, in the order given.
 *
 * Local headers and payloads first, then the central directory, then the
 * end-of-central-directory record — everything little-endian, no zip64, no
 * data descriptors, no archive comment.
 */
export function archive(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    // The name is UTF-8 with no flag bit set. Everything the EPUB packer names
    // is ASCII (`OEBPS/u001.xhtml`, `images/content-01.png`), so bit 11 — the
    // "language encoding" flag — is deliberately left clear: setting it would
    // be a byte difference from the apps for names that cannot need it.
    const name = Buffer.from(entry.name, 'utf8');
    const uncompressed = Buffer.from(
      entry.data.buffer,
      entry.data.byteOffset,
      entry.data.byteLength,
    );
    const crc = crc32(entry.data);

    // Raw DEFLATE, not `deflateSync`: method 8 in a zip is the bare RFC 1951
    // stream. `deflateSync` would wrap it in the two-byte zlib header and an
    // Adler-32 trailer, which every reader would then read as corrupt payload.
    const compress = entry.compress === true;
    const payload = compress ? deflateRawSync(uncompressed) : uncompressed;
    const method = compress ? METHOD_DEFLATE : METHOD_STORED;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract (2.0)
    local.writeUInt16LE(0, 6); // general purpose flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18); // compressed size
    local.writeUInt32LE(uncompressed.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    parts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // offset of the local header
    directory.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // number of this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // entries in total
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16); // where the directory starts
  end.writeUInt16LE(0, 20); // archive comment length

  return Buffer.concat([...parts, directoryBytes, end]);
}

/**
 * Throw unless `entries` opens the way an EPUB's OCF container must.
 *
 * Called by the EPUB packer immediately before `archive`. It is a guard
 * against a future edit rather than against today's code: the entry list is
 * built literally, one array, `mimetype` on the first line — but that array is
 * exactly the kind of thing somebody sorts by name one day, and the resulting
 * file is rejected by every reader with no clue as to why.
 */
export function assertEpubOrder(entries: readonly ZipEntry[]): void {
  const first = entries[0];
  if (first === undefined || first.name !== 'mimetype') {
    throw new Error("EPUB: the first archive entry must be 'mimetype'");
  }
  if (first.compress === true) {
    throw new Error('EPUB: the mimetype entry must be stored, never compressed');
  }
  if (Buffer.from(first.data).toString('utf8') !== EPUB_MIMETYPE) {
    throw new Error(`EPUB: the mimetype entry must read exactly '${EPUB_MIMETYPE}'`);
  }
}
