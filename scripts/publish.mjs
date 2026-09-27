#!/usr/bin/env node
//
//  scripts/publish.mjs
//  md.vscode — put one already-built .vsix on the Visual Studio Marketplace
//  and on Open VSX, and nothing else.
//
//  NOTHING HERE PACKAGES THE WORKING TREE, AND THAT IS THE POINT
//  -------------------------------------------------------------
//  `vsce publish` and `ovsx publish` will both happily build a package out of
//  whatever is on disk. Doing that here would ship the *repository* README as
//  the Marketplace details page — the failure `scripts/package.mjs` exists to
//  prevent and `scripts/prepublish.mjs` exists to refuse — and it would ship
//  a package nobody had looked at. So this script only ever publishes a file:
//  `vsce publish --packagePath <vsix>` and `ovsx publish <vsix>`, never the
//  bare verbs.
//
//  If the expected .vsix is not there it is built by calling
//  `scripts/package.mjs`, which is the one supported way to build one.
//
//  TWO REGISTRIES, TWO TOKENS, ONE FILE
//  ------------------------------------
//  The same bytes go to both. That is the whole reason this is one script:
//  publishing them separately is how two registries come to hold two
//  different builds of the same version number.
//
//    * **Marketplace** — `VSCE_PAT`, an Azure DevOps personal access token
//      for the `nettrash` publisher.
//    * **Open VSX** — `OVSX_PAT`, an access token from an Eclipse account
//      that owns the `nettrash` namespace. The namespace has to be claimed
//      once, by hand, before the first publish; `marketplace/README.md`
//      lists the five steps.
//
//  Both tokens are read from the environment and never passed on the command
//  line, where `ps` would show them. A registry whose token is absent is
//  skipped with a line saying so, so that a half-configured machine publishes
//  to one rather than failing at both — and so that the CI job can run with
//  no secrets at all and do nothing.
//
//  Usage:
//    node scripts/publish.mjs [--dry-run] [--marketplace] [--open-vsx]
//
//  --dry-run     do everything except the two publish calls.
//  --marketplace / --open-vsx  publish to only that one. Neither flag means
//                both, which is what a release wants.
//

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyMarketplace = args.includes('--marketplace');
const onlyOpenVsx = args.includes('--open-vsx');
const wantMarketplace = onlyMarketplace || !onlyOpenVsx;
const wantOpenVsx = onlyOpenVsx || !onlyMarketplace;

// The name vsce gives a package: `<name>-<version>.vsix`, at the repository
// root. Recomputed rather than globbed, so a stale .vsix from an older
// version can never be the thing that gets published.
const vsixName = `${manifest.name}-${manifest.version}.vsix`;
const vsixPath = join(repoRoot, vsixName);

/**
 * `npm exec --no`, exactly as `scripts/package.mjs` and the CI workflow spell
 * it: `--no` forbids the install-on-miss behaviour, so a tool missing from
 * devDependencies fails loudly instead of running whatever owns that name on
 * the registry. A publishing step is the last place to let npx reach out.
 */
function run(label, npmArgs) {
  console.log(`\n$ npm ${npmArgs.join(' ')}`);
  const result = spawnSync('npm', npmArgs, { cwd: repoRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`${label} was killed by ${result.signal}.`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} exited with status ${result.status}.`);
  }
}

function fail(message) {
  console.error(`\nscripts/publish.mjs: ${message}`);
  process.exit(1);
}

// 1. The artefact.
//
//    Built here only if it is missing, and built the one supported way.
//    Note what that does NOT do: `scripts/package.mjs` packages, it does not
//    type-check, test or compile. In CI those gates are the job this one
//    `needs`; by hand, run `npm run package` first, which is the same
//    packaging step with the three gates in front of it.
if (!existsSync(vsixPath)) {
  console.log(`${vsixName} is not here yet — building it.`);
  run('scripts/package.mjs', ['exec', '--no', '--', 'node', 'scripts/package.mjs']);
}
if (!existsSync(vsixPath)) {
  fail(`${vsixName} was not produced. Nothing has been published.`);
}

const bytes = readFileSync(vsixPath);
console.log(`\nPublishing ${vsixName}`);
console.log(`  size   ${statSync(vsixPath).size} bytes`);
console.log(`  sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
console.log(`  version ${manifest.version}, publisher ${manifest.publisher}`);

// 2. The tokens. Read, never printed, never passed as an argument — both
//    tools take them from the environment.
const hasVsce = (process.env.VSCE_PAT ?? '') !== '';
const hasOvsx = (process.env.OVSX_PAT ?? '') !== '';

if (wantMarketplace && !hasVsce) {
  console.log('\nVSCE_PAT is not set — skipping the Visual Studio Marketplace.');
}
if (wantOpenVsx && !hasOvsx) {
  console.log('\nOVSX_PAT is not set — skipping Open VSX.');
  console.log('See marketplace/README.md for the one-time Eclipse account and namespace steps.');
}
if (!(wantMarketplace && hasVsce) && !(wantOpenVsx && hasOvsx)) {
  fail('no token for either registry. Nothing has been published.');
}

// 3. Publish. `--packagePath` on both, so neither tool is ever in a position
//    to build something of its own.
//
//    Every check first, then the two uploads. An upload cannot be undone —
//    `vsce` will refuse a version it already holds — so a question asked
//    between the two is a question that can cost a version number: the
//    Marketplace ends up with a build Open VSX will never have, under a
//    number that can never be published again. `ovsx verify-pat` is exactly
//    such a question. It used to sit above the Open VSX upload, which is
//    before *that* upload and after the other one; it is the last check made
//    before either.
try {
  if (wantOpenVsx && hasOvsx) {
    // The one call that says, in one line, whether the namespace has been
    // claimed and whether this token may publish into it. Both are one-time
    // setup steps nobody remembers having skipped — and a dry run makes this
    // check too, because skipping the uploads is the whole of what it skips.
    run('ovsx verify-pat', ['exec', '--no', '--', 'ovsx', 'verify-pat', manifest.publisher]);
  }
  if (wantMarketplace && hasVsce) {
    if (dryRun) {
      console.log(`\n[dry run] vsce publish --packagePath ${vsixName}`);
    } else {
      run('vsce publish', ['exec', '--no', '--', 'vsce', 'publish', '--packagePath', vsixPath]);
    }
  }
  if (wantOpenVsx && hasOvsx) {
    if (dryRun) {
      console.log(`\n[dry run] ovsx publish ${vsixName}`);
    } else {
      run('ovsx publish', ['exec', '--no', '--', 'ovsx', 'publish', '--packagePath', vsixPath]);
    }
  }
} catch (error) {
  console.error(`\nscripts/publish.mjs: ${error.message}`);
  // The one failure worth naming, because its message from ovsx is
  // "Unknown namespace: nettrash" and the fix is a single command run once.
  console.error(
    '\nIf Open VSX reported an unknown namespace, it has not been claimed yet:\n' +
      '  npx ovsx create-namespace nettrash\n' +
      'with OVSX_PAT set. See marketplace/README.md.',
  );
  process.exit(1);
}

console.log('\nDone.');
