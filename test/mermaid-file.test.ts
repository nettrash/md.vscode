//
//  mermaid-file.test.ts
//  md.vscode — a Mermaid file drawn as the one diagram it is (#5).
//

import { describe, expect, it } from 'vitest';

import { diagrams } from '../src/export/svg';
import { renderBody } from '../src/render/html';
import { mermaidFileAsMarkdown, renderableSource } from '../src/render/mermaid-file';

const FLOW = 'flowchart TD\n  A[Start] --> B{Ship it?}\n  B -->|yes| C[Done]\n';

describe('mermaidFileAsMarkdown', () => {
  it('is one mermaid fence, and renders as exactly one Mermaid container', () => {
    const { html, needs } = renderBody(mermaidFileAsMarkdown(FLOW), { title: 't', dark: false });
    expect(html).toBe('<pre class="mermaid">flowchart TD\n  A[Start] --&gt; B{Ship it?}\n  B --&gt;|yes| C[Done]</pre>');
    expect(needs.mermaid).toBe(true);
    expect(diagrams(mermaidFileAsMarkdown(FLOW))).toEqual([{ ordinal: 0, kind: 'mermaid', engine: null, label: 'flowchart TD' }]);
  });

  it('cannot be closed early by a line of backticks inside the diagram', () => {
    const tricky = 'flowchart TD\n  A["```"] --> B\n```\n  B --> C\n';
    const md = mermaidFileAsMarkdown(tricky);
    expect(md.startsWith('````mermaid\n')).toBe(true);
    expect(diagrams(md)).toHaveLength(1);
    expect(renderBody(md, { title: 't', dark: false }).html).toContain('B --&gt; C');
  });

  it('normalises line endings and drops trailing blank lines only', () => {
    expect(mermaidFileAsMarkdown('pie\r\n  "a" : 1\r\n\r\n')).toBe('```mermaid\npie\n  "a" : 1\n```\n');
  });
});

describe('renderableSource', () => {
  it('wraps by language id alone, never by content', () => {
    // A Markdown paragraph that starts like Mermaid stays Markdown.
    expect(renderableSource('graph theory is a branch of maths', 'markdown')).toBe('graph theory is a branch of maths');
    expect(renderableSource('flowchart TD', 'mermaid')).toBe('```mermaid\nflowchart TD\n```\n');
    expect(renderableSource('@startuml\nA -> B\n@enduml', 'plantuml')).toBe('@startuml\nA -> B\n@enduml');
  });
});
