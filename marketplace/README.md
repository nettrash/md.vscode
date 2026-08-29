# Marketplace listing copy

The text that goes into the Visual Studio Marketplace listing for **md**,
kept next to the code it describes. (The iPhone / iPad and Mac listings
live in the `md` and `md.macOS` repos, and the Play listing in
`md.Android` — the four are written separately, because the apps differ
and a listing must describe the one it is attached to.)

This directory holds no per-field text files, and that is the difference
worth knowing about the Marketplace. App Store Connect and the Play
Console are web forms, so `md/appstore/` and `md.Android/play/` keep one
plain-text file per field to paste in. **The Marketplace has no form.**
Every word of the listing is read out of the `.vsix`: the fields come
from `package.json`, the details tab is the packaged `README.md`
rendered, the changelog tab is `CHANGELOG.md`, the licence tab is
`LICENSE`. So there is nothing to paste and nothing to keep in sync — the
copy is versioned with the code by necessity here, not merely by
preference — and this file is the map of where each field actually comes
from, plus the rules the wording follows.

## Two READMEs, and why

**The details tab is no longer this repository's root `README.md`. It is
[`extension-README.md`](extension-README.md), in this directory, which
the packaging step copies over the root `README.md` while the `.vsix` is
built and restores afterwards.** The two documents are written for two
different readers and neither can serve both:

- The **root `README.md`** is for someone reading the source. It explains
  the port, the parity contract, which engine runs where and why, and how
  to build. It stays on GitHub, where that reader is.
- **`marketplace/extension-README.md`** is for someone deciding whether
  to press Install. It leads with what they get, shows screenshots, and
  puts the commands and every setting in two tables they can scan.

The swap is a copy rather than a flag because **`vsce` has no
`--readme-path` option** — measured on vsce 3.9.2, not assumed. The
details tab is `README.md` at the root of the package, full stop, and the
same is true of the other two tabs: changelog is `CHANGELOG.md`, licence
is `LICENSE`. The options that do exist nearby are `--baseContentUrl`,
`--baseImagesUrl`, `--githubBranch` and `--no-rewrite-relative-links`,
all of which shape how links inside that one file are rewritten and none
of which can point it somewhere else.

Two consequences follow, and both are easy to get wrong:

- **Relative paths in `extension-README.md` are written as if the file
  sat at the repository root**, because that is where it is read from at
  package time. `media/marketplace/preview-dark.png` and `LICENSE` are
  correct as written. A path relative to `marketplace/` would resolve to
  nothing.
- **The screenshots must be committed and pushed before publishing.**
  vsce rewrites those relative image paths to raw GitHub URLs on the
  repository's branch, so a page whose images exist only in the working
  tree publishes with three holes in it.

## Retaking the screenshots

The three images in `media/marketplace/` were originally made ad hoc, so
nothing recorded what was in them and they could not be reproduced. The
document they should show now lives beside this file, as
[`screenshot-source.md`](screenshot-source.md): it exercises mathematics,
chemistry, a plot, Mermaid, Graphviz, highlighted code and a table in one
page, and every one of those is asserted to render before it is committed.
`marketplace/**` is excluded by `.vscodeignore`, so it never ships inside
the `.vsix`.

To retake them: open `screenshot-source.md`, *Open Preview to the Side*,
and capture the editor and preview together — once in a dark colour theme
as `preview-dark.png`, once in a light one as `preview-light.png`. For
`diagram-panel.png`, open any `.puml` file and run *md: Show Diagram
Preview*. Keep the window near the width of the existing images so the
three sit together on the page.

**The captions in `extension-README.md` name what is in frame, so they
have to be retaken and rewritten together.** As of 1.2 the images predate
the plot fence: the listing describes charts and the screenshots do not
show one. The captions are accurate for the images that exist today and
must be corrected in the same commit that replaces them — a caption
promising a chart over a picture without one is the failure mode this
paragraph exists to prevent.

