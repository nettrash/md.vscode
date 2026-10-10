//
//  index.ts
//  md.vscode — the six export commands, and the only place in this folder that
//  opens a file dialogue.
//
//  Each command does the same four things in the same order, and the order is
//  the interesting part:
//
//    1. resolve the document and whatever the export needs chosen (which
//       diagram, which trim size);
//    2. **ask for a destination** with `showSaveDialog` — a cancelled dialogue
//       ends the command, having written nothing anywhere;
//    3. render, which for four of the six means loading the real engines in an
//       offscreen webview and waiting for md's own `data-md-render-complete`;
//    4. write the bytes to the chosen destination and say so, or fail with a
//       message naming what went wrong.
//
//  Step 2 comes before step 3 deliberately, which is the opposite of the apps.
//  On iOS the export renders to a temporary file first and hands that to the
//  Files picker, because the picker *moves* it. VS Code has no such handoff:
//  `showSaveDialog` returns a URI and we write to it ourselves. Asking first
//  means a document with six PlantUML diagrams does not spend ninety seconds
//  rendering only to be thrown away, and it means this folder never creates a
//  temporary file the user did not ask for.
//
//  ERRORS ARE THROWN, NEVER SWALLOWED. `extension.ts` catches and shows them.
//  The comment in the Swift is worth keeping: "a silently dead share button
//  after a long render reads as a broken app".
//

import * as path from 'node:path';
import * as vscode from 'vscode';

import { frontMatter } from '../render/parser';
import { rawDiagramKind, renderDocument, type RawDiagram } from '../render/html';
import { renderableSource } from '../render/mermaid-file';
import {
  ASSETS_DIRECTORY_NAME,
  BUNDLE_EXTENSION,
  INFO_FILE_NAME,
  TEXT_FILE_NAME,
  bundleFiles,
  exportRewriting,
  isLocalRelativeReference,
  packEntries,
} from './textbundle';
import { archive } from './zip';
import { isInside, readLocalAsset } from './asset-reader';
import { coverReference, epubMetadata, fieldValue, MAX_COVER_BYTES, recogniseCover, type EpubCover } from './epub-metadata';
import { readConfig } from '../preview/config';
import { openDiagramPreview } from '../preview/diagramPreview';

import { sanitized, stemOfPath } from './batch';
import {
  applyImageReplacements,
  bodyContent,
  documentTitle,
  imageHref,
  imageTag,
  modifiedNow,
  packDocumentEpub,
  richElementRanges,
  xhtml,
  type EpubImage,
  epubOutline,
} from './epub';
import { exportDocumentHTML, selfContainedHTML as finishSelfContainedHTML } from './html';
import { latexDocument } from './latex';
import { pageSizeNamed, pdfDocumentHTML, printThroughWebview } from './pdf';
import { RenderHost } from './renderHost';
import { diagrams, menuTitle, standaloneDocument, type Diagram } from './svg';

// MARK: - LaTeX  (ship order 1 — pure, and the only export where byte parity is achievable)

/**
 * Export the document as LaTeX source.
 *
 * Alone among the exports this one needs neither a browser nor a theme: the
 * writer is pure string work on the same parsed blocks, and a `.tex` file has
 * no light or dark. It is also the only export that keeps the author's
 * mathematics *as* mathematics — everything else either rasterises it or
 * re-typesets it as KaTeX.
 */
export async function exportLatex(document: vscode.TextDocument): Promise<void> {
  const title = baseName(document);
  const destination = await askWhereToSave(document, title, 'tex', { LaTeX: ['tex'] });
  if (destination === null) return;
  await write(destination, latexBytes(document));
}

/**
 * The same `.tex`, as bytes and without a dialogue.
 *
 * The three `…Bytes` functions in this file are what a **batch** export runs:
 * one destination has already been chosen for the whole selection, so the
 * step that asks is the one step that must not happen per file. They are the
 * middle of each command above with both ends removed — no dialogue, no
 * write, no notification — which is why each command is now written in terms
 * of its own byte function rather than beside it. `quiet` suppresses the
 * per-file progress notification, because the batch shows one of its own.
 */
