//
//  zoom-ui.ts
//  md.vscode — zooming one diagram in the built-in Markdown preview.
//
//  A diagram in the preview is drawn to fit the page, which is right for a
//  figure in a document and leaves a large one — a sequence diagram thousands of
//  pixels wide — too small to read. Hovering a Mermaid, PlantUML or Graphviz
//  diagram shows a small control, − / Fit / +, that zooms that one figure; past
//  the page's width it scrolls sideways inside its own block, which the
//  stylesheet already allows. Ctrl (⌘ on a Mac) with the scroll wheel, or a
//  trackpad pinch, does the same over the diagram.
//
//  Two things about the built-in preview shape this file:
//
//    * VS Code redraws the preview on every edit by morphing new markup over the
//      old, and `md-preview.ts` re-renders Mermaid and PlantUML from its cache.
//      Either throws away a size set on an `<svg>`, so a zoom lives here, in a
//      map, and {@link applyZooms} puts every one back after each render pass.
//    * Anything we add inside `.markdown-body` would be undone by that same
//      morph. The control is therefore one element on `<body>`, outside the
//      content, moved over whichever diagram the pointer is on — and the body
//      observer in `md-preview.ts` is told to ignore it (see {@link isZoomControl}).
//
//  No DOM is touched at module scope: the bundle runs in a page that may hold no
//  diagram at all, and the control is built on the first hover.
//

import { nextZoom, naturalWidth, zoomLabel } from '../render/zoom';

/** The diagram containers a reader can zoom. Plots are small by design and are left out. */
const DIAGRAMS = '.mermaid, .plantuml, .graphviz';

/** A scale per diagram; absent means Fit. Keyed by {@link keyOf}. */
const zooms = new Map<string, number>();

let control: HTMLElement | null = null;
let label: HTMLButtonElement | null = null;
/** The diagram the control is over. */
let target: HTMLElement | null = null;
let hideTimer = 0;
let wheelCredit = 0;
/** Reads a Mermaid or PlantUML block's own source; supplied by `md-preview.ts`. */
let sourceOf: (el: Element) => string | null = () => null;

/**
 * Which zoom a diagram wears. Mermaid and PlantUML carry their source, and the
 * source is the identity that survives an edit elsewhere in the document;
 * Graphviz is drawn by the host and keyed by its place among the diagrams of its
 * kind instead.
 */
function keyOf(el: HTMLElement, root: ParentNode): string {
  const kind = el.classList.contains('mermaid') ? 'mermaid' : el.classList.contains('plantuml') ? 'plantuml' : 'graphviz';
  if (kind !== 'graphviz') {
    const source = sourceOf(el);
    if (source !== null) return kind + '\u0000' + source;
  }
  const all = Array.from(root.querySelectorAll(`.${kind}`));
  return kind + '#' + all.indexOf(el);
}

function svgOf(el: Element): SVGSVGElement | null {
  return el.querySelector(':scope > svg') ?? el.querySelector('svg');
}

function natural(svg: SVGSVGElement): number {
  const box = svg.viewBox?.baseVal;
  return naturalWidth(
    svg.getAttribute('width'),
    svg.getAttribute('data-md-style') ?? svg.getAttribute('style'),
    box ? box.width : 0,
    svg.getBoundingClientRect().width,
  );
}

/** Size `svg` at `scale` of its natural width, or give it back its own style for Fit. */
function size(svg: SVGSVGElement, scale: number | null): void {
  if (!svg.hasAttribute('data-md-style')) svg.setAttribute('data-md-style', svg.getAttribute('style') ?? '');
  const own = svg.getAttribute('data-md-style') ?? '';
  if (scale === null) {
    if (own) svg.setAttribute('style', own);
    else svg.removeAttribute('style');
    return;
  }
  const width = Math.round(natural(svg) * scale);
  svg.setAttribute('style', `${own}${own && !own.trim().endsWith(';') ? ';' : ''}width:${width}px;max-width:none;height:auto`);
}

