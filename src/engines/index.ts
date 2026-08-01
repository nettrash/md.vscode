//
//  index.ts
//  md.vscode — the engine layer's front door.
//
//  Everything under `src/engines/` is Node-only: it may read `media/rich` off
//  disk, it may not import `vscode`, and nothing in `src/render/` may import
//  *it*. The parity core stays pure and takes engines as an argument —
//  `renderDocument(source, {engines})` — which is what lets the golden tests run
//  the renderer with no engine, no editor and no filesystem in the loop, and
//  assert byte-identical output against `MarkdownHTML.document(_:title:dark:export:)`.
//
//  This file is the one place that knows all three host-side engines exist. It
//  hands `renderBody` a ready-made hooks object and gives the host a single
//  `clearAllCaches()` verb.
//
//  WHY THE HOOKS INTERFACE IS DECLARED HERE AND NOT IMPORTED
//  ---------------------------------------------------------
//  `EngineHooks` is defined in `src/render/html.ts`, and importing it would
//  point an arrow from the engine layer back at the parity core — the one
//  direction the layering rule forbids, since the core "MUST NOT require an
//  engine". TypeScript is structural, so an object typed by the declaration
//  below satisfies `RenderOptions['engines']` at the call site without either
//  module knowing about the other. The shape is normative and lives in
//  `specs/13-API-CONTRACT.md`; if it ever changes, it changes in both places.
//

export { richRoot, setRichRoot } from './paths';
export { clearAllCaches } from './cache';
export { renderMath } from './katex';
export { highlightCode, knowsLanguage } from './highlight';
export { isWarm, renderGraphviz, renderGraphvizSync, vizEngines, warmUp } from './graphviz';

import { highlightCode } from './highlight';
import { renderGraphvizSync } from './graphviz';
import { renderMath } from './katex';

/**
 * A structural twin of `RenderOptions['engines']`. Every member is optional and
 * every one may return `null`, which the renderer reads as "leave md's
 * container exactly as the no-hook path would emit it".
 */
export interface HostEngineHooks {
  /** KaTeX. HTML for the formula, or `null` to leave the LaTeX visible. */
  math?(tex: string, displayMode: boolean): string | null;
  /** highlight.js. Highlighted HTML, or `null` to leave the block plain. */
  highlight?(code: string, language: string): string | null;
  /** Graphviz. An `<svg>…</svg>` string, or `null` to leave the DOT visible. */
  graphviz?(source: string, engine: string): string | null;
}

/**
 * Which engines the user has left switched on.
 *
 * `md.math.enabled`, `md.highlight.enabled` and `md.diagrams.graphviz` are
 * `resource`-scoped settings, so the answer is per document and must be read by
 * the caller — this layer never touches `vscode`. Omitted means on, matching
 * the defaults in `package.json`.
 */
export interface EngineFeatures {
  math?: boolean;
  highlight?: boolean;
  graphviz?: boolean;
}

/**
 * Wire the host-side engines into a hooks object for `renderBody` /
 * `renderDocument`.
 *
 * A disabled engine is *absent* rather than a hook that returns `null`. The two
 * are identical by the hooks rule, and absence says what was meant: the feature
 * is off, so the container is emitted untouched and the reader sees the LaTeX,
 * the plain code or the DOT source.
 *
 * Graphviz is wired to the **synchronous** entry point on purpose. `renderBody`
 * cannot await, so a cold engine returns `null` here and the block renders as
 * its source; `warmUp()` on activation is what makes that window small, and a
 * refresh once it settles is what closes it. Mermaid and PlantUML are not here
 * at all — they need real text metrics and a real `measureText`, so they run in
 * the preview.
 */
export function engineHooks(features: EngineFeatures = {}): HostEngineHooks {
  const hooks: HostEngineHooks = {};
  if (features.math !== false) hooks.math = renderMath;
  if (features.highlight !== false) hooks.highlight = highlightCode;
  if (features.graphviz !== false) hooks.graphviz = renderGraphvizSync;
  return hooks;
}