export function latexBytes(document: vscode.TextDocument): Uint8Array {
  return Buffer.from(latexDocument(document.getText()), 'utf8');
}

// MARK: - SVG  (ship order 2 — pure fix-up plus one DOM read)

/**
 * Export one rendered diagram as a standalone `.svg`.
 *
 * The document may hold several, so the choice comes first — one diagram is
 * taken without asking, more than one is a QuickPick over the same labels the
 * apps show in their submenu. A document with none says so and stops; there is
 * nothing to render and no dialogue worth opening.
 */
export async function exportSvg(document: vscode.TextDocument): Promise<void> {
  // A Mermaid file is its one diagram, wrapped in a fence of its own (#5).
  const source = renderableSource(document.getText(), document.languageId);
  const available = diagrams(source, knownDiagram(document));
  if (available.length === 0) {
    void vscode.window.showInformationMessage('md: no diagrams in this document.');
    return;
  }

  const diagram = available.length === 1 ? available[0] : await pickDiagram(available);
  if (diagram === null) return;

  const title = baseName(document);
  // The 1-based suffix is the apps' own: `<title>-1.svg` for the first diagram.
  const destination = await askWhereToSave(document, `${title}-${diagram.ordinal + 1}`, 'svg', {
    SVG: ['svg'],
  });
  if (destination === null) return;

  // `dark: false` because an `.svg` file carries no screen theme — Mermaid bakes
  // its own colours in, Graphviz and PlantUML draw explicit ink, and a plot
  // draws in `currentColor`, which in a standalone file resolves to the
  // initial colour, i.e. black on the viewer's own page — and `export: true`
  // only to keep the same page every other capture uses; it changes nothing in
  // the vector.
  const html = renderDocument(source, { title, dark: false, export: true, diagram: knownDiagram(document) });
  const svg = await withRenderHost(html, title, 'Rendering the diagram…', (host) =>
    host.diagramSVG(diagram.ordinal),
  );
  if (svg === null) {
    // Exactly the case where the engine threw or timed out: md-init.js restores
    // the block's source text and leaves no `<svg>` behind.
    throw new Error("This diagram couldn't be captured — it may have failed to render.");
  }
  await write(destination, Buffer.from(standaloneDocument(svg), 'utf8'));
}

// MARK: - TextBundle and TextPack  (the family's sixth export)

/**
 * Read an image the document references by a relative path, from beside the
 * document. On the local disk that is `readLocalAsset`, which resolves symlinks
 * before its containment test. Anywhere else — a remote or virtual workspace —
 * there is no real path to resolve, so the path must lie lexically inside the
 * document's folder and **no component of it may be a symbolic link**: each
 * step from the folder down is looked at through VS Code's file system, and a
 * link anywhere leaves the image unresolved rather than followed. An untitled
 * document has no folder and finds nothing.
 */
async function readAsset(document: vscode.TextDocument, relativePath: string): Promise<Uint8Array | null> {
  if (document.isUntitled) return null;
  if (document.uri.scheme === 'file') return readLocalAsset(relativePath, document.uri.fsPath);
  const folder = vscode.Uri.joinPath(document.uri, '..');
  const candidate = vscode.Uri.joinPath(folder, relativePath);
  if (!isInside(folder.path, candidate.path, path.posix)) return null;
  try {
    const steps = path.posix.relative(folder.path, candidate.path).split('/');
    let step = folder;
    for (let index = 0; index < steps.length; index++) {
      step = vscode.Uri.joinPath(step, steps[index]);
      const type = (await vscode.workspace.fs.stat(step)).type;
      if (type & vscode.FileType.SymbolicLink) return null;
      if (index === steps.length - 1 && !(type & vscode.FileType.File)) return null;
    }
    return await vscode.workspace.fs.readFile(candidate);
  } catch {
    return null;
  }
}

