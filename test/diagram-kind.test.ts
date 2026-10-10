//
//  diagram-kind.test.ts
//  md.vscode — a .gv or .puml file is drawn as its language says, not only as
//  its text suggests (#4, from review).
//
//  `isRawGraphviz` deliberately does not skip a leading `#` line — every
//  Markdown heading starts with one — so a DOT file that opens with a C
//  preprocessor line reads as Markdown when only the text is consulted. An
//  opened `.gv` file is Graphviz by its language, and the exports now pass that.
//

import { describe, expect, it } from 'vitest';

import { epubOutline } from '../src/export/epub';
import { diagrams } from '../src/export/svg';
import { rawDiagramKind, renderBody } from '../src/render/html';

const DOT = '# 1 "graph.gv"\ndigraph G {\n  a -> b\n}\n';
const PUML = "' a comment-led file that sniffs fine\nBob -> Alice : hi\n";

describe('rawDiagramKind', () => {
  it('takes the language first, then the text', () => {
    expect(rawDiagramKind(DOT)).toBeNull();
    expect(rawDiagramKind(DOT, 'graphviz')).toBe('graphviz');
    expect(rawDiagramKind(PUML, 'plantuml')).toBe('plantuml');
    expect(rawDiagramKind('digraph { a }', 'markdown')).toBe('graphviz');
    expect(rawDiagramKind('@startuml\nA -> B\n@enduml')).toBe('plantuml');
    expect(rawDiagramKind('# Title\n\ntext', 'markdown')).toBeNull();
  });
});

describe('a DOT file opening with a # line', () => {
  it('renders as Markdown when only its text is known', () => {
    const { html, needs } = renderBody(DOT, { title: 'g', dark: false });
    expect(needs.graphviz).toBe(false);
    expect(html).toContain('<h1');
  });

  it('renders as one Graphviz diagram when its language is known', () => {
    const { html, needs } = renderBody(DOT, { title: 'g', dark: false, diagram: 'graphviz' });
    expect(needs.graphviz).toBe(true);
    expect(html.startsWith('<div class="graphviz" data-engine="dot">')).toBe(true);
    expect(html).not.toContain('<h1');
  });

  it('gets the one whole-document EPUB entry and one SVG target', () => {
    expect(epubOutline(DOT).length).toBe(1);
    expect(epubOutline(DOT, 'graphviz')).toEqual([]);
    expect(diagrams(DOT, 'graphviz')).toEqual([{ ordinal: 0, kind: 'graphviz', engine: 'dot', label: '# 1 "graph.gv"' }]);
  });

  it('a PlantUML file without @start is a PlantUML diagram by its language', () => {
    const { needs } = renderBody(PUML, { title: 'p', dark: false, diagram: 'plantuml' });
    expect(needs.plantuml).toBe(true);
  });
});
