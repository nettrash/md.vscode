# Privacy Policy

**Effective date:** 1 August 2026
**Applies to:** md for VS Code — the Visual Studio Code Markdown
extension published by nettrash. This policy is versioned alongside the
extension's source code; the most recent commit on `master` is
authoritative.

## TL;DR

md **does not collect, transmit, sell, or share any data.** It contains
no analytics, no advertising SDKs, no third-party trackers, and no
servers operated by us. The documents you open and edit stay where you
put them — in the folder you opened, on the machine you opened it on.

If that already answers your question, you don't need to read the rest.

## What we collect

**Nothing.** md has no account to create, no email to register, and no
telemetry. It registers no telemetry channel with the editor, calls no
reporting API, and contacts no servers of ours — there are none. The one
time the extension touches the network at all is when a document you
opened points at an image by remote URL, and the preview fetches that
image so it can be shown (see **Permissions** below).

Visual Studio Code itself is another matter, and it would be dishonest to
let the sentence above stand for the whole editor. VS Code collects its
own telemetry about how the editor is used, governed by your own
`telemetry.telemetryLevel` setting and by Microsoft's privacy statement,
not by this one. This extension **adds nothing to that stream and reads
nothing from it.** Separately, because the extension is distributed
through the Marketplace, Microsoft reports install and rating counts to
us as aggregate numbers on a publisher dashboard; nothing in them
identifies anybody, and the extension sends nothing in order to produce
them.

## Your documents

md is a renderer, not a filing system. The files you open, edit and save
are handled entirely by VS Code — its editors, its workspace, its save
dialogs — and are stored wherever you choose. We never see them. The
extension reads the document you are previewing and writes only the file
you name when you ask for an export. It is disabled in a folder you have
not trusted, because it declares no support for untrusted workspaces and
that restricted default is the right one to leave alone.

The extension's own settings are ordinary VS Code settings, written by
the editor into your user or workspace `settings.json` and readable by
you at any time. They are, in full: which palette the preview draws in
(`md.preview.theme`), the two font stacks (`md.preview.bodyFont`,
`md.preview.codeFont`), whether each engine is enabled
(`md.math.enabled`, `md.diagrams.mermaid`, `md.diagrams.graphviz`,
`md.diagrams.plantuml`, `md.highlight.enabled`) and the page size used
for PDF export (`md.export.pageSize`). Beyond those the extension stores
nothing at all: no database, no cache, no recent-documents list, and
nothing in VS Code's global or workspace state. None of it leaves your
machine, and none of it contains personal information. If a future
version remembers anything else, it is added to this list in the same
commit that adds the setting.

## Permissions

VS Code has no permission prompts to grant — no camera, microphone,
contacts, location or photo library exist to ask for, and there is no
tracking prompt. What stands in their place is Workspace Trust, described
above, and the sandbox the preview itself runs in.

That sandbox is worth writing down, because it is the reason the
extension is built the way it is. VS Code's Markdown preview runs under a
content-security policy that, at its default security level, allows
scripts only by a per-render nonce and nothing else. Two things follow.
First, WebAssembly is forbidden there — so Graphviz, which is
WebAssembly, is laid out in the extension host rather than in the page,
and **nothing in this extension ever asks you to lower
`markdown.preview.security`.** The sandbox you already have is the
sandbox it was built to work inside. Second, the engines the preview does
load — KaTeX with mhchem, Mermaid, PlantUML, highlight.js — are read from
the extension's own folder, which the editor adds to the preview's
readable resource roots. They are files that arrived with the extension
and sit on your disk, not code fetched at run time; nothing is downloaded
or updated behind the page.

The extension does use the network for one thing, described above: if a
document you open references an image by remote URL (`![alt](https://…)`),
the preview fetches that image so it can be shown. That request goes
straight to the host **your own document names**, which sees your IP
address exactly as it would if you opened the link in a browser. It
happens only for documents that contain such a link.

Everything else runs on your machine: the Markdown renderer, the maths
and chemistry typesetting, the syntax highlighting and the diagram
engines (KaTeX, Mermaid, Graphviz, PlantUML) are bundled inside the
extension and work offline.

## Children's privacy

Because md collects no data at all, it collects no data from children.

## Changes to this policy

Any change is committed to this file in the extension's public source
repository, so the history is auditable.

## Contact

Questions: <nettrash@nettrash.me>.