/** The document rewritten for a bundle, its local images read from beside it. */
async function bundleRewrite(document: vscode.TextDocument) {
  return exportRewriting(document.getText(), (relative) => readAsset(document, relative));
}

/** The `.textpack`, as bytes and without a dialogue. See `latexBytes`. */
export async function textPackBytes(document: vscode.TextDocument): Promise<Uint8Array> {
  return archive(packEntries(sanitized(baseName(document)), await bundleRewrite(document)));
}

/**
 * Save the document as a `.textpack`: the bundle zipped, as every md app writes
 * it. A note follows when the document is untitled and refers to local images —
 * it has no folder for them to be found in, so they stay as written.
 */
export async function exportTextPack(document: vscode.TextDocument): Promise<void> {
  const title = baseName(document);
  const destination = await askWhereToSave(document, title, 'textpack', { TextPack: ['textpack'] });
  if (destination === null) return;
  await write(destination, await textPackBytes(document));
  untitledImageNote(document);
}

/**
 * Write the document as a `<name>.textbundle` folder into a folder the author
 * picks — a save dialogue cannot portably name a directory, so the parent is
 * chosen, as on Windows — and ask before replacing a bundle already there. A
 * replaced bundle is replaced whole: an image from an earlier export must not
 * linger in its assets/.
 */
export async function exportTextBundle(document: vscode.TextDocument): Promise<void> {
  const title = sanitized(baseName(document));
  const near = document.isUntitled ? vscode.workspace.workspaceFolders?.[0]?.uri : vscode.Uri.joinPath(document.uri, '..');
  const chosen = await vscode.window.showOpenDialog({
    defaultUri: near,
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Export Here',
    title: `Export as TextBundle — choose the folder to put ${title}${BUNDLE_EXTENSION} in`,
  });
  if (chosen === undefined || chosen.length === 0) return;
  const target = vscode.Uri.joinPath(chosen[0], `${title}${BUNDLE_EXTENSION}`);

  let exists = false;
  try {
    await vscode.workspace.fs.stat(target);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    const replace = 'Replace';
    const answer = await vscode.window.showWarningMessage(
      `${title}${BUNDLE_EXTENSION} already exists in that folder. Replace it?`,
      { modal: true },
      replace,
    );
    if (answer !== replace) return;
  }

  // The new bundle is written whole beside the old one first and only then
  // moved over it, so a failure part-way — an unreadable image, a full disk —
  // leaves the existing bundle untouched rather than deleted and half-replaced.
  const files = bundleFiles(await bundleRewrite(document));
  const staging = vscode.Uri.joinPath(chosen[0], `.${title}${BUNDLE_EXTENSION}.md-${Date.now().toString(36)}`);
  try {
    const assets = vscode.Uri.joinPath(staging, ASSETS_DIRECTORY_NAME);
    await vscode.workspace.fs.createDirectory(assets);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(staging, INFO_FILE_NAME), files.info);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(staging, TEXT_FILE_NAME), files.text);
    for (const asset of files.assets) {
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(assets, asset.name), asset.data);
    }
    await vscode.workspace.fs.rename(staging, target, { overwrite: true });
  } catch (error) {
    await Promise.resolve(vscode.workspace.fs.delete(staging, { recursive: true, useTrash: false })).catch(() => undefined);
    throw error;
  }
  const reveal = 'Reveal';
  const choice = await vscode.window.showInformationMessage(`md: exported ${title}${BUNDLE_EXTENSION}`, reveal);
  if (choice === reveal) await vscode.commands.executeCommand('revealFileInOS', target);
  untitledImageNote(document);
}

