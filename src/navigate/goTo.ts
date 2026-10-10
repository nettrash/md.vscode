//
//  goTo.ts
//  md.vscode — Go to Heading… and Go to Note…
//
//  QuickPicks over md's own outline and the document's private notes. They
//  behave like VS Code's Go to Symbol: the editor follows the highlighted row,
//  Escape puts it back where it was, and Enter moves the caret to the line.
//  The Notes half is the real gap — VS Code's Outline lists headings, but no
//  view anywhere lists `<!-- note: … -->` comments.
//

import * as vscode from 'vscode';

import { notes, outline } from '../render/parser';
import { headingRows, noteRows, type GoToRow } from './items';

type Row = vscode.QuickPickItem & { line: number };

async function goTo(kind: 'heading' | 'note'): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.languageId !== 'markdown') {
    void vscode.window.showInformationMessage('md: open a Markdown document first.');
    return;
  }
  const source = editor.document.getText();
  const rows: GoToRow[] = kind === 'heading' ? headingRows(outline(source)) : noteRows(notes(source));
  if (rows.length === 0) {
    void vscode.window.showInformationMessage(
      kind === 'heading' ? 'md: this document has no headings.' : 'md: this document has no notes.',
    );
    return;
  }

  const pick = vscode.window.createQuickPick<Row>();
  pick.items = rows.map((r) => ({ label: r.label, description: r.description, line: r.line }));
  pick.placeholder = kind === 'heading' ? 'Go to a heading' : 'Go to a note';
  pick.matchOnDescription = false;
  const restore = { selection: editor.selection, range: editor.visibleRanges[0] };
  const reveal = (line: number): void =>
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);

  let accepted = false;
  pick.onDidChangeActive((active) => {
    if (active[0] !== undefined) reveal(active[0].line);
  });
  pick.onDidAccept(() => {
    const row = pick.selectedItems[0] ?? pick.activeItems[0];
    if (row !== undefined) {
      accepted = true;
      const position = new vscode.Position(row.line, 0);
      editor.selection = new vscode.Selection(position, position);
      reveal(row.line);
    }
    pick.hide();
  });
  pick.onDidHide(() => {
    if (!accepted) {
      editor.selection = restore.selection;
      if (restore.range !== undefined) editor.revealRange(restore.range, vscode.TextEditorRevealType.AtTop);
    } else {
      void vscode.window.showTextDocument(editor.document, editor.viewColumn);
    }
    pick.dispose();
  });
  pick.show();
}

export function registerGoTo(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('md.goToHeading', () => goTo('heading')),
    vscode.commands.registerCommand('md.goToNote', () => goTo('note')),
  );
}
