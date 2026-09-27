//
//  commands.ts
//  md.vscode — what a command is invoked *on*, and what a batch of them does.
//
//  WHY THIS IS NOT IN extension.ts ANY MORE
//  ----------------------------------------
//  Until the export commands were contributed to the explorer and editor
//  context menus, every one of them ran on the active editor, and the
//  registration was one line long:
//
//      registerCommand(id, () => runOnDocument(id, run))
//
//  That arrow takes no arguments, and VS Code passes two to a command
//  invoked from a menu: the resource that was clicked, and — in the explorer
//  — every resource in the selection. Dropping them was invisible while the
//  Command Palette was the only way in (the palette passes nothing, so the
//  active editor *is* the answer); the moment a right-click on a file in the
//  explorer can say "Export as EPUB", dropping them means exporting whatever
//  happens to be open instead of the file under the pointer. So the two
//  arguments are accepted here, and the rules for reading them — which are
//  the interesting part, and the part that can be wrong — live in functions
//  a test can call.
//
//  THE THREE SHAPES OF AN INVOCATION
//  ---------------------------------
//    * **Neither argument.** The Command Palette, a keybinding, another
//      extension. The target is the active editor, exactly as before.
//    * **A uri** (editor context menu, editor tab context menu, or an
//      explorer click on one file). That file is the target, whether or not
//      it is open, and whether or not it is the active editor.
//    * **Several uris** (an explorer multi-selection). A batch — for the
//      formats that can be written without a dialogue per file.
//
//  A resolved target is opened with `workspace.openTextDocument`, never with
//  `showTextDocument`: opening an editor for every file in a twenty-file
//  batch would be its own kind of vandalism. That call also answers the
//  question an author would ask about a file they have edited but not saved —
//  it returns the **dirty buffer** when the document is open, so exporting
//  from the explorer exports what is on screen, not what is on disk.
//

import * as path from 'node:path';
import * as vscode from 'vscode';

import { isMarkdownPath, planBatchNames } from './export/batch';
import {
  epubBytes,
  exportEpub,
  exportHtml,
  exportLatex,
  exportPdf,
  exportSvg,
  htmlBytes,
  latexBytes,
  showDiagramPreview,
} from './export/index';

// MARK: - Reading the arguments

/** What a command was asked to work on, before anything is opened. */
export type Invocation =
  | { readonly kind: 'single'; readonly uri: vscode.Uri | undefined }
  | { readonly kind: 'batch'; readonly primary: vscode.Uri; readonly uris: readonly vscode.Uri[] };

/**
 * Turn the `(uri, uris)` a menu passes into the one question that matters:
 * one file or many, and which.
 *
 * Pure, and deliberately so — it is the rule most easily got wrong and least
 * easily seen going wrong. Two details are worth naming:
 *
 *  * An explorer click on a **single** file still passes `uris`, an array of
 *    one. One file is not a batch, so the length is what decides, not the
 *    presence of the array.
 *  * `uri` is the file that was actually clicked and `uris[0]` merely the
 *    first in selection order, so `uri` wins as the primary when both are
 *    given — it is the file a single-file command should fall back to, and
 *    the one to name in a message.
 */
export function classifyInvocation(
  uri?: vscode.Uri,
  uris?: readonly vscode.Uri[],
): Invocation {
  const selection = uris ?? [];
  if (selection.length > 1) {
    return { kind: 'batch', primary: uri ?? selection[0], uris: selection };
  }
  return { kind: 'single', uri: uri ?? selection[0] };
}

/**
 * The document a single-file command should act on.
 *
 * A uri is opened as a text document without being shown; nothing means the
 * active editor, which is what the Command Palette has always meant.
 */
export async function resolveDocument(
  uri: vscode.Uri | undefined,
): Promise<vscode.TextDocument | undefined> {
  if (uri !== undefined) return vscode.workspace.openTextDocument(uri);
  return targetDocument();
}

/** Languages a command may run against, in the order we would rather find them. */
const SUPPORTED_LANGUAGES: readonly string[] = ['markdown', 'plantuml', 'graphviz'];

/**
 * The document a command should act on when it was given no resource.
 *
 * `activeTextEditor` is the obvious answer and the usual one, but it is
 * `undefined` whenever the focus sits in a webview — which includes the
 * Markdown preview, the very place from which someone is most likely to reach
 * for "Export as PDF". Falling back to a visible editor of a language we
 * understand turns that from a puzzling refusal into the expected result.
 */