/** Say once, after the export, why an untitled document's local images were not bundled. */
function untitledImageNote(document: vscode.TextDocument): void {
  if (!document.isUntitled) return;
  const local = [...document.getText().matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].filter((m) => isLocalRelativeReference(m[1]));
  if (local.length === 0) return;
  void vscode.window.showInformationMessage(
    'md: this document is not saved yet, so it has no folder to find its local images in — they stay as written. Save it first to bundle them.',
  );
}

/**
 * The bare diagram a document is by its language: a `.gv` file the editor
 * opened as Graphviz is drawn as one even when its text alone would not say so
 * (a DOT file that opens with a `#` line). Everything else — PlantUML, whose
 * `.iuml` fragments are not diagrams, and Markdown — is read from the text, as
 * before. See `rawDiagramKind`.
 */
function knownDiagram(document: vscode.TextDocument): RawDiagram | undefined {
  return rawDiagramKind('', document.languageId) ?? undefined;
}

// MARK: - HTML  (ship order 3 — capture plus KaTeX inlining)

/**
 * Export the rendered document as a single HTML file the reader can open
 * anywhere — no engines, no folder of assets, no network.
 */
export async function exportHtml(document: vscode.TextDocument): Promise<void> {
  const title = baseName(document);
  const destination = await askWhereToSave(document, title, 'html', { HTML: ['html'] });
  if (destination === null) return;
  await write(destination, await htmlBytes(document));
}

/** The self-contained `.html`, as bytes and without a dialogue. See `latexBytes`. */
export async function htmlBytes(
  document: vscode.TextDocument,
  quiet = false,
): Promise<Uint8Array> {
  const title = baseName(document);
  const input = exportDocumentHTML(document.getText(), title, knownDiagram(document));
  const captured = await withRenderHost(
    input,
    title,
    quiet ? null : 'Rendering for export…',
    (host) => host.selfContainedHTML(),
  );
  return Buffer.from(finishSelfContainedHTML(captured, input), 'utf8');
}

// MARK: - EPUB  (ship order 4 — exact container, rasterised rich blocks)

/**
 * Export the document as an EPUB 3, its own headings as the table of contents.
 *
 * A document with no rich blocks never opens a webview at all: the body is
 * scraped from the rendered HTML string, which is also why **code in an EPUB is
 * never syntax-highlighted** — highlight.js runs against the live DOM, and this
 * body is taken before any script has run. That is by design in all three apps.
 */
export async function exportEpub(document: vscode.TextDocument): Promise<void> {
  const source = document.getText();
  // The EPUB title is the front matter's, falling back to the file name — and
  // it is also what the identifier hashes, so two exports of the same document
  // land on the same `dc:identifier` and replace rather than accumulate in a
  // reader's library.
  const title = documentTitle(frontMatter(source), baseName(document));

  const destination = await askWhereToSave(document, title, 'epub', { EPUB: ['epub'] });
  if (destination === null) return;
  await write(destination, await epubBytes(document));
}

/** The `.epub`, as bytes and without a dialogue. See `latexBytes`. */
export async function epubBytes(
  document: vscode.TextDocument,
  quiet = false,
): Promise<Uint8Array> {
  const source = document.getText();
  const title = documentTitle(frontMatter(source), baseName(document));
  const html = renderDocument(source, { title, dark: false, export: true, diagram: knownDiagram(document) });
  let body = bodyContent(html);
  const ranges = richElementRanges(body);
  const images: EpubImage[] = [];

  if (ranges.length > 0) {
    const snapshots = await withRenderHost(
      html,
      title,
      quiet ? null : 'Rendering diagrams for the EPUB…',
      (host) => host.snapshots(2),
    );
    // The string scan and the DOM query find the same containers in the same
    // order, so they pair up index-for-index. A count mismatch or a failed
    // capture leaves that element as its readable source text — never a hole.
    const replacements: (string | null)[] = ranges.map(() => null);
    for (let index = 0; index < ranges.length && index < snapshots.length; index++) {
      const snapshot = snapshots[index];
      if (snapshot.png === null) continue;
      const href = imageHref('content', images.length + 1);
      images.push({ href, data: snapshot.png });
      replacements[index] = imageTag(href, ranges[index].kind, snapshot.width);
    }
    body = applyImageReplacements(body, ranges, replacements);
  }

  const fields = frontMatter(source);
  return packDocumentEpub({
    title,
    body: xhtml(body),
    images,
    outline: epubOutline(source, knownDiagram(document)),
    modified: modifiedNow(),
    metadata: epubMetadata(fields),
    cover: await readCover(document, fieldValue(fields, 'cover')),
  });
}

