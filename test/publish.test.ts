//
//  publish.test.ts
//  md.vscode — the order `scripts/publish.mjs` does things in.
//
//  WHY AN ORDER IS WORTH A TEST
//  ----------------------------
//  The script states its own invariant at the top: the same bytes go to both
//  registries, because "publishing them separately is how two registries come
//  to hold two different builds of the same version number". The dangerous
//  half of that is not the bytes — it is the *sequence*. A publish is not
//  undoable: once `vsce` has 1.3.0, `vsce` will refuse 1.3.0 again. So every
//  question that can fail has to be asked before the first upload, or a
//  failure answering it costs a version number.
//
//  The question that fails is `ovsx verify-pat`: it is the one call that says
//  whether the namespace has been claimed and whether this token may publish
//  into it, and both are one-time setup steps nobody remembers skipping (the
//  CI workflow says in so many words that neither has been done for this
//  repository yet). Asked *after* the Marketplace upload, as it was, the
//  first tagged release would have put 1.3.0 on the Marketplace, failed with
//  "Unknown namespace: nettrash", left Open VSX empty, and made the two
//  registries disagree about a version that can never be published again.
//
//  So this suite runs the real script — in a temporary directory of its own,
//  with a fake `npm` on `PATH` that records what it was asked to do — and
//  asserts what happened, not what the source says. Nothing reaches a
//  network: the shim is the only `npm` the script can find.
//

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.join(__dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

/**
 * A throwaway copy of everything the script reads: itself, the manifest it
 * takes the name, version and publisher from, and a `.vsix` of that exact
 * name so that nothing tries to build one.
 *
 * A copy rather than the repository, because the script resolves its root
 * from its own location and would otherwise publish — or try to — from here.
 */
function sandbox(): string {
  // `realpath`, because macOS hands out `/var/folders/…` and the script
  // resolves its own location to `/private/var/folders/…`.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'md-publish-')));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'bin'));
  writeFileSync(
    path.join(root, 'scripts', 'publish.mjs'),
    readFileSync(path.join(repoRoot, 'scripts', 'publish.mjs')),
  );
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      { name: manifest.name, version: manifest.version, publisher: manifest.publisher },
      null,
      2,
    ),
  );
  writeFileSync(path.join(root, `${manifest.name}-${manifest.version}.vsix`), 'a package');
  return root;
}

/**
 * A fake `npm` that appends its arguments to a log and exits 0 — or, when
 * `failing` names a command, exits 1 for that one with the message the real
 * tool prints.
 */
function fakeNpm(root: string, failing: string | null): void {
  const shim = path.join(root, 'bin', 'npm');
  const fail =
    failing === null
      ? ''
      : `case "$*" in\n  *"${failing}"*) echo "Unknown namespace: ${manifest.publisher}" >&2; exit 1 ;;\nesac\n`;
  writeFileSync(shim, `#!/bin/sh\necho "$@" >> "$NPM_LOG"\n${fail}exit 0\n`);
  chmodSync(shim, 0o755);
}

/** Run the script in its sandbox, and hand back its exit status and the npm calls in order. */
function publish(
  root: string,
  args: readonly string[] = [],
  env: Record<string, string> = {},
): { status: number; calls: string[] } {
  const log = path.join(root, 'npm.log');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'publish.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      // The shim first, then whatever is needed to run `node` itself. No
      // inherited PATH: the point is that the script cannot reach a real npm.
      PATH: `${path.join(root, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      NPM_LOG: log,
      VSCE_PAT: 'marketplace-token',
      OVSX_PAT: 'open-vsx-token',
      ...env,
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
    : [];
  return { status: result.status ?? -1, calls };
}

/** Which tool a recorded `npm exec --no -- <tool> <verb> …` line invoked. */
const tool = (call: string): string => call.replace(/^exec --no -- /, '').split(/\s+/).slice(0, 2).join(' ');

// `sh` and an executable bit: a Windows runner would need a different shim,
// and this repository's CI is Ubuntu.
const posix = process.platform !== 'win32';

describe('scripts/publish.mjs — nothing is uploaded before every check has been made', () => {
  it.skipIf(!posix)('verifies the Open VSX namespace before the Marketplace upload', () => {
    // The failure that costs a version number: the namespace has not been
    // claimed. Whatever else happens, the Marketplace must not already hold
    // the build by the time anyone finds out.
    const root = sandbox();
    fakeNpm(root, 'ovsx verify-pat');
    const { status, calls } = publish(root);

    expect(calls.map(tool)).toEqual(['ovsx verify-pat']);
    expect(calls.join('\n')).not.toContain('vsce publish');
    expect(status).toBe(1);
  });

  it.skipIf(!posix)('then publishes to the Marketplace and to Open VSX, in that order', () => {
    const root = sandbox();
    fakeNpm(root, null);
    const { status, calls } = publish(root);

    expect(calls.map(tool)).toEqual(['ovsx verify-pat', 'vsce publish', 'ovsx publish']);
    expect(status).toBe(0);
  });

  it.skipIf(!posix)('publishes the file it was given, never the working tree', () => {
    // `--packagePath` on both, so neither tool is ever in a position to build
    // a package of its own out of whatever is on disk.
    const root = sandbox();
    fakeNpm(root, null);
    const { calls } = publish(root);
    const vsix = path.join(root, `${manifest.name}-${manifest.version}.vsix`);

    for (const call of calls.filter((line) => line.includes('publish'))) {
      expect(call, call).toContain(`--packagePath ${vsix}`);
    }
  });

  it.skipIf(!posix)('asks nothing of Open VSX when only the Marketplace is wanted', () => {
    // `--marketplace` means one registry on purpose; a verify-pat there would
    // fail a deliberate half-publish for want of a namespace nobody is using.
    const root = sandbox();
    fakeNpm(root, null);
    const { status, calls } = publish(root, ['--marketplace']);

    expect(calls.map(tool)).toEqual(['vsce publish']);
    expect(status).toBe(0);
  });

  it.skipIf(!posix)('checks the namespace on a dry run too, and uploads nothing', () => {
    // A dry run is the rehearsal, so it makes every check and skips only the
    // two uploads — which is the whole of what `--dry-run` promises.
    const root = sandbox();
    fakeNpm(root, null);
    const { status, calls } = publish(root, ['--dry-run']);

    expect(calls.map(tool)).toEqual(['ovsx verify-pat']);
    expect(status).toBe(0);
  });

  it.skipIf(!posix)('refuses to publish at all when neither token is set', () => {
    const root = sandbox();
    fakeNpm(root, null);
    const { status, calls } = publish(root, [], { VSCE_PAT: '', OVSX_PAT: '' });

    expect(calls).toEqual([]);
    expect(status).toBe(1);
  });
});

describe('the script the repository ships is the one under test', () => {
  it('is executable Node and takes its root from its own location', () => {
    // The sandbox copies the file; this is the one assertion about the
    // original, so that a rewrite that moved the root resolution out of the
    // script would not quietly leave the suite testing a copy of nothing.
    const source = readFileSync(path.join(repoRoot, 'scripts', 'publish.mjs'), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(source).toContain('fileURLToPath(import.meta.url)');
    // And it parses, which `vitest` would otherwise never find out: nothing
    // else in the suite imports it.
    execFileSync(process.execPath, ['--check', path.join(repoRoot, 'scripts', 'publish.mjs')]);
  });
});
