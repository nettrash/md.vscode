//
//  types.ts
//  md.vscode — the parity core's data model.
//
//  A direct port of the `MarkdownBlock` model in
//  `md/md/MarkdownParser.swift`. Eleven block kinds; that is the whole model.
//  There is no `image`, no `math`, no `csv`, no `html` and no
//  `linkReferenceDefinition` kind — math and CSV are decided by the *renderer*
//  from a fenced block's info string or by the inline pass, not by the parser.
//
//  The block list is flat except for `quote`, the only recursive kind.
//
//  Blocks deliberately carry no source range: the Swift model has none, because
//  identity in the SwiftUI preview comes from position. VS Code's scroll sync
//  does need line numbers, so `parseWithLines()` returns them alongside the
//  blocks rather than inside them — keeping this model byte-identical to the
//  app's, which every export path depends on.
//

/** Column alignment of a GFM table, as written in the delimiter row. */
export type ColumnAlignment = 'leading' | 'center' | 'trailing';

/**
 * One `key: value` pair of YAML / TOML front matter.
 *
 * Order is the order written and **duplicate keys are kept, not collapsed** —
 * this is a record of what the author wrote, not a dictionary. Consumers
 * resolve duplicates themselves (both `fields(of:)` and `documentTitle` take
 * the first occurrence).
 */
export interface MetadataField {
  key: string;
  value: string;
}

/**
 * One line of a bullet / ordered / task list.
 *
 * `level` is a depth *tag*, not a tree: the renderer insets by `level * 1.6em`
 * rather than reconstructing nested `<ul>`/`<ol>` from a non-tree model.
 */
export interface ListItem {
  /** Inline Markdown; the marker and any task box have already been removed. */
  text: string;
  /** 0 = top level; `floor(indentColumns / 2)`. */
  level: number;
  /** `null` for bullets. */
  ordinal: number | null;
  /** `null` = not a task item; `false` = `[ ]`; `true` = `[x]` / `[X]`. */
  task: boolean | null;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type Block =
  | { kind: 'heading'; level: HeadingLevel; text: string }
  /** Soft breaks inside a paragraph are preserved as `"\n"`. */
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'codeBlock'; language: string | null; code: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'table'; header: string[]; alignments: ColumnAlignment[]; rows: string[][] }
  | { kind: 'thematicBreak' }
  | { kind: 'pageBreak' }
  /** An `<!-- note: … -->` author note. */
  | { kind: 'note'; text: string }
  | { kind: 'frontMatter'; fields: MetadataField[] }
  | { kind: 'footnoteDefinition'; id: string; text: string };

export type BlockKind = Block['kind'];

/** An entry of the Contents outline. `line` is 0-based. */
export interface OutlineEntry {
  level: number;
  text: string;
  slug: string;
  line: number;
}

/** An entry of the notes panel. `line` is 0-based. */
export interface NoteEntry {
  text: string;
  line: number;
}

/**
 * A block paired with the 0-based source line it started on.
 *
 * VS Code only — the apps have no equivalent. The built-in Markdown preview
 * syncs scrolling off `class="code-line" data-line="N"` attributes, so the
 * emitter needs a line per top-level block. Keeping it *beside* the block
 * rather than *inside* it is what lets `Block` stay byte-identical to Swift's.
 */
export interface PlacedBlock {
  block: Block;
  line: number;
}
