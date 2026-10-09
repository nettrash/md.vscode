//
//  plantuml-skinparam.test.ts
//  md.vscode — the one PlantUML skinparam the bundled engine stopped honouring,
//  rewritten into the style it reads instead.
//
//  The bundled engine (1.2026.4beta4) ignores `skinparam ParticipantPadding N`
//  and draws "Please use CSS style instead of skinparam ParticipantPadding"
//  across the top of the diagram. `modernizePlantUml` replaces the line with
//  `sequenceDiagram { participant { Margin 0 N } }`, which the engine was
//  measured to lay out the way the skinparam used to (see the comment on the
//  function in `src/render/html.ts`). These tests pin the rewrite and where it
//  is applied; the measurement itself needs a real browser and is recorded in
//  that comment.
//

import { describe, expect, it } from 'vitest';

import { modernizePlantUml, renderBody } from '../src/render/html';

const STYLE = (value: string, indent = '') =>
  `${indent}<style>\n${indent}sequenceDiagram { participant { Margin 0 ${value} } }\n${indent}</style>`;

describe('modernizePlantUml', () => {
  it('rewrites skinparam ParticipantPadding into the participant margin style, in place', () => {
    const source = '@startuml\nskinparam maxMessageSize 260\nskinparam ParticipantPadding 12\nA -> B : hi\n@enduml\n';
    expect(modernizePlantUml(source)).toBe(
      `@startuml\nskinparam maxMessageSize 260\n${STYLE('12')}\nA -> B : hi\n@enduml\n`,
    );
  });

  it('matches the key in any case, keeps the indent and a decimal value', () => {
    expect(modernizePlantUml('@startuml\n  SkinParam participantPadding   7.5  \n@enduml')).toBe(
      `@startuml\n${STYLE('7.5', '  ')}\n@enduml`,
    );
  });

  it('rewrites every occurrence, so the last one still wins as it did', () => {
    const out = modernizePlantUml('@startuml\nskinparam ParticipantPadding 5\nskinparam ParticipantPadding 20\n@enduml');
    expect(out).toBe(`@startuml\n${STYLE('5')}\n${STYLE('20')}\n@enduml`);
  });

  it('leaves everything else alone, byte for byte', () => {
    for (const source of [
      '@startuml\nA -> B\n@enduml\n',
      // The engine still applies this one and only warns: not rewritten.
      '@startuml\nskinparam padding 10\nA -> B\n@enduml',
      // Not a skinparam line, and not a value.
      '@startuml\nnote over A: skinparam ParticipantPadding 12\n@enduml',
      '@startuml\nskinparam ParticipantPadding auto\n@enduml',
      // The block form draws no warning; left as the engine already treats it.
      '@startuml\nskinparam {\n  ParticipantPadding 12\n}\n@enduml',
      '\r\n',
      '',
    ]) {
      expect(modernizePlantUml(source)).toBe(source);
    }
  });
});

describe('where the rewrite applies', () => {
  const file = '@startuml r2\nskinparam ParticipantPadding 12\nparticipant A\nA -> A : self\n@enduml\n';

  it('applies to an opened .puml file', () => {
    const { html, needs } = renderBody(file, { title: 'r2', dark: false });
    expect(needs.plantuml).toBe(true);
    expect(html).not.toContain('skinparam ParticipantPadding');
    expect(html).toContain('sequenceDiagram { participant { Margin 0 12 } }');
    expect(html).toContain('&lt;style&gt;');
  });

  it('applies to a ```plantuml and a ```puml fence', () => {
    for (const fence of ['plantuml', 'puml']) {
      const { html } = renderBody(`# Title\n\n\`\`\`${fence}\n${file}\`\`\`\n`, { title: 't', dark: false });
      expect(html).not.toContain('skinparam ParticipantPadding');
      expect(html).toContain('sequenceDiagram { participant { Margin 0 12 } }');
    }
  });

  it('does not touch a code block that merely shows PlantUML', () => {
    const { html } = renderBody(`\`\`\`text\n${file}\`\`\`\n`, { title: 't', dark: false });
    expect(html).toContain('skinparam ParticipantPadding 12');
  });
});
