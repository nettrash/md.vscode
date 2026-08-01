#!/usr/bin/env node
//
//  prepublish.mjs
//  The `vscode:prepublish` hook — and a guard against packaging the wrong
//  README.
//
//  WHY THIS IS NOT SIMPLY `npm run compile`
//  ----------------------------------------
//  The Marketplace "Details" tab is whatever file is called `README.md` at the
//  root of the .vsix. There is no `--readme-path` in vsce, so this repository
//  keeps two documents — `README.md` for people reading the source, and
//  `marketplace/extension-README.md` for people deciding whether to install —
//  and `scripts/package.mjs` stands the second one in at that filename for
//  exactly as long as vsce is running.
//
//  The failure mode that guard does *not* cover is someone reaching for the
//  obvious command:
//
//      vsce package        # or: npx vsce package
//
//  That succeeds. It produces a valid, installable .vsix. The only thing wrong
//  with it is that its Details tab is the developer README — which nobody
//  notices until it is live on the Marketplace, because a .vsix gives no hint
//  and a locally installed extension shows the same page. A silent wrong
//  answer is worse than a loud failure, so this makes it a loud failure.
//
//  vsce runs `vscode:prepublish` in a child process before it packages, which
//  is the one point where a direct invocation can still be stopped. The check
//  is a single environment variable that only `scripts/package.mjs` sets.
//
//  Deliberately NOT done here: swapping the README from this hook. vsce runs
//  the hook as a separate process that exits before packaging begins, so a
//  restore-on-exit would undo the swap before it was used, and a swap without
//  a restore would leave the working tree holding the wrong README with no
//  guarantee anything ever puts it back. The swap belongs in the parent
//  process that can wrap vsce in a `finally`, and that is where it lives.
//

import { spawnSync } from 'node:child_process';

if (process.env.MD_PACKAGE_VIA_SCRIPT !== '1') {
  console.error(`
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Do not package md.vscode with vsce directly.                        │
  └──────────────────────────────────────────────────────────────────────┘

  The Marketplace Details tab is README.md inside the .vsix, and vsce has no
  --readme-path. Packaging straight through vsce would ship this repository's
  developer README as the extension's listing page.

  Use instead:

      npm run package                 type-check, test, compile, then package
      node scripts/package.mjs        package only
      node scripts/package.mjs --list also print the file manifest

  Both stand marketplace/extension-README.md in as README.md for the length of
  the vsce run and put the real one back afterwards, byte-checked.
`);
  process.exit(1);
}

const result = spawnSync('npm', ['run', 'compile'], { stdio: 'inherit' });
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
