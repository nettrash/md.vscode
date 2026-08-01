//
//  vitest.config.ts
//  md.vscode — how the parity suite runs.
//
//  The suite has two halves with different needs, and one config serves both:
//
//    * `test/{text,parser,inline,html,slug,golden}.test.ts` exercise
//      `src/render/**`, the parity core. No editor, no filesystem, no engine —
//      that purity is the whole point of the layering rule, and it is why these
//      run in milliseconds and can be trusted as the byte-parity gate.
//    * `test/engines.test.ts` loads the vendored engines out of `media/rich`
//      with Node's own `require`, so it needs the real Node environment and a
//      real working directory.
//    * `test/preview-config.test.ts` exercises `src/preview/config.ts`, which
//      imports `vscode` — a module that only exists inside a running editor.
//      The alias below points that specifier at `test/vscode-stub.ts`.
//
//  Hence `environment: 'node'` — never jsdom. Beyond being unnecessary, jsdom
//  would be actively misleading: `specs/12-CSP-GROUND-TRUTH.md` measured Mermaid
//  producing a `viewBox="-8 -8 30998 32"` with no `<text>` under it, so a green
//  jsdom test would say nothing about what the preview draws. Mermaid and
//  PlantUML are tested where they run — in a browser — and not here.
//

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `vscode` is provided by the extension host at runtime and by
    // `@types/vscode` at compile time; there is no package to import. This makes
    // the specifier resolvable *for the test run only* — esbuild keeps it
    // external in the shipped bundle, and nothing under `src/render/**` is
    // allowed to reach for it in the first place.
    //
    // An exact-string alias rather than a regular expression, so it can never
    // catch a path that merely contains the word.
    alias: {
      vscode: fileURLToPath(new URL('./test/vscode-stub.ts', import.meta.url)),
    },
    // Explicit imports of `describe` / `it` / `expect` everywhere. Globals
    // would need a `types` entry in tsconfig.json, which is frozen.
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // `media/**` holds ~12 MB of vendored engine bytes and `test/fixtures/**`
    // holds the golden corpus. Neither is a test file; keeping them out of the
    // watcher's scan is what makes `vitest --watch` usable in this repo.
    exclude: ['node_modules/**', 'dist/**', 'out/**', 'media/**'],
    // Graphviz compiles ~1.4 MB of WebAssembly on first use. Measured at ~12 ms
    // warm, but a cold CI runner with a cold page cache is a different animal,
    // so the default 5 s is doubled rather than left to chance.
    testTimeout: 10_000,
    // A failed byte-parity assertion is a diff, and a truncated diff is a
    // riddle. The rendered documents in `golden.test.ts` are kilobytes long.
    chaiConfig: { truncateThreshold: 0 },
  },
});