/**
 * The front matter's `cover:` image, when it can be read and is a PNG, JPEG,
 * GIF or WebP; otherwise null and the book has no cover — silently, as in every
 * md app. A `data:` image is decoded, an `https:` one fetched (15 seconds, 20
 * MB at most), and a relative path read from beside the document with the
 * TextBundle export's containment.
 */
async function readCover(document: vscode.TextDocument, value: string | null): Promise<EpubCover | null> {
  const reference = coverReference(value);
  if (reference === null) return null;
  switch (reference.kind) {
    case 'data':
      return recogniseCover(reference.data);
    case 'local':
      return recogniseCover(await readAsset(document, reference.path));
    case 'https':
      try {
        const response = await fetch(reference.url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
        // A redirect must not leave https for plain http.
        if (!response.ok || !response.url.startsWith('https://')) return null;
        const length = Number(response.headers.get('content-length') ?? '0');
        if (length > MAX_COVER_BYTES) return null;
        return recogniseCover(new Uint8Array(await response.arrayBuffer()));
      } catch {
        return null;
      }
  }
}

// MARK: - PDF  (ship order 5 — documented non-parity)

/**
 * Print the rendered document at the configured trim size.
 *
 * There is no VS Code print API and no way to read bytes out of a webview's
 * print pipeline, so this cannot write a `.pdf` itself: it renders the page,
 * hands it to the host's print dialogue, and the author chooses "Save as PDF"
 * and a destination there. That is why this one command opens no save dialogue
 * — it writes nothing.
 *
 * When the host refuses to print at all (a browser-hosted VS Code, a remote
 * window), the fallback is the honest one: offer to save the same print-ready
 * page as HTML, which any browser will print to PDF with identical geometry.
 */
export async function exportPdf(document: vscode.TextDocument): Promise<void> {
  const title = baseName(document);
  const size = pageSizeNamed(readConfig(document.uri).pageSize);
  const html = pdfDocumentHTML(document.getText(), title, size, knownDiagram(document));

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `md: preparing ${title} for print…` },
      () => printThroughWebview(html, title),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const choice = await vscode.window.showErrorMessage(
      `md: this window could not open a print dialogue — ${message}`,
      { modal: true, detail: 'The same page can be saved as HTML and printed from a browser, which paginates it identically.' },
      'Save Print-Ready HTML…',
    );
    if (choice !== 'Save Print-Ready HTML…') return;
    const destination = await askWhereToSave(document, title, 'html', { HTML: ['html'] });
    if (destination === null) return;
    await write(destination, Buffer.from(html, 'utf8'));
  }
}

// MARK: - Diagram preview

/**
 * Open a `.puml` / `.gv` file in a live preview panel.
 *
 * The one command in this file that is not an export, and the only one whose
 * work does not belong here: an export renders once, takes something out and
 * disposes its surface, whereas this panel stays open, re-renders as the file is
 * typed and follows the workbench theme. That is a preview, so it lives in
 * `src/preview/diagramPreview.ts` — which shares this folder's render surface
 * rather than standing up a second one.
 *
 * The command id and this function's name are kept because `package.json` and
 * `extension.ts`'s command table both name them.
 */
