//
//  engines.ts
//  md.vscode — the one sentence the host is able to say to the preview about
//  the reader's settings, and the only place that sentence is spelled.
//
//  THE PROBLEM THIS SOLVES
//  -----------------------
//  `md.diagrams.mermaid` and `md.diagrams.plantuml` are read in the extension
//  host, by `readConfig`. The two engines they switch off do not run there:
//  Mermaid and PlantUML run in the built-in preview's page, which belongs to
//  another extension. There is no `WebviewPanel`, no `postMessage` and no
//  handle on that document — the only channel from the host to it is the HTML
//  `extendMarkdownIt` returns. So the wanted engines travel as an attribute on
//  the wrapper element, `data-md-render="mermaid plantuml"`, and the client
//  reads them back from there.
//
//  The emitter wrote that attribute from the first version. The reader was
//  missing, and for two releases the client rendered every diagram it could
//  find — so both settings were dead in the preview while the README promised
//  they were not. Writing and reading now happen through this one module, so
//  the next person to change the spelling changes both ends at once, and the
//  tests hold the attribute name as a value rather than a string in two files.
//
//  WHY IT IS A MODULE OF ITS OWN, AND PURE
//  ---------------------------------------
//  It is imported by `markdownItHook.ts`, which runs in Node inside the
//  extension host, and by `md-preview.ts`, which is bundled into an IIFE and
//  runs in the page. That leaves it exactly one licence: no `vscode`, no Node
//  built-ins, no DOM globals. The element is taken as a parameter whose type
//  is the two methods actually called, so a test can pass an object literal
//  and never stand up a DOM — the rule `src/render/**` lives by, applied to
//  the one part of `src/preview/**` that can keep it.
//

/**
 * The engines the *client* runs. Not a list of md's engines: KaTeX,
 * highlight.js and Graphviz are rendered in the host and arrive as finished
 * markup, and a chart is drawn by the renderer itself, so none of the four has
 * anything to switch off on this side.
 */
export type ClientEngine = 'mermaid' | 'plantuml';

/** Both of them, in the order the preview runs them: cheapest first. */
export const CLIENT_ENGINES: readonly ClientEngine[] = ['mermaid', 'plantuml'];

/**
 * The attribute that carries them.
 *
 * Space-separated, because that is how HTML spells a list and because it reads
 * in the Developer Tools without decoding. An **empty** value is meaningful and
 * is emitted: it says "this document has no diagram this page should draw", and
 * is what stops the client fetching 3.5 MB of Mermaid or 7.4 MB of PlantUML for
 * nothing.
 */
export const RENDER_ATTRIBUTE = 'data-md-render';

/**
 * What the reader is able to hand this module: an element, or anything shaped
 * like enough of one.
 *
 * Both methods are optional so that the pass's root — typed `ParentNode`, which
 * has `querySelector` but no `getAttribute` — and a bare `{ getAttribute }`
 * fake are equally acceptable. A real `Element` satisfies it as it stands.
 */
export interface EngineAttributeSource {
  getAttribute?(name: string): string | null;
  querySelector?(selectors: string): EngineAttributeSource | null;
}

/**
 * Parse an attribute value into the set of engines it names.
 *
 * Unknown words are dropped rather than rejected: the value is markup we
 * produced ourselves, but it travels through a page we do not own and is
 * re-parsed after every morph, and a future engine name arriving from a newer
 * host must not take the two we know down with it.
 *
 * `null` and `undefined` — the attribute is absent — mean the empty set, not
 * "everything". Absent means this is not our wrapper: either the hook did not
 * render this markup (VS Code renders fragments for its own features and for
 * `markdown.api.render`, and our renderer hands those straight back to
 * markdown-it) or it failed and fell back. Neither case contains a `pre.mermaid`
 * or `div.plantuml` of ours, so the empty set is the honest answer and the safe
 * one: the alternative is to render a diagram into somebody else's document.
 */
export function parseEngineList(value: string | null | undefined): ReadonlySet<ClientEngine> {
  const wanted = new Set<ClientEngine>();
  if (typeof value !== 'string') return wanted;
  // Split on any run of whitespace, and tolerate leading and trailing space so
  // that a value which has been through a serializer still reads.
  for (const word of value.split(/\s+/)) {
    if (isClientEngine(word)) wanted.add(word);
  }
  return wanted;
}

/** The inverse, for the emitter. Order is `CLIENT_ENGINES`, never insertion order. */
export function formatEngineList(engines: Iterable<ClientEngine>): string {
  const wanted = new Set(engines);
  return CLIENT_ENGINES.filter((engine) => wanted.has(engine)).join(' ');
}

/**
 * The engines this page is allowed to run, read from `root` or from the first
 * element under it that carries the attribute.
 *
 * The pass hands us `.markdown-body` (or `<body>`), and our wrapper is a child
 * of it, so the descendant search is the normal path; the `getAttribute` branch
 * is what lets a caller — or a test — pass the wrapper itself.
 *
 * `querySelector` is given the attribute name from the constant rather than a
 * literal selector so that a rename cannot leave the reader looking for the old
 * spelling while the emitter writes the new one.
 */
export function wantedEngines(root: EngineAttributeSource | null | undefined): ReadonlySet<ClientEngine> {
  if (!root) return new Set<ClientEngine>();

  const own = root.getAttribute?.(RENDER_ATTRIBUTE);
  if (typeof own === 'string') return parseEngineList(own);

  const carrier = root.querySelector?.(`[${RENDER_ATTRIBUTE}]`);
  return parseEngineList(carrier?.getAttribute?.(RENDER_ATTRIBUTE));
}

function isClientEngine(word: string): word is ClientEngine {
  return (CLIENT_ENGINES as readonly string[]).includes(word);
}
