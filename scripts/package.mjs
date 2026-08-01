#!/usr/bin/env node
//
//  scripts/package.mjs
//  md.vscode — build the .vsix with the Marketplace details page standing in
//  for the repository's own README.
//
//  Why this exists. The Marketplace "Details" tab is always README.md at the
//  root of the .vsix, and vsce has no --readme-path to point it elsewhere; the
//  other two tabs are fixed the same way, Changelog to CHANGELOG.md and
//  License to LICENSE. The listing and the repository README are different
//  documents written for different readers, so the only way to ship both is to
//  put the listing at that filename while vsce runs, and put the real one back
//  afterwards.
//
//  The whole difficulty is the "afterwards". A run that ends early — Ctrl-C, a
//  vsce that exits non-zero, a crash in this script — must not leave the
//  working tree holding the listing under the repository's filename, because
//  the next `git commit -a` would replace the README with nobody noticing.
//  Hence all of the following, each covering one way this can go wrong:
//
//    * the real README is moved OUTSIDE the repository while vsce runs, so no
//      stray second copy can be swept into the .vsix or into a commit;
//    * restoration runs from a finally block, from SIGINT and SIGTERM, and
//      from uncaughtException, and is idempotent, so several of those firing
//      in turn is harmless;
//    * the restored file is hashed and compared against what was there before,
//      and a mismatch is reported loudly rather than left for git to find.
//
//  Usage:
//    node scripts/package.mjs [--list] [any vsce package option]
//
//  --list is consumed here and prints the file manifest before packaging.
//  Everything else is forwarded to `vsce package` untouched, so
//  `-o /tmp/x.vsix` still works.
//

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoReadme = join(repoRoot, 'README.md');
const listingReadme = join(repoRoot, 'marketplace', 'extension-README.md');

const args = process.argv.slice(2);
const wantsManifest = args.includes('--list');
const vsceArgs = args.filter((argument) => argument !== '--list');

