//
//  zoom.test.ts
//  md.vscode — the zoom ladder, and the panel's copy of it.
//
//  The built-in preview steps through `nextZoom`; the diagram panel's page
//  script, a string that cannot import, through `NEXT_ZOOM_JS`. Both come from
//  `src/render/zoom.ts`, and this file holds them to the same answers.
//

import { describe, expect, it } from 'vitest';

import { NEXT_ZOOM_JS, ZOOM_LEVELS, naturalWidth, nextZoom, zoomLabel } from '../src/render/zoom';

const panelNextZoom = new Function(`${NEXT_ZOOM_JS}; return mdNextZoom;`)() as (c: number, d: number) => number;

describe('nextZoom', () => {
  it('steps along the ladder from a level', () => {
    expect(nextZoom(1, 1)).toBe(1.1);
    expect(nextZoom(1, -1)).toBe(0.9);
    expect(nextZoom(0.5, 1)).toBe(0.67);
  });

  it('from Fit — a scale between levels — takes the nearer level in that direction', () => {
    // A 3 905-pixel diagram fitted into 900 pixels is shown at about 0.23.
    expect(nextZoom(900 / 3905, 1)).toBe(0.25);
    expect(nextZoom(0.6, 1)).toBe(0.67);
    expect(nextZoom(0.6, -1)).toBe(0.5);
  });

  it('stops at either end', () => {
    expect(nextZoom(5, 1)).toBe(5);
    expect(nextZoom(0.25, -1)).toBe(0.25);
    expect(nextZoom(0.1, -1)).toBe(0.25);
  });

  it('is exactly what the diagram panel computes', () => {
    for (let c = 0.05; c < 6; c += 0.013) {
      for (const d of [1, -1] as const) expect(panelNextZoom(c, d), `${c} ${d}`).toBe(nextZoom(c, d));
    }
    for (const level of ZOOM_LEVELS) {
      for (const d of [1, -1] as const) expect(panelNextZoom(level, d)).toBe(nextZoom(level, d));
    }
  });
});

describe('naturalWidth', () => {
  it("reads each engine's own way of writing it", () => {
    expect(naturalWidth('3905px', null, 3905, 900)).toBe(3905); // PlantUML
    expect(naturalWidth('620', null, 0, 300)).toBe(620);
    expect(naturalWidth('62pt', null, 62, 50)).toBeCloseTo(82.667, 2); // Graphviz
    expect(naturalWidth('100%', 'max-width: 123.4px;', 123.4, 600)).toBe(123.4); // Mermaid
    expect(naturalWidth(null, null, 240, 100)).toBe(240);
    expect(naturalWidth(null, null, 0, 100)).toBe(100);
  });
});

describe('zoomLabel', () => {
  it('says Fit, or a whole percentage', () => {
    expect(zoomLabel(null)).toBe('Fit');
    expect(zoomLabel(1.25)).toBe('125%');
    expect(zoomLabel(0.67)).toBe('67%');
  });
});
