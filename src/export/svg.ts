//
//  svg.ts
//  md.vscode — "export one diagram as a real vector `.svg` file".
//
//  A port of `DiagramSVG` in `md/md/DocumentExport.swift`: which blocks a
//  document offers, and the fix-up that turns a diagram's rendered root `<svg>`
//  (read out of the offscreen DOM as `outerHTML`) into a self-standing SVG
//  document. No webview and no I/O here — all of it is unit-testable, and the
//  one DOM-touching step lives in `renderHost.ts`.
//
//  Only the three *diagram* engines qualify. Math does **not**: KaTeX lays a
//  formula out as HTML and CSS, never SVG, so a formula has no vector to export
//  and is deliberately never offered. That is also why the selector here is the
//  diagram half of the one the EPUB snapshot path uses.
//
//  String scanning throughout, rather than the code-point walks `latex.ts`
//  insists on: the input is a serializer's ASCII tag syntax, never author
//  prose, so there is no combining-mark hazard to guard against. The Swift
//  makes the same exemption explicitly, and for the same reason.
//

import type { Block } from '../render/types';
import { parse } from '../render/parser';
import { graphvizEngines, isRawGraphviz, isRawPlantUML } from '../render/html';
import { trimWS } from '../render/text';

export type DiagramKind = 'mermaid' | 'plantuml' | 'graphviz';

/** One diagram the document offers for SVG export, in document order. */
export interface Diagram {
  /**
   * 0-based position among the document's diagrams — the same order
   * `querySelectorAll('pre.mermaid, div.plantuml, div.graphviz')` reports the
   * rendered containers in, so the capture step pulls the matching `<svg>` back
   * out by this index.
   */
  ordinal: number;
  kind: DiagramKind;
  /**
   * The Graphviz layout program (`dot` / `neato` / …) for a `.graphviz`
   * diagram; null for the others. Only for the menu label.
   */
  engine: string | null;
  /**
   * A short label lifted from the diagram's source — its first non-empty line —
   * so a reader can tell two diagrams apart in the menu. Empty when the source
   * has no non-blank line.
   */
  label: string;
}

/**
 * The engine's display name, naming the Graphviz layout when it is not the
 * default `dot` (a `neato` graph reads quite differently).
 */
export function typeName(diagram: Diagram): string {
  switch (diagram.kind) {
    case 'mermaid':
      return 'Mermaid';
    case 'plantuml':
      return 'PlantUML';
    case 'graphviz':
      if (diagram.engine !== null && diagram.engine !== 'dot') {
        return `Graphviz (${diagram.engine})`;
      }
      return 'Graphviz';
  }
}

/** The menu row: the type, plus the source label when there is one. */
export function menuTitle(diagram: Diagram): string {
  const name = typeName(diagram);
  return diagram.label.length === 0 ? name : `${name}: ${diagram.label}`;
}

/**
 * The diagrams a document offers, in document order.
 *
 * Mirrors exactly how the renderer decides what becomes a diagram, so this list
 * pairs index-for-index with the rendered DOM's diagram containers:
 *
 *  * a raw `.puml` / `.gv` document is one diagram — the whole file, since
 *    `renderBody` renders it without parsing Markdown at all;
 *  * otherwise every fenced block whose info string names Mermaid, PlantUML or
 *    a Graphviz layout — **including one nested in a block quote**, which the
 *    renderer draws by recursing into the quote, so the walk recurses too and
 *    the quoted diagram keeps its place.
 *
 * Math fences and every other code block are skipped: a formula is not SVG, and
 * ordinary code is not a diagram.
 */
export function diagrams(source: string): Diagram[] {
  if (isRawPlantUML(source)) {
    return [{ ordinal: 0, kind: 'plantuml', engine: null, label: firstLine(source) }];
  }
  if (isRawGraphviz(source)) {
    return [{ ordinal: 0, kind: 'graphviz', engine: 'dot', label: firstLine(source) }];
  }
  const out: Diagram[] = [];
  appendDiagrams(parse(source), out);
  return out;
}

function appendDiagrams(blocks: readonly Block[], out: Diagram[]): void {
  for (const block of blocks) {
    if (block.kind === 'codeBlock') {
      const classified = classify(block.language);
      if (classified === null) continue;
      out.push({
        ordinal: out.length,
        kind: classified.kind,
        engine: classified.engine,
        label: firstLine(block.code),
      });
    } else if (block.kind === 'quote') {
      appendDiagrams(block.blocks, out);
    }
  }
}

/**
 * Classify a fence info string the way `renderCodeBlock` does — lower-cased,
 * the same three families, the same Graphviz alias table — or null for anything
 * that is not a diagram (math, csv, plain code).
 *
 * Reusing `graphvizEngines` keeps the two in lockstep: a layout added there is
 * offered here without a second edit.
 */
function classify(language: string | null): { kind: DiagramKind; engine: string | null } | null {
  const lang = (language ?? '').toLowerCase();
  if (lang === 'mermaid') return { kind: 'mermaid', engine: null };
  if (lang === 'plantuml' || lang === 'puml' || lang === 'plant-uml') {
    return { kind: 'plantuml', engine: null };
  }
  const engine = graphvizEngines[lang];
  if (engine !== undefined) return { kind: 'graphviz', engine };
  return null;
}

/**
 * The first non-empty line of `source`, trimmed and capped so one long line
 * cannot dwarf the menu.
 *
 * Purely cosmetic — a human reads it, nothing re-parses it — so ordinary line
 * splitting is fine here, which the Swift flags as a deliberate exemption from
 * its own scalar-exactness rule. The 40-character cap counts code points, the
 * closest cheap analogue to the `Character` count Swift takes.
 */