export async function showDiagramPreview(document: vscode.TextDocument): Promise<void> {
  // Nothing to await: the panel opens immediately and reports its own progress
  // in its own status line. A command that sat silently for the twenty seconds a
  // class diagram can take would read as a broken command.
  openDiagramPreview(document);
}

// MARK: - Shared plumbing

/**
 * Run one capture against a freshly loaded render surface, with a progress
 * notification, and always dispose the panel afterwards.
 *
 * The surface holds a Chromium context with up to 11 MB of engines in it, so
 * the `finally` is not tidiness — a leaked panel per export is visible in
 * Activity Monitor.
 */
async function withRenderHost<T>(
  html: string,
  title: string,
  progress: string | null,
  capture: (host: RenderHost) => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> => {
      const host = await RenderHost.open(html, { title: `md — ${title}` });
      try {
        const captured = await capture(host);
        if (host.timedOut) {
          // The handshake timing out is a **success**, not a failure: the apps
          // give it two minutes and then proceed with whatever the DOM holds,
          // because PlantUML renders sequentially and one slow figure must not
          // cost the whole export. A diagram that never arrived has already
          // restored its own source text — so the artefact is written, and the
          // author is told which half of the story they got.
          void vscode.window.showWarningMessage(
            'md: the engines had not finished after two minutes; anything still rendering was exported as its source text.',
          );
        }
        return captured;
      } finally {
        host.dispose();
      }
  };

  // `null` is a batch: one progress notification is already up for the whole
  // selection, and a second one per file would stack twenty deep.
  if (progress === null) return run();
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `md: ${progress}` },
    run,
  );
}

/** The QuickPick over a document's diagrams, or null when the author dismisses it. */
async function pickDiagram(available: readonly Diagram[]): Promise<Diagram | null> {
  const items = available.map((diagram) => ({ label: menuTitle(diagram), diagram }));
  const chosen = await vscode.window.showQuickPick(items, {
    title: 'Export Diagram as SVG',
    placeHolder: 'Which diagram?',
  });
  return chosen === undefined ? null : chosen.diagram;
}

/**
 * Ask where to put the artefact. Null means the author cancelled, and a
 * cancelled dialogue must leave nothing behind — no temporary file, no message,
 * no half-done work.
 */
async function askWhereToSave(
  document: vscode.TextDocument,
  title: string,
  extension: string,
  filters: Record<string, string[]>,
): Promise<vscode.Uri | null> {
  const chosen = await vscode.window.showSaveDialog({
    defaultUri: defaultDestination(document, title, extension),
    filters,
    saveLabel: 'Export',
  });
  return chosen ?? null;
}

/**
 * Where the dialogue should open: beside the document when it has been saved,
 * otherwise in the first workspace folder, otherwise wherever the host prefers.
 */
function defaultDestination(
  document: vscode.TextDocument,
  title: string,
  extension: string,
): vscode.Uri | undefined {
  const name = `${sanitized(title)}.${extension}`;
  if (document.uri.scheme === 'file') {
    return vscode.Uri.joinPath(vscode.Uri.file(path.dirname(document.uri.fsPath)), name);
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, name);
}

/** Write the bytes and say so, with one click to go and look at the file. */
async function write(destination: vscode.Uri, bytes: Uint8Array): Promise<void> {
  await vscode.workspace.fs.writeFile(destination, bytes);
  const reveal = 'Reveal';
  const choice = await vscode.window.showInformationMessage(
    `md: exported ${path.basename(destination.fsPath)}`,
    reveal,
  );
  if (choice === reveal) {
    await vscode.commands.executeCommand('revealFileInOS', destination);
  }
}

/** The document's file name without its extension — the title every export uses. */
function baseName(document: vscode.TextDocument): string {
  return stemOfPath(document.uri.path);
}

// `sanitized` lives in `./batch` with the rest of the naming rules and is
// re-exported here, where every caller already looks for it.
export { sanitized };
