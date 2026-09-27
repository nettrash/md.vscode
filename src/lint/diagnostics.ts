//
//  diagnostics.ts
//  md.vscode — the dialect lint as the editor sees it: one diagnostic
//  collection, one debounce, two quick fixes.
//
//  Everything that decides *what* is a difference lives in `./dialect`, which
//  imports no editor and can be run over a string in a test. This file is the
//  wiring: when to run it, where to put the answers, and how the two
//  mechanical fixes become edits.
//
//  THE THREE DECISIONS WORTH ARGUING ABOUT
//  ---------------------------------------
//  **Information, always.** Not a setting, not a per-rule choice. Every
//  construct reported here is valid Markdown that renders perfectly well —
//  differently from GitHub, which is the whole point, but not wrongly. A
//  warning would put valid prose in the same list as a broken build, and the
//  first thing anyone would do is turn the lint off.
//
//  **Debounced by 500 ms, and only on change.** Opening a document lints it
//  at once, because the answer is wanted before the first keystroke. A change
//  waits, because a book-length file is a full parse plus one inline pass per
//  block and there is no value in running it between two letters of a word. A
//  timer per document, cancelled on the next change and on close.
//
//  **The quick fixes re-lint rather than remember.** A `vscode.Diagnostic`
//  carries no payload of ours, and stashing the fixes in a map beside the
//  collection would mean holding an edit computed against text that has since
//  changed — the classic way a "quick fix" corrupts a document. The provider
//  therefore runs the lint again over the text it is being asked about, which
//  is cheap and cannot be stale.
//

import * as vscode from 'vscode';

import { CONFIG_SECTION } from '../preview/config';
import { normalizedLines } from '../render/text';
import {
  DIALECT_RULES,
  dialectFindings,
  type DialectFinding,
  type RuleSwitches,
} from './dialect';

/** The `source` every diagnostic carries, and the collection's name. */
export const DIAGNOSTIC_SOURCE = 'md';

/** How long a document must sit still before it is linted again. */
export const LINT_DEBOUNCE_MS = 500;

/** The language this runs on. Markdown only: the rules are about Markdown. */
const LANGUAGE = 'markdown';

// MARK: - The settings

/** `md.lint.dialect` and `md.lint.rules`, resolved for one resource. */
export interface LintConfig {
  readonly enabled: boolean;
  readonly rules: RuleSwitches;
}

/**
 * Read the lint settings.
 *
 * `!== false` throughout, exactly as `readConfig` reads every other `md.*`
 * boolean: an unset key, a key the running manifest does not declare, and a
 * value of a type nobody expected all mean "on". The per-rule map is filtered
 * to the rules that exist, so a stale key left behind by a rename cannot
 * switch off a rule that happens to sort next to it.
 */
export function readLintConfig(resource?: vscode.Uri): LintConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION, resource ?? null);
  const raw = c.get<Record<string, unknown>>('lint.rules');
  const rules: Record<string, boolean> = {};
  for (const rule of DIALECT_RULES) {
    if (raw?.[rule] === false) rules[rule] = false;
  }
  return { enabled: c.get<boolean>('lint.dialect') !== false, rules };
}

/** Whether a configuration change could have changed what the lint reports. */
export function affectsLint(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration(`${CONFIG_SECTION}.lint`);
}

/** Whether this document is one the lint has anything to say about. */
export function shouldLint(document: vscode.TextDocument): boolean {
  return document.languageId === LANGUAGE;
}

// MARK: - Findings → diagnostics

/** One finding, as the Problems pane wants it. */
export function toDiagnostic(finding: DialectFinding): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(finding.line, finding.column, finding.endLine, finding.endColumn),
    finding.message,
    // Fixed here and nowhere else. See the header.
    vscode.DiagnosticSeverity.Information,
  );
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = finding.code;
  return diagnostic;
}

/** Every difference in `text`, as diagnostics. */
export function diagnosticsFor(text: string, rules: RuleSwitches): vscode.Diagnostic[] {
  return dialectFindings(text, rules).map(toDiagnostic);
}

// MARK: - Quick fixes

/**
 * The quick fixes offered for the findings that touch `range`.
 *
 * Only two findings carry one, and both are textual rearrangements with no
 * judgement in them: fence an indented block, put a blank line above a table.
 * Nothing else here gets a fix, because every other difference is a choice
 * the author has to make — which inline URL, which footnote text — and a
 * lightbulb that guesses at those would be worse than none.
 */