function firstLine(source: string): string {
  // The *wide* newline set, as Swift's `Character.isNewline` defines it —
  // U+0085, U+2028 and U+2029 included — matching the splitter the raw-diagram
  // probes use rather than the parser's narrower CR/LF/CRLF one.
  for (const raw of source.split(/\r\n|[\n\v\f\r\u0085\u2028\u2029]/u)) {
    const trimmed = trimWS(raw);
    if (trimmed.length === 0) continue;
    const scalars = [...trimmed];
    if (scalars.length <= 40) return trimmed;
    return trimWS(scalars.slice(0, 40).join('')) + '…';
  }
  return '';
}

// MARK: - SVG fix-up

/**
 * Turn a diagram's rendered root `<svg …>…</svg>` into a standalone `.svg`
 * document: guarantee the SVG namespace, give an unsized root real pixel
 * dimensions from its `viewBox`, and prepend the XML prolog so the file is a
 * well-formed standalone document any browser or vector editor opens.
 *
 * Mermaid emits `width="100%"` and no `height` — fine inside a flowing page
 * (the page CSS caps it), useless in a file, where it renders at zero or
 * full-viewport height. Graphviz and PlantUML already write absolute
 * `width`/`height`, so those are left exactly as the engine drew them.
 */
export function standaloneDocument(svg: string): string {
  const fixed = withResolvedSize(inNamespaced(svg));
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + fixed;
}

/**
 * The root `<svg …>` opening tag's span, or null if there is not one. Engine
 * `outerHTML` never puts a `>` inside the root tag's attribute values, so the
 * first `>` really does close it.
 */
function openingTagRange(svg: string): { start: number; end: number } | null {
  const open = svg.indexOf('<svg');
  if (open < 0) return null;
  const close = svg.indexOf('>', open + '<svg'.length);
  if (close < 0) return null;
  return { start: open, end: close + 1 };
}

/**
 * Ensure the root carries the default SVG namespace so the standalone file is
 * well-formed. Both engines already declare it, but a file must not lean on
 * that.
 */
function inNamespaced(svg: string): string {
  const tagRange = openingTagRange(svg);
  if (tagRange === null) return svg;
  const tag = svg.slice(tagRange.start, tagRange.end);
  if (attribute('xmlns', tag) !== null) return svg;
  // Right after `<svg`, before the other attributes.
  const at = tagRange.start + 4;
  return svg.slice(0, at) + ' xmlns="http://www.w3.org/2000/svg"' + svg.slice(at);
}

/**
 * Give the root real dimensions when it lacks them. If both `width` and
 * `height` are already absolute lengths the engine sized it (Graphviz,
 * PlantUML) — leave it untouched. Otherwise, when a 4-number `viewBox` is
 * present, set `width`/`height` to the viewBox's own width and height, which is
 * what makes a Mermaid `width="100%"` file open at its true size.
 */
function withResolvedSize(svg: string): string {
  const tagRange = openingTagRange(svg);
  if (tagRange === null) return svg;
  const tag = svg.slice(tagRange.start, tagRange.end);
  if (isAbsoluteLength(attribute('width', tag)) && isAbsoluteLength(attribute('height', tag))) {
    return svg;
  }
  const box = viewBox(tag);
  if (box === null || box.length !== 4) return svg;
  let newTag = setAttribute('width', box[2], tag);
  newTag = setAttribute('height', box[3], newTag);
  return svg.slice(0, tagRange.start) + newTag + svg.slice(tagRange.end);
}

/**
 * The value span of a whole attribute `name="…"` (or `name='…'`) inside an
 * opening tag.
 *
 * **The leading space is load-bearing**: it matches only a whole attribute, so
 * `width` never captures `stroke-width`.
 */
function attributeValueRange(name: string, tag: string): { start: number; end: number } | null {
  for (const quote of ['"', "'"]) {
    const key = tag.indexOf(` ${name}=${quote}`);
    if (key < 0) continue;
    const valueStart = key + ` ${name}=${quote}`.length;
    const close = tag.indexOf(quote, valueStart);
    if (close < 0) continue;
    return { start: valueStart, end: close };
  }
  return null;
}

function attribute(name: string, tag: string): string | null {
  const range = attributeValueRange(name, tag);
  return range === null ? null : tag.slice(range.start, range.end);
}

/** Set `name`'s value, or add `name="value"` just past `<svg` when absent. */
function setAttribute(name: string, value: string, tag: string): string {
  const range = attributeValueRange(name, tag);
  if (range !== null) {
    return tag.slice(0, range.start) + value + tag.slice(range.end);
  }
  return tag.slice(0, 4) + ` ${name}="${value}"` + tag.slice(4);
}

/**
 * Whether an attribute value is an absolute SVG length: present, and a number
 * (optionally with a unit like `pt`/`px`), but not a percentage.
 *
 * A missing value and `width="100%"` are both "not absolute", which is exactly
 * what makes a Mermaid root get resized and a Graphviz root not.
 */
function isAbsoluteLength(value: string | null): boolean {
  if (value === null) return false;
  const trimmed = trimWS(value);
  if (trimmed.length === 0 || trimmed.endsWith('%')) return false;
  const first = trimmed[0];
  return first === '.' || (first >= '0' && first <= '9');
}

/** The `viewBox`'s space/comma-separated tokens, or null. */
function viewBox(tag: string): string[] | null {
  const value = attribute('viewBox', tag);
  if (value === null) return null;
  return value.split(/[ ,]/).filter((token) => token.length > 0);
}