/** Put every remembered zoom back after a render pass or a morph took it away. */
export function applyZooms(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(DIAGRAMS))) {
    const scale = zooms.get(keyOf(el, root));
    const svg = svgOf(el);
    if (svg && scale !== undefined) size(svg, scale);
  }
  if (target && control && control.style.display !== 'none') place();
}

/** True for the control and anything inside it — the body observer's exclusion. */
export function isZoomControl(node: Node): boolean {
  return control !== null && (node === control || control.contains(node));
}

function root(): ParentNode {
  return document.querySelector('.markdown-body') ?? document.body;
}

function current(el: HTMLElement): number | null {
  const scale = zooms.get(keyOf(el, root()));
  return scale === undefined ? null : scale;
}

function setZoom(el: HTMLElement, scale: number | null): void {
  const key = keyOf(el, root());
  if (scale === null) zooms.delete(key);
  else zooms.set(key, scale);
  const svg = svgOf(el);
  if (svg) size(svg, scale);
  if (el === target) {
    if (label) label.textContent = zoomLabel(scale);
    place();
  }
}

function step(el: HTMLElement, direction: 1 | -1): void {
  const svg = svgOf(el);
  if (!svg) return;
  const now = current(el) ?? svg.getBoundingClientRect().width / natural(svg);
  setZoom(el, nextZoom(now, direction));
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return b;
}

function build(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'md-zoom';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', 'Diagram zoom');
  el.style.display = 'none';
  label = button('Fit', 'Fit to width', () => target && setZoom(target, null));
  label.className = 'md-zoom-level';
  el.append(
    button('−', 'Zoom out', () => target && step(target, -1)),
    label,
    button('+', 'Zoom in', () => target && step(target, 1)),
  );
  el.addEventListener('mouseenter', () => window.clearTimeout(hideTimer));
  el.addEventListener('mouseleave', scheduleHide);
  document.body.appendChild(el);
  return el;
}

/** Over the top right of the diagram's visible part, inside the page. */
function place(): void {
  if (!control || !target) return;
  const rect = target.getBoundingClientRect();
  const right = Math.min(rect.right, document.documentElement.clientWidth);
  control.style.top = `${Math.max(rect.top, 0) + window.scrollY + 4}px`;
  control.style.left = `${Math.max(right - control.offsetWidth - 4, rect.left) + window.scrollX}px`;
}

function show(el: HTMLElement): void {
  window.clearTimeout(hideTimer);
  control ??= build();
  target = el;
  if (label) label.textContent = zoomLabel(current(el));
  control.style.display = '';
  place();
}

function scheduleHide(): void {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (control) control.style.display = 'none';
    target = null;
  }, 400);
}

function diagramAt(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest<HTMLElement>(DIAGRAMS);
  return el && svgOf(el) && root().contains(el) ? el : null;
}

/** Install the hover and wheel listeners. Called once, from `md-preview.ts`. */
export function installZoom(readSource: (el: Element) => string | null): void {
  sourceOf = readSource;
  document.addEventListener('mouseover', (event) => {
    const el = diagramAt(event.target);
    if (el) show(el);
    else if (!(event.target instanceof Node && isZoomControl(event.target)) && target) scheduleHide();
  });
  document.addEventListener(
    'wheel',
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const el = diagramAt(event.target);
      if (!el) return;
      event.preventDefault();
      // A trackpad pinch arrives as many small deltas: they are added up, and a
      // step is taken for each 40 or so, rather than one per event.
      wheelCredit += event.deltaY;
      if (Math.abs(wheelCredit) < 40) return;
      step(el, wheelCredit < 0 ? 1 : -1);
      wheelCredit = 0;
      show(el);
    },
    { passive: false },
  );
  window.addEventListener('scroll', () => place(), { passive: true });
}