export function fixesFor(
  document: vscode.TextDocument,
  range: vscode.Range,
  rules: RuleSwitches,
): vscode.CodeAction[] {
  const text = document.getText();
  const lines = normalizedLines(text);
  // VS Code writes back whatever string it is handed, so a `\n` joined into a
  // CRLF document would leave it with two kinds of line ending.
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

  const actions: vscode.CodeAction[] = [];
  for (const finding of dialectFindings(text, rules)) {
    const fix = finding.fix;
    if (fix === null) continue;
    // The lightbulb asks about the cursor's line or the selection; a finding
    // is offered when the two overlap at all.
    if (finding.endLine < range.start.line || finding.line > range.end.line) continue;

    const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(fix.startLine, 0, fix.endLine, (lines[fix.endLine] ?? '').length),
      fix.lines.join(eol),
    );
    action.edit = edit;
    // Attaching the diagnostic is what lets "Fix all" and the Problems pane's
    // own lightbulb find this action.
    action.diagnostics = [toDiagnostic(finding)];
    actions.push(action);
  }
  return actions;
}

// MARK: - Registration

/**
 * The collection, and one pending timer per document.
 *
 * Module state rather than a class, matching `diagramPreview.ts`: there is
 * exactly one of each per extension host, and a constructor would only add a
 * name to thread through `activate`.
 */
let collection: vscode.DiagnosticCollection | undefined;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function registerDialectLint(context: vscode.ExtensionContext): void {
  collection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);

  context.subscriptions.push(
    collection,
    // The timers are not disposables, so they need a disposable of their own:
    // a pending lint firing after the extension has gone would write into a
    // disposed collection.
    { dispose: cancelAll },
    vscode.workspace.onDidOpenTextDocument((document) => schedule(document, 0)),
    vscode.workspace.onDidChangeTextDocument((event) => schedule(event.document, LINT_DEBOUNCE_MS)),
    vscode.workspace.onDidCloseTextDocument((document) => forget(document)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (affectsLint(event)) relintEverything();
    }),
    vscode.languages.registerCodeActionsProvider(
      { language: LANGUAGE },
      {
        provideCodeActions: (document, range) => {
          const config = readLintConfig(document.uri);
          return config.enabled ? fixesFor(document, range, config.rules) : [];
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  // `onDidOpenTextDocument` does not fire for what is already open, and what
  // is already open is the document the reader is looking at. Through the
  // debounce rather than straight away, because `activate` has to return
  // synchronously — VS Code reads `extendMarkdownIt` off the exports the
  // moment it does — and a window restored with a dozen long documents in it
  // would otherwise lint all twelve before the first preview could render.
  relintEverything();
}

export function disposeDialectLint(): void {
  cancelAll();
  collection?.dispose();
  collection = undefined;
}

function schedule(document: vscode.TextDocument, delay: number): void {
  if (!shouldLint(document)) return;
  const id = document.uri.toString();
  const existing = pending.get(id);
  if (existing !== undefined) clearTimeout(existing);
  if (delay === 0) {
    pending.delete(id);
    lint(document);
    return;
  }
  pending.set(
    id,
    setTimeout(() => {
      pending.delete(id);
      lint(document);
    }, delay),
  );
}

function lint(document: vscode.TextDocument): void {
  if (collection === undefined || !shouldLint(document)) return;
  const config = readLintConfig(document.uri);
  if (!config.enabled) {
    collection.delete(document.uri);
    return;
  }
  collection.set(document.uri, diagnosticsFor(document.getText(), config.rules));
}

function forget(document: vscode.TextDocument): void {
  const id = document.uri.toString();
  const existing = pending.get(id);
  if (existing !== undefined) clearTimeout(existing);
  pending.delete(id);
  collection?.delete(document.uri);
}

/**
 * Throw away every diagnostic and work the open documents again.
 *
 * Used at activation and whenever `md.lint.*` changes — the second is why it
 * clears first: a rule switched off must take its diagnostics with it, and
 * re-linting alone would leave the old ones sitting in the Problems pane for
 * any document that now reports nothing.
 */
function relintEverything(): void {
  if (collection === undefined) return;
  collection.clear();
  for (const document of vscode.workspace.textDocuments) schedule(document, LINT_DEBOUNCE_MS);
}

function cancelAll(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}
