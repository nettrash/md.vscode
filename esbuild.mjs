//
//  esbuild.mjs
//  md.vscode — two bundles, two very different targets.
//
//  1. `dist/extension.js` — the extension host. Node/CJS. `vscode` is provided
//     by the host and must stay external. The vendored engines under
//     `media/rich/` are ALSO external and deliberately un-bundled: they are
//     loaded at runtime from disk by absolute path, so they keep their exact
//     vendored bytes (parity with the iOS / macOS / Android apps) and the
//     7.4 MB PlantUML engine never enters a bundle.
//
//  2. `media/preview/md-preview.js` — the client script contributed into VS
//     Code's built-in Markdown preview. Browser/IIFE, no imports at load time:
//     the built-in preview's CSP is `script-src 'nonce-…'` with nothing else,
//     so this file is injected with a nonce and then reads that nonce back to
//     inject Mermaid / PlantUML itself, only when a document needs them.
//

import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const previewConfig = {
  entryPoints: ['src/preview/md-preview.ts'],
  bundle: true,
  outfile: 'media/preview/md-preview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  sourcemap: false,
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(previewConfig),
  ]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[esbuild] watching…');
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(previewConfig)]);
}
