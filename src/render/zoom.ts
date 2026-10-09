//
//  zoom.ts
//  md.vscode — the zoom steps a diagram moves through, in one place.
//
//  A diagram has two kinds of size here. *Fit* is how it arrives: no wider than
//  the page it sits on, which is right for a figure in a document and makes a
//  large diagram — a 3 900-pixel sequence diagram, say — unreadably small. A
//  *scale* is a size relative to the diagram's own natural size, 1 being the
//  size its engine drew it at. Zooming in or out from Fit starts from the scale
//  Fit happens to amount to, so the first press is always a visible step; Reset
//  goes back to Fit.
//
//  Two clients step through these levels: the built-in preview's script, which
//  imports this module, and the diagram panel's page script, which is a string
//  in `diagramPreview.ts` and cannot import anything. It embeds
//  {@link NEXT_ZOOM_JS} instead — the same function, generated from the same
//  table — and `test/zoom.test.ts` holds the two to the same answers.
//

/** The scales a zoom step lands on: the familiar ladder of an image viewer. */
export const ZOOM_LEVELS: readonly number[] = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];

/**
 * The next level up (`direction` 1) or down (-1) from `current`, the scale the
 * diagram is shown at now. A scale between two levels — Fit usually is — moves
 * to the nearer level in that direction; at either end it stays put.
 */
export function nextZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) {
    for (const level of ZOOM_LEVELS) if (level > current * 1.001) return level;
    return ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  }
  for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
    if (ZOOM_LEVELS[i] < current * 0.999) return ZOOM_LEVELS[i];
  }
  return ZOOM_LEVELS[0];
}

/** {@link nextZoom} as page script, for the diagram panel: `mdNextZoom(current, direction)`. */
export const NEXT_ZOOM_JS = `function mdNextZoom(current, direction) {
    var levels = ${JSON.stringify(ZOOM_LEVELS)};
    if (direction > 0) {
      for (var i = 0; i < levels.length; i++) if (levels[i] > current * 1.001) return levels[i];
      return levels[levels.length - 1];
    }
    for (var j = levels.length - 1; j >= 0; j--) if (levels[j] < current * 0.999) return levels[j];
    return levels[0];
  }`;

/**
 * A diagram's natural width in CSS pixels, from what its engine wrote.
 *
 * PlantUML writes `width="3905px"` or a bare number; Graphviz writes points
 * (`width="62pt"`), which are 4/3 of a pixel; Mermaid writes `width="100%"` and
 * keeps the real figure in `style="max-width: 123.4px"`. The viewBox is the
 * fallback when none of those says, and the drawn width the last resort.
 */
export function naturalWidth(width: string | null, style: string | null, viewBoxWidth: number, drawn: number): number {
  const w = (width ?? '').trim();
  const sized = /^([\d.]+)\s*(px|pt)?$/.exec(w);
  if (sized) {
    const value = parseFloat(sized[1]) * (sized[2] === 'pt' ? 4 / 3 : 1);
    if (value > 0) return value;
  }
  const max = /max-width:\s*([\d.]+)px/.exec(style ?? '');
  if (max && parseFloat(max[1]) > 0) return parseFloat(max[1]);
  if (viewBoxWidth > 0) return viewBoxWidth;
  return drawn > 0 ? drawn : 1;
}

/** {@link naturalWidth} as page script, for the diagram panel: `mdNaturalWidth(svg)`. */
export const NATURAL_WIDTH_JS = `function mdNaturalWidth(svg) {
    var w = (svg.getAttribute('width') || '').trim();
    var sized = /^([\\d.]+)\\s*(px|pt)?$/.exec(w);
    if (sized) {
      var value = parseFloat(sized[1]) * (sized[2] === 'pt' ? 4 / 3 : 1);
      if (value > 0) return value;
    }
    var max = /max-width:\\s*([\\d.]+)px/.exec(svg.getAttribute('data-md-style') || svg.getAttribute('style') || '');
    if (max && parseFloat(max[1]) > 0) return parseFloat(max[1]);
    var box = svg.viewBox && svg.viewBox.baseVal;
    if (box && box.width > 0) return box.width;
    var drawn = svg.getBoundingClientRect().width;
    return drawn > 0 ? drawn : 1;
  }`;

/** How a zoom is shown on its control: "Fit", or a whole percentage. */
export function zoomLabel(scale: number | null): string {
  return scale === null ? 'Fit' : `${Math.round(scale * 100)}%`;
}
