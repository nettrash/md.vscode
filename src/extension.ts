//
//  extension.ts
//  md.vscode — activation, commands, and the one export VS Code comes looking
//  for.
//
//  This file is deliberately thin. The parity core knows nothing about VS
//  Code, the engines know nothing about the preview, and the preview knows
//  nothing about exporting; the wiring between them lives here and nowhere
//  else, so that the layering rule stays checkable by reading four imports.
//
//  ACTIVATION, AND WHY NOTHING HERE IS AWAITED
//  -------------------------------------------
//  `activate` must return synchronously, because VS Code reads
//  `extension.exports.extendMarkdownIt` immediately after awaiting activation
//  and calls it on the very next render. Warming Graphviz means compiling
//  1.4 MB of inlined WebAssembly; awaiting that would hold up the first
//  preview of every session for the sake of documents that mostly contain no
//  diagrams at all. So the warm-up runs alongside, and when it lands we ask
//  the preview to render again — the second render finds the engine warm and
//  the diagrams appear. Until then `renderGraphvizSync` returns `null` and
//  each block keeps its DOT source on screen, which is the family's rule for
//  a diagram that has not rendered: show the source, never a hole.
//

import * as vscode from 'vscode';

import { warmUp } from './engines/graphviz';
import { setRichRoot } from './engines/paths';
//
//  The six commands declared in `package.json` delegate straight into the
//  export layer. The contract this file compiles against is one function per
//  command, each taking the document to work on and doing its own file
//  dialogue and its own writing:
//
//      export function exportHtml(document: vscode.TextDocument): Promise<void>;
//      export function exportPdf(document: vscode.TextDocument): Promise<void>;
//      export function exportEpub(document: vscode.TextDocument): Promise<void>;
//      export function exportLatex(document: vscode.TextDocument): Promise<void>;
//      export function exportSvg(document: vscode.TextDocument): Promise<void>;
//      export function showDiagramPreview(document: vscode.TextDocument): Promise<void>;
//
//  Errors are thrown, not swallowed: `runOnDocument` below turns them into a
//  message the author can read, which is the one thing a silent export must
//  never do.
//
import {
  exportEpub,
  exportHtml,
  exportLatex,
  exportPdf,
  exportSvg,
  showDiagramPreview,
} from './export/commands';
import { richDirectory } from './preview/assets';
import { affectsPreview, readConfig } from './preview/config';
import { extendMarkdownIt } from './preview/markdownItHook';

/** The public API object VS Code reads after activating us. */
export interface MdApi {
  extendMarkdownIt(md: any): any;
}

export function activate(context: vscode.ExtensionContext): MdApi {
  // The engines load their vendored copies from disk by absolute path rather
  // than being bundled, so that `media/rich` keeps the exact bytes the three
  // apps ship and the 7.4 MB PlantUML module never enters a JavaScript bundle.
  // They need to be told where that directory is exactly once.
  setRichRoot(richDirectory(context.extensionUri.fsPath));

  registerCommands(context);

  context.subscriptions.push(
    // The palette, the two font stacks and `data-md-dark` are baked into the
    // markup we hand the preview — we have no channel to update a live page,
    // and the preview does not re-render itself when the workbench theme
    // changes because its own styling is all CSS variables. So a theme flip
    // has to become a re-render, or a document opened in the light theme
    // keeps its paper background all the way into the dark one.
    vscode.window.onDidChangeActiveColorTheme(() => {
      refreshPreviews();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!affectsPreview(e)) return;
      // Turning Graphviz on mid-session should not require a reload.
      warmGraphviz();
      refreshPreviews();
    }),
  );

  warmGraphviz();

  return { extendMarkdownIt };
}

export function deactivate(): void {
  // Nothing to undo: every listener and command is in `context.subscriptions`,
  // which VS Code disposes for us, and the engines hold no handles worth
  // closing — the vendored files are read once and cached in memory.
}

// MARK: - Commands

type DocumentCommand = (document: vscode.TextDocument) => void | Promise<void>;

/** Languages a command may run against, in the order we would rather find them. */
const SUPPORTED_LANGUAGES: readonly string[] = ['markdown', 'plantuml', 'graphviz'];

function registerCommands(context: vscode.ExtensionContext): void {
  const commands: ReadonlyArray<readonly [string, DocumentCommand]> = [
    ['md.exportHtml', exportHtml],
    ['md.exportPdf', exportPdf],
    ['md.exportEpub', exportEpub],
    ['md.exportLatex', exportLatex],
    ['md.exportSvg', exportSvg],
    ['md.showDiagramPreview', showDiagramPreview],
  ];

  for (const [id, run] of commands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => runOnDocument(id, run)),
    );
  }
}

async function runOnDocument(id: string, run: DocumentCommand): Promise<void> {
  const document = targetDocument();
  if (!document) {
    void vscode.window.showWarningMessage(
      'md: open a Markdown, PlantUML or Graphviz file first.',
    );
    return;
  }

  try {
    await run(document);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[md] ${id} failed`, err);
    void vscode.window.showErrorMessage(`md: ${id} failed — ${message}`);
  }
}

/**
 * The document a command should act on.
 *
 * `activeTextEditor` is the obvious answer and the usual one, but it is
 * `undefined` whenever the focus sits in a webview — which includes the
 * Markdown preview, the very place from which someone is most likely to reach
 * for "Export as PDF". Falling back to a visible editor of a language we
 * understand turns that from a puzzling refusal into the expected result.
 */
function targetDocument(): vscode.TextDocument | undefined {
  // Whatever the author has focused wins, whatever its language: the menu
  // `when` clauses already decide where these commands are offered, and
  // second-guessing them here would refuse a `.txt` file somebody is
  // deliberately treating as Markdown.
  const active = vscode.window.activeTextEditor?.document;
  if (active) return active;

  for (const language of SUPPORTED_LANGUAGES) {
    const visible = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.languageId === language,
    );
    if (visible) return visible.document;
  }
  return undefined;
}

// MARK: - Graphviz warm-up

/** One warm-up per session; a second call while the first is in flight is a no-op. */
let graphvizWarming = false;

function warmGraphviz(): void {
  if (graphvizWarming) return;
  // Read the window-level value: the setting is `resource`-scoped, but there
  // is no resource to scope to before a document is previewed, and warming an
  // engine the user has switched off everywhere is pure waste.
  if (!readConfig().graphviz) return;

  graphvizWarming = true;
  void warmUp().then(
    () => {
      // Anything rendered while the engine was cold emitted its DOT source
      // instead of an SVG. Rendering again is the only way to fill those in:
      // the built-in preview owns its page and there is no channel by which
      // to patch a single block.
      refreshPreviews();
    },
    (err: unknown) => {
      // Let a later configuration change try again — a failure here is
      // usually a missing or truncated `media/rich/viz-global.js`, which a
      // reinstall fixes.
      graphvizWarming = false;
      console.error('[md] Graphviz failed to warm up; dot blocks will keep their source.', err);
    },
  );
}

// MARK: - Talking to a preview we do not own

/**
 * Ask the built-in Markdown preview to render again.
 *
 * `markdown.preview.refresh` belongs to `vscode.markdown-language-features`.
 * When no preview has been opened that extension may not be running yet and
 * the command will not exist — which is exactly the case in which there is
 * nothing to refresh, so the rejection is swallowed rather than reported. Any
 * other failure is equally harmless: the next keystroke re-renders anyway.
 */
function refreshPreviews(): void {
  void Promise.resolve(vscode.commands.executeCommand('markdown.preview.refresh')).then(
    undefined,
    () => {
      /* No preview to refresh. */
    },
  );
}