export function targetDocument(): vscode.TextDocument | undefined {
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

// MARK: - The command table

type DocumentCommand = (document: vscode.TextDocument) => void | Promise<void>;

/** How one format is written when the destination has already been chosen. */
interface BatchFormat {
  /** The extension a batched file takes, no dot. */
  readonly extension: string;
  /** Named in the progress notification and the summary. */
  readonly label: string;
  readonly bytes: (document: vscode.TextDocument) => Promise<Uint8Array> | Uint8Array;
}

interface CommandSpec {
  readonly id: string;
  /** The title as `package.json` spells it, for the message a refusal shows. */
  readonly title: string;
  readonly run: DocumentCommand;
  /**
   * Absent means one file at a time. PDF has no batch because it writes no
   * bytes — it hands a page to the host's print dialogue and the author picks
   * a destination there, once per document; twenty print dialogues in a row is
   * not an export, it is an ambush. Diagram SVG has none because the choice of
   * *which* diagram is a QuickPick per document, and Preview Diagram is not an
   * export at all.
   */
  readonly batch?: BatchFormat;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    id: 'md.exportHtml',
    title: 'Export as HTML',
    run: exportHtml,
    batch: { extension: 'html', label: 'HTML', bytes: (document) => htmlBytes(document, true) },
  },
  { id: 'md.exportPdf', title: 'Export as PDF', run: exportPdf },
  {
    id: 'md.exportEpub',
    title: 'Export as EPUB',
    run: exportEpub,
    batch: { extension: 'epub', label: 'EPUB', bytes: (document) => epubBytes(document, true) },
  },
  {
    id: 'md.exportLatex',
    title: 'Export as LaTeX',
    run: exportLatex,
    batch: { extension: 'tex', label: 'LaTeX', bytes: latexBytes },
  },
  { id: 'md.exportSvg', title: 'Export Diagram as SVG', run: exportSvg },
  { id: 'md.showDiagramPreview', title: 'Preview Diagram', run: showDiagramPreview },
];

export function registerCommands(context: vscode.ExtensionContext): void {
  for (const spec of COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        spec.id,
        // The two arguments every menu passes, and the reason this file
        // exists. `uris` is the whole explorer selection; `uri` the resource
        // clicked.
        (uri?: vscode.Uri, uris?: vscode.Uri[]) => dispatch(spec, uri, uris),
      ),
    );
  }
}

async function dispatch(
  spec: CommandSpec,
  uri?: vscode.Uri,
  uris?: vscode.Uri[],
): Promise<void> {
  const invocation = classifyInvocation(uri, uris);

  if (invocation.kind === 'batch') {
    const format = spec.batch;
    if (format !== undefined) {
      await guarded(spec.id, () => runBatch(spec.id, format, invocation.uris));
      return;
    }
    // A multi-selection reaching a single-file command is not impossible —
    // `when` clauses hide these rows, but a keybinding or another extension
    // can still call the id with arguments — so say what is happening rather
    // than silently exporting one file of five.
    void vscode.window.showWarningMessage(
      `md: ${spec.title} works on one file at a time — using ${path.basename(invocation.primary.path)}.`,
    );
  }

  const target = invocation.kind === 'batch' ? invocation.primary : invocation.uri;
  await guarded(spec.id, async () => {
    const document = await resolveDocument(target);
    if (!document) {
      void vscode.window.showWarningMessage(
        'md: open a Markdown, PlantUML or Graphviz file first.',
      );
      return;
    }
    await spec.run(document);
  });
}

/**
 * Run one command's work and turn anything thrown into a message the author
 * can read.
 *
 * Errors are thrown rather than swallowed everywhere under `src/export`, on
 * the principle that a silently dead export reads as a broken extension. This
 * is the one place that catches them.
 */