| Source | Marketplace field | Limit | Current (1.0.0) |
| --- | --- | --- | --- |
| `package.json` `publisher` + `name` | Unique identifier | lowercase, no spaces | `nettrash.md-vscode` |
| `package.json` `displayName` | Extension name | not published | `md` (2) |
| `package.json` `description` | One-line description under the name | not published | 142 |
| `package.json` `version` | Version | must be `major.minor.patch` | `1.0.0` |
| `package.json` `categories` | Categories | fixed vocabulary | 3 |
| `package.json` `keywords` | Tags, used by search | not published | 5 |
| `package.json` `galleryBanner` | Banner behind the name | — | `#2B221C`, dark |
| `media/icon.png` | Icon | 128 × 128 recommended | 512 × 512, 134 KB |
| `marketplace/extension-README.md`, packaged as `README.md` | Details tab | none in practice | the whole file |
| `media/marketplace/*.png` | The screenshots inside that tab | — | 3, rewritten to raw GitHub URLs |
| `CHANGELOG.md` | Changelog tab | none in practice | the whole file |
| `LICENSE` | License tab | — | MIT |
| `package.json` `repository` `bugs` `homepage` | Resources links | — | set |

Nothing on that page can be edited after the fact. There is no
Promotional Text to change between builds the way the App Store has:
correcting one word of the description means publishing a version. Budget
for that before submitting, not after.

## Limits still to confirm

The character limits above are marked *not published* where they are not
published, rather than guessed at. Microsoft documents the manifest
fields but not their maximum lengths, and none of the sibling repos
records them because none of them ships to this store. Before the first
publish, check `displayName`, `description` and the tag count against the
current publishing documentation and fill this table in — the numbers are
review-time proof that the copy fits, and a guessed one proves nothing.

What *is* certain and already checked: the version is strict three-part
semver, the three categories come from the Marketplace's fixed list
(Programming Languages, Visualization, Formatters), and `vsce package`
refuses the manifest outright if either is wrong.

## What the page will and will not render

The details tab is `extension-README.md` rendered as Markdown, not as a
web page. Four consequences shape how it is written:

- **Raw HTML is sanitised**, so nothing may depend on it. The page uses
  none — which is also the family rule for the app READMEs, and for the
  same reason the App Store copy carries no angle brackets: a store page
  reads markup as markup and answers with either a rejection or a hole.
  Never paste HTML samples into listing copy. The same restraint is why
  the private-note feature is described there without quoting the comment
  syntax it uses.
- **Relative links are rewritten** against `package.json` `repository`
  when the package is built, which is why `[LICENSE](LICENSE)` resolves
  on the Marketplace page at all, and why the screenshots are referenced
  as `media/marketplace/…` rather than by absolute URL. A link that must
  not be rewritten has to be absolute.
- **Badges render only from approved domains.** The build badge points at
  `github.com`, the version and install badges at `vsmarketplacebadges.dev`
  and the licence badge at `img.shields.io`, all three of which are on
  Microsoft's approved list. A badge served from anywhere else is
  stripped rather than shown. And a badge must point at a workflow that
  exists — the Android repo ships no CI and therefore no badge, on
  purpose.
- **The Marketplace badges are not shields.io's**, and this is the one
  thing here that has already had to be corrected once.
  `img.shields.io/visual-studio-marketplace/…` — the `v`, `i` and `r`
  routes this file used to name — were **retired by shields.io**, and a
  retired route still answers `200` with a grey *"retired badge"* pill
  rather than an error, so nothing breaks loudly and a stale badge can
  sit in a listing looking merely unpopular. The version and install
  badges now come from `vsmarketplacebadges.dev` (also on Microsoft's
  approved list), which reads the live Marketplace API and was checked
  returning `v1.1.0` and the real install count.
- **There is no rating badge, deliberately.** `nettrash.md-vscode` has no
  ratings at all — the Marketplace API returns no rating statistic for
  it — so every provider's rating badge renders `0/5 (0 ratings)`, which
  reads as a bad score rather than as an absent one. A rating badge is
  worth adding back the day the extension has ratings, and not before.

## Ground rules these texts follow

Every claim was checked against the shipping build. A listing that
describes the roadmap rather than the version attached to it is the way
this goes wrong, whichever store it is.

- No competitor comparisons, no pricing, promotions or "free", no
  unverifiable superlatives, no rating requests. The root README's "the
  simplest Markdown preview" is the family's one superlative and it stays
  there, where it is not store copy.
- The App Store's "do not name another platform" rule is **Apple's, and
  does not travel here**. The details tab names the iPhone, iPad, Mac and
  Android siblings and links to them, because they are one product and a
  reader deciding whether to install is better off knowing it. What must
  still be said is *where* they are the same — see the parity bullet
  below.
