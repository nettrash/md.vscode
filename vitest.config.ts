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
//
//  Hence `environment: 'node'` — never jsdom. Beyond being unnecessary, jsdom
//  would be actively misleading: `specs/12-CSP-GROUND-TRUTH.md` measured Mermaid
//  producing a `viewBox="-8 -8 30998 32"` with no `<text>` under it, so a green
//  jsdom test would say nothing about what the preview draws. Mermaid and
//  PlantUML are tested where they run — in a browser — and not here.
//

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