async function guarded(id: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[md] ${id} failed`, err);
    void vscode.window.showErrorMessage(`md: ${id} failed — ${message}`);
  }
}

// MARK: - Batch

/**
 * The files in a selection a batch should act on, and how many it let go.
 *
 * `resourceLangId` in a `when` clause is evaluated against the file that was
 * *clicked*, so a mixed selection arrives here with folders, images and
 * whatever else a rubber band caught. Something has to decide; the question
 * is who.
 *
 * Not `MARKDOWN_EXTENSIONS`, which was the first answer and the wrong one.
 * That list is this repository's, the `when` clause's list is the editor's,
 * and the editor's is longer: `markdown-basics` alone adds `.litcoffee`,
 * `.ron`, `.ronn` and `.workbook`, and claims the Cursor rule files under a
 * `.cursor` folder by file-name pattern rather than by extension at all.
 * Every one of those gets the *md: Export* submenu and exports correctly on
 * its own — and was then thrown out
 * of any multi-selection, with a message ("not Markdown") the editor would
 * disagree with. A list that has to track someone else's list drifts the day
 * they change theirs.
 *
 * So the host answers, through `languageId` — the same source of truth the
 * `when` clause reads. `isMarkdownPath` stays in front of it as a cheap yes:
 * a folder of twenty `.md` files must not cost twenty opens to establish
 * what its names already say. Everything else is opened and asked, and a uri
 * that cannot be opened at all — a folder, most often — is a skip rather than
 * a failure.
 */
export async function batchTargets(
  uris: readonly vscode.Uri[],
): Promise<{ targets: vscode.Uri[]; skipped: number }> {
  const targets: vscode.Uri[] = [];
  let skipped = 0;
  for (const uri of uris) {
    if (isMarkdownPath(uri.path)) {
      targets.push(uri);
      continue;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.languageId === 'markdown') targets.push(uri);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { targets, skipped };
}

/**
 * Export every Markdown file in a selection into one folder.
 *
 * The shape is fixed by what a batch may not do: it may not ask twenty
 * questions. So it asks exactly one — where to put them — and then every
 * other decision is a rule rather than a dialogue: the file name comes from
 * `planBatchNames`, a name already taken takes a `-2`, and a file that fails
 * is named in the summary instead of stopping the run. One cancellable
 * progress notification covers the lot; cancelling stops before the next
 * file, since a render already in flight owns a webview that has to be
 * disposed either way.
 */
async function runBatch(
  id: string,
  format: BatchFormat,
  uris: readonly vscode.Uri[],
): Promise<void> {
  const { targets, skipped } = await batchTargets(uris);
  if (targets.length === 0) {
    void vscode.window.showWarningMessage('md: no Markdown files in that selection.');
    return;
  }

  const folder = await askForFolder(format.label, targets[0]);
  if (folder === null) return;

  const names = planBatchNames(
    targets.map((uri) => uri.path),
    format.extension,
    await existingNames(folder),
  );

  const failures: string[] = [];
  let exported = 0;
  let cancelled = false;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `md: exporting ${targets.length} files as ${format.label}…`,
      cancellable: true,
    },
    async (progress, token) => {
      for (let index = 0; index < targets.length; index++) {
        if (token.isCancellationRequested) {
          cancelled = true;
          return;
        }
        const source = targets[index];
        const name = names[index];
        progress.report({
          message: `${index + 1} of ${targets.length} — ${name}`,
          increment: index === 0 ? 0 : 100 / targets.length,
        });

        try {
          // The open document when there is one, so an unsaved edit is in the
          // export; the file on disk otherwise.
          const document = await vscode.workspace.openTextDocument(source);
          const bytes = await format.bytes(document);
          await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, name), bytes);
          exported++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[md] ${id} failed for ${source.path}`, err);
          failures.push(`${path.basename(source.path)} (${message})`);
        }
      }
    },
  );

  await reportBatch(folder, exported, failures, skipped, cancelled);
}

/**
 * Ask once where the whole selection should land. Null means cancelled — and a
 * cancelled dialogue must leave nothing behind, which here is easy: nothing has
 * been rendered yet, because the question comes first.
 */
async function askForFolder(label: string, near: vscode.Uri): Promise<vscode.Uri | null> {
  const chosen = await vscode.window.showOpenDialog({
    // The folder the first selected file is in, which is where a batch export
    // most often wants to go and always the right place to start looking.
    defaultUri: vscode.Uri.joinPath(near, '..'),
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Export Here',
    title: `Export as ${label} — choose a folder`,
  });
  return chosen === undefined || chosen.length === 0 ? null : chosen[0];
}

/**
 * What the destination folder already holds, so the collision rule can see it.
 *
 * Read once rather than per file, and a folder that cannot be listed is
 * treated as empty: a listing is an optimisation for naming, not a
 * precondition for writing, and refusing to export because a directory
 * listing failed would be the wrong trade.
 */
async function existingNames(folder: vscode.Uri): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(folder);
    return entries.map(([name]) => name);
  } catch {
    return [];
  }
}

/** One message for the whole run — what landed, what did not, and why. */
async function reportBatch(
  folder: vscode.Uri,
  exported: number,
  failures: readonly string[],
  skipped: number,
  cancelled: boolean,
): Promise<void> {
  const files = (count: number): string => `${count} ${count === 1 ? 'file' : 'files'}`;
  const parts = [`exported ${files(exported)}`];
  if (failures.length > 0) parts.push(`${failures.length} failed`);
  if (skipped > 0) parts.push(`${files(skipped)} skipped — not Markdown`);
  if (cancelled) parts.push('cancelled');

  const headline = `md: ${parts.join(', ')} — ${path.basename(folder.path)}`;
  const reveal = 'Reveal';

  if (failures.length === 0) {
    if (exported === 0) {
      void vscode.window.showWarningMessage(headline);
      return;
    }
    const choice = await vscode.window.showInformationMessage(headline, reveal);
    if (choice === reveal) await vscode.commands.executeCommand('revealFileInOS', folder);
    return;
  }

  // Every failure is named. Truncating the list would hide exactly the file
  // the author needs to look at, and the detail of a modal message scrolls.
  const choice = await vscode.window.showWarningMessage(
    headline,
    { modal: true, detail: failures.join('\n') },
    reveal,
  );
  if (choice === reveal) await vscode.commands.executeCommand('revealFileInOS', folder);
}
