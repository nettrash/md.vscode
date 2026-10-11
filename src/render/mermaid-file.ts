//
//  mermaid-file.ts
//  md.vscode — a Mermaid file (.mmd, .mermaid) as the one diagram it is.
//
//  md draws Mermaid from a ```mermaid fence. A Mermaid file is that fence's
//  content with no Markdown around it, so the panel and the SVG export hand the
//  renderer the file wrapped in a fence of its own — and nothing else changes:
//  the same container, the same engine, the same capture.
//
//  Whether a document is a Mermaid file is decided by its VS Code language id
//  (`mermaid`, from the .mmd / .mermaid extensions), never by looking at its
//  text: Mermaid's opening words (`graph`, `flowchart`, `pie`, `journey` …) are
//  ordinary English, and a content probe would draw a paragraph as a diagram.
//

/** The language id this extension contributes for .mmd and .mermaid files. */
export const MERMAID_LANGUAGE = 'mermaid';

/**
 * `source` as a Markdown document holding exactly one ```mermaid fence. The
 * fence is one backtick longer than any run of backticks in the file, so no line
 * of the diagram can close it early.
 */
export function mermaidFileAsMarkdown(source: string): string {
  let longest = 2;
  for (const run of source.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(longest + 1);
  const body = source.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return `${fence}mermaid\n${body}\n${fence}\n`;
}

/** The text md renders for a document of `languageId`: a Mermaid file wrapped, anything else as it is. */
export function renderableSource(source: string, languageId: string): string {
  return languageId === MERMAID_LANGUAGE ? mermaidFileAsMarkdown(source) : source;
}
