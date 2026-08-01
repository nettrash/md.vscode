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
from `package.json`, the details tab is `README.md` rendered, the
changelog tab is `CHANGELOG.md`, the licence tab is `LICENSE`. So there
is nothing to paste and nothing to keep in sync — the copy is versioned
with the code by necessity here, not merely by preference — and this file
is the map of where each field actually comes from, plus the rules the
wording follows.

| Source | Marketplace field | Limit | Current (1.0.0) |
| --- | --- | --- | --- |
| `package.json` `publisher` + `name` | Unique identifier | lowercase, no spaces | `nettrash.md-vscode` |
| `package.json` `displayName` | Extension name | not published | `md` (2) |
| `package.json` `description` | One-line description under the name | not published | 142 |
| `package.json` `version` | Version | must be `major.minor.patch` | `1.0.0` |
| `package.json` `categories` | Categories | fixed vocabulary | 3 |
| `package.json` `keywords` | Tags, used by search | not published | 5 |
| `package.json` `galleryBanner` | Banner behind the name | — | `#F4EFE4`, light |
| `media/icon.png` | Icon | 128 × 128 recommended | 512 × 512, 134 KB |
| `README.md` | Details tab | none in practice | the whole file |
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

The details tab is `README.md` rendered as Markdown, not as a web page.
Three consequences shape how the README is written:

- **Raw HTML is sanitised**, so nothing may depend on it. The README uses
  none — which is also the family rule for the app READMEs, and for the
  same reason the App Store copy carries no angle brackets: a store page
  reads markup as markup and answers with either a rejection or a hole.
  Never paste HTML samples into listing copy.
- **Relative links are rewritten** against `package.json` `repository`
  when the package is built, which is why `[LICENSE](LICENSE)` resolves
  on the Marketplace page at all. A link that must not be rewritten has
  to be absolute.
- **Badges render only from approved domains.** The build badge points at
  `github.com`, which is one of them; a badge served from anywhere else
  is stripped rather than shown. And a badge must point at a workflow
  that exists — the Android repo ships no CI and therefore no badge, on
  purpose.

## Ground rules these texts follow

Every claim was checked against the shipping build. A listing that
describes the roadmap rather than the version attached to it is the way
this goes wrong, whichever store it is.

- No references to the other platforms, no competitor comparisons, no
  pricing, promotions or "free", no unverifiable superlatives, no rating
  requests. The README's "the simplest Markdown preview" is the family's
  one superlative and it stays in the README, where it is not store copy.
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
  Graphviz, PlantUML and highlight.js. Only the *TypeScript* side is
  package-free: `package.json` has no `dependencies` block at all. The
  safe phrasing is the README's — "no runtime npm packages" plus "the
  only vendored code is the offline math / diagram engines under
  `media/rich/`", naming all six.
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