// Refuse before touching anything. Packaging without the listing would quietly
// publish the repository README as the details page, and that is only visible
// once the extension is live.
if (!existsSync(listingReadme)) {
  console.error(
    'scripts/package.mjs: marketplace/extension-README.md is missing.\n' +
      '\n' +
      'That file is the Marketplace details page. Without it this script has\n' +
      'nothing to swap in, and packaging anyway would publish the repository\n' +
      'README as the listing — which is only visible once it is live.\n' +
      '\n' +
      'Nothing has been changed.',
  );
  process.exit(1);
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// A rename cannot cross a filesystem boundary, and the holding area sits in the
// system temp directory precisely because it is outside the repository — which
// on some machines means a different volume.
function move(from, to) {
  try {
    renameSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

const holdingDir = mkdtempSync(join(tmpdir(), 'md-vscode-readme-'));
const parkedReadme = join(holdingDir, 'README.md');

// A repository with no README at all is not a state worth defending, but
// admitting the possibility costs three lines and keeps the restore honest
// about what it actually knows.
const hadRepoReadme = existsSync(repoReadme);
const repoReadmeHash = hadRepoReadme ? sha256(repoReadme) : null;

let swapped = false;
let restoreDone = false;
let restoreFailed = false;

function restore() {
  if (restoreDone) {
    return;
  }
  restoreDone = true;

  try {
    if (swapped) {
      // Whatever is at README.md now is this script's copy of the listing.
      if (existsSync(repoReadme)) {
        unlinkSync(repoReadme);
      }
      if (hadRepoReadme) {
        // Outbound was a move, so the repository never held two copies.
        // Inbound is a copy, kept until the hash agrees: a restore that goes
        // wrong then still has the original to point a human at.
        copyFileSync(parkedReadme, repoReadme);
        const restoredHash = sha256(repoReadme);
        if (restoredHash !== repoReadmeHash) {
          restoreFailed = true;
          console.error(
            '\nscripts/package.mjs: README.md was NOT restored byte-identically.\n' +
              `  before: ${repoReadmeHash}\n` +
              `  after:  ${restoredHash}\n` +
              `The original is still at ${parkedReadme} — copy it back by hand.\n` +
              'The holding directory has deliberately been left in place.',
          );
          return;
        }
      }
    }

    rmSync(holdingDir, { recursive: true, force: true });

    if (swapped) {
      console.log(
        hadRepoReadme
          ? '\nRestored README.md — byte-identical to what was there before.'
          : '\nRemoved the swapped-in README.md — there was none here before.',
      );
    }
  } catch (error) {
    restoreFailed = true;
    console.error(
      '\nscripts/package.mjs: failed to put README.md back.\n' +
        `The original is at ${parkedReadme}, and the holding directory has been left in place.`,
    );
    console.error(error);
  }
}

// Node cannot deliver a signal while spawnSync is blocking the event loop, so a
// Ctrl-C during vsce reaches vsce first and this handler only runs once
// spawnSync has returned — by which time the finally block has restored already
// and this is a no-op. It earns its keep for a signal arriving at any other
// moment, which is the window where nothing else would put the README back.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.error(`\nscripts/package.mjs: ${signal} — putting README.md back before exiting.`);
    restore();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

process.on('uncaughtException', (error) => {
  console.error('\nscripts/package.mjs: unexpected failure.');
  console.error(error);
  restore();
  process.exit(1);
});

// `npm exec --no` rather than `npx`, matching .github/workflows/ci.yml: --no
// forbids the install-on-miss behaviour, so a vsce missing from the toolchain
// fails loudly here instead of silently running whatever owns that name on the
// registry.
function run(label, npmArgs) {
  console.log(`\n$ npm ${npmArgs.join(' ')}`);
  // MD_PACKAGE_VIA_SCRIPT is the token `scripts/prepublish.mjs` checks for.
  // vsce runs `vscode:prepublish` in a child process before it packages, so
  // that child is the one moment where a *direct* `vsce package` can be caught
  // and stopped — see the long note in prepublish.mjs for why silently letting
  // it through is the worst of the available outcomes.
  const result = spawnSync('npm', npmArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, MD_PACKAGE_VIA_SCRIPT: '1' },
  });

  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    const error = new Error(`${label} was killed by ${result.signal}.`);
    // A Ctrl-C reaches the whole foreground process group, so vsce dies of it
    // before this script hears about it. Report it the way a shell would —
    // 128 + the signal number — rather than flattening it to a generic 1.
    error.exitStatus = 128 + (constants.signals[result.signal] ?? 1);
    throw error;
  }
  if (result.status !== 0) {
    const error = new Error(`${label} exited with status ${result.status}.`);
    error.exitStatus = result.status;
    throw error;
  }
}

let exitCode = 0;

try {
  if (hadRepoReadme) {
    move(repoReadme, parkedReadme);
  }
  // Set BEFORE the copy, not after it. From the moment the move succeeds the
  // repository has no README of its own, so a copy that throws half-way — a
  // full disk, a permissions change — is precisely the case that most needs
  // restoring. `restore()` is written to cope with README.md being absent,
  // present and wrong, or present and half-written.
  swapped = true;
  copyFileSync(listingReadme, repoReadme);

  console.log('Swapped marketplace/extension-README.md in as README.md.');
  console.log(`The repository README is parked at ${parkedReadme} until this finishes.`);

  if (wantsManifest) {
    // The manifest is a list of paths, and README.md is on it either way, so
    // this does not strictly need the swap. It runs inside it regardless, so
    // that the whole packaging step sees one tree in one state — one fewer
    // thing to reason about when a listing change and an .vscodeignore change
    // land in the same commit.
    run('vsce ls', ['exec', '--no', '--', 'vsce', 'ls']);
  }

  run('vsce package', ['exec', '--no', '--', 'vsce', 'package', ...vsceArgs]);
} catch (error) {
  if (typeof error.exitStatus === 'number') {
    console.error(`\nscripts/package.mjs: ${error.message}`);
    exitCode = error.exitStatus;
  } else {
    console.error('\nscripts/package.mjs: unexpected failure.');
    console.error(error);
    exitCode = 1;
  }
} finally {
  restore();
}

process.exit(restoreFailed ? 1 : exitCode);
