//
//  wordCount.ts
//  md.vscode — the word and character count in the status bar.
//
//  The md apps carry "211 words · 1,425 characters" under every page; this is
//  that footer, in the place VS Code keeps such things. It shows while a Markdown
//  editor is active, counts the selection too when there is one, and goes away
//  with `md.statusBar.wordCount` set to false. Counting is debounced: a long
//  document is segmented once per pause in typing, not once per keystroke.
//

import * as vscode from 'vscode';

import { countCharacters, countLabel, countWords, readingMinutes, selectionCount } from './count';

const DEBOUNCE_MS = 250;

export function registerWordCount(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem('md.wordCount', vscode.StatusBarAlignment.Right, 100);
  item.name = 'md: Word Count';
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The document's own count, kept between selection changes: moving the caret
  // must not re-segment the whole file. Keyed on the document object, not its
  // URI: a version number starts again when a file is closed and reopened, so a
  // file changed on disk in between could otherwise come back at a version
  // that matches the stale count.
  let cached: { document: vscode.TextDocument; version: number; words: number; characters: number } | undefined;

  const update = (): void => {
    // Called directly on an editor or setting change as well as by the
    // debounce: a pending count is cancelled, not merely forgotten, or it
    // would fire later and clear the handle of the next one.
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const editor = vscode.window.activeTextEditor;
    const enabled = vscode.workspace
      .getConfiguration('md', editor?.document.uri)
      .get<boolean>('statusBar.wordCount', true);
    if (editor === undefined || editor.document.languageId !== 'markdown' || !enabled) {
      item.hide();
      return;
    }
    const document = editor.document;
    if (cached?.document !== document || cached.version !== document.version) {
      const text = document.getText();
      cached = { document, version: document.version, words: countWords(text), characters: countCharacters(text) };
    }
    const selection = selectionCount(editor.selections.map((s) => document.getText(s)));
    item.text = countLabel(cached, selection);
    const minutes = readingMinutes(cached.words);
    item.tooltip = `md: about ${minutes} minute${minutes === 1 ? '' : 's'} to read. Words and characters are counted as the md apps count them.`;
    item.show();
  };
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(update, DEBOUNCE_MS);
  };

  context.subscriptions.push(
    item,
    vscode.window.onDidChangeActiveTextEditor(() => update()),
    vscode.window.onDidChangeTextEditorSelection(schedule),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) schedule();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('md.statusBar.wordCount')) update();
    }),
    { dispose: () => timer !== undefined && clearTimeout(timer) },
  );
  update();
}