- Third-party names (Markdown, LaTeX, KaTeX, mhchem, Mermaid, Graphviz,
  Viz.js, PlantUML, highlight.js, EPUB) are used descriptively, and
  Microsoft's (Visual Studio Code, Marketplace) without implying
  endorsement.
- Privacy claims match the code and `PRIVACY.md`: the extension collects
  nothing and sends nothing, the only network use is fetching an image a
  document itself points at, and the editor's own telemetry is the
  editor's and is never claimed as absent.

## Tags

Five, in `package.json` `keywords`: `markdown`, `katex`, `mermaid`,
`plantuml`, `graphviz`. Each names something the extension actually
contains — that is the line between a descriptive tag and squatting on
another project's name, and it is the same line the App Store enforces as
a 2.3.7 rejection. Terms already in the extension name or description
earn nothing here. Singular forms only; the store matches the rest.

## Wording that must not drift back

These are corrections made because a shipped build contradicted the
obvious phrasing. They cost something to learn, on one platform or
another, and they are cheap to lose.

- **Not "no third-party dependencies", not "no third-party libraries".**
  The extension vendors KaTeX with mhchem, Mermaid, Viz.js carrying
  Graphviz, PlantUML and highlight.js, and that is six third-party
  projects however few npm packages the TypeScript side resolves. The
  details tab therefore makes no claim about dependencies at all: it says
  the engines are carried inside the extension and names all six with
  their licences, in a table at the foot of the page. Any sentence about
  npm in listing copy has to be checked against `package.json` on the day
  it is written, not remembered — the manifest's `dependencies` block has
  changed under this file once already.
- **Engine licences are quoted from the files, not from memory.**
  `media/rich/highlight.min.js` carries a banner reading BSD-3-Clause and
  `media/rich/viz-global.js` one naming Graphviz and Expat as bundled in
  object-code form. The others carry no banner, so their licences come
  from upstream and from the CHANGELOG that recorded them at vendoring
  time: KaTeX and mhchem MIT, Mermaid MIT, Graphviz EPL-1.0, Viz.js MIT,
  PlantUML GPL. Mermaid's bundle additionally names DOMPurify
  (Apache-2.0 and MPL-2.0), js-yaml, Lodash and parts of Cytoscape (MIT),
  which is why the details tab lists them in a sentence of their own.
  Re-check the banners when an engine is next updated.
- **Not "no permissions" and not "no network".** The extension asks for
  nothing and contacts nothing of ours, but a document that names an
  image by URL still causes the preview to fetch it, and Visual Studio
  Code has telemetry of its own. Both are said plainly in `PRIVACY.md`
  and neither may be quietly dropped from the copy.
- **Not "renders everything Markdown".** The renderer is a deliberate
  subset — raw HTML is escaped, there are no reference-style links, a
  four-space indent is not a code block — because three shipping apps
  decided so. Copy that implies CommonMark compliance will be measured
  against CommonMark.
- **Not "the same as the apps" without saying where.** Byte-for-byte
  parity is a property of the *exports*. The preview is VS Code's own,
  so it is visually the same page, not the same bytes. Say which.
- **PDF is not byte-identical with the apps** and the copy must not
  suggest it is: WebKit paginates the phone's pages and this port cannot,
  and American Typewriter does not exist away from Apple.
- **Not "syntax highlighting everywhere".** An exported EPUB keeps its
  code plain, on all four platforms, because the e-book is built from the
  document before any colouring is applied.
- **Private notes are hidden only when the comment is on its own line.**
  Written inline, it renders. Never promise otherwise.
- **Do not promise that lowering the preview's security level is ever
  needed, or that raising it adds anything.** The whole engine layout —
  Graphviz in the extension host, Mermaid and PlantUML in the page —
  exists so that the default level is enough.

## Answers to keep ready

The Marketplace has no App Review, so there is no `review-notes.txt`
here. If publisher verification, a security question or a support thread
ever asks, the seven answers in `md/appstore/review-notes.txt` carry over
almost unchanged, and the fifth is the one that matters most in this
store: mathematics, chemistry, diagrams and code colouring are drawn by
open-source engines **bundled inside the extension and loaded from its
own folder**, which VS Code admits as a resource root, under a policy
that permits scripts only by a per-render nonce. No executable code is
downloaded or updated at run time, and no interpreted code comes from any
server.
