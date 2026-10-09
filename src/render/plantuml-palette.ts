//
//  plantuml-palette.ts
//  md.vscode — whether a PlantUML diagram must be drawn in the light palette
//  even when the workbench is dark.
//
//  In a dark theme md asks PlantUML for its dark palette, and the engine then
//  draws every piece of text white (`#FFFFFF`) — measured on the bundled
//  1.2026.4beta4, 2026-10-09. But a fill the author wrote into the diagram is
//  kept exactly as written: `box "Production" #F4F8FF`, `participant X
//  #LightBlue`, `note over A #FFFFCC`. White text on those pastels is
//  invisible, so a diagram designed with its own light backgrounds came up as
//  empty boxes in a dark editor — everything inside them gone.
//
//  The answer is not to recolour the author's diagram. It is to draw it the way
//  it was designed — PlantUML's light palette, black text — and to give it a
//  light card to sit on, because the engine paints no background of its own and
//  black text outside the boxes would otherwise vanish into the dark page. That
//  is what the callers do when this function says yes.
//
//  It says yes only for a *light* fill. A diagram whose own colours are dark
//  (`#333333`, `#Navy`) reads correctly in the dark palette and keeps it, and an
//  arrow colour (`-[#red]>`) is ink, not a fill, so it does not count either. A
//  diagram with no colours of its own keeps the workbench's palette, as before.
//

/** Colour names PlantUML accepts that are dark enough for white text. Every
 *  other name a diagram uses — LightBlue, Pink, PaleGreen, Wheat… — is light. */
const DARK_NAMES = new Set([
  'black', 'navy', 'darkblue', 'mediumblue', 'blue', 'darkgreen', 'green', 'teal', 'darkcyan',
  'midnightblue', 'indigo', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkolivegreen',
  'maroon', 'purple', 'darkred', 'darkmagenta', 'saddlebrown', 'sienna', 'brown', 'firebrick',
  'dimgray', 'dimgrey', 'gray', 'grey', 'slategray', 'slategrey', 'darkviolet', 'rebeccapurple',
  'crimson', 'olive', 'forestgreen', 'seagreen', 'royalblue', 'steelblue', 'darkorchid',
  'mediumvioletred', 'red', 'darkgoldenrod', 'chocolate', 'transparent',
]);

/** Relative luminance of `#RGB`, `#RRGGBB` or `#RRGGBBAA`, or null for anything else. */
function hexLuminance(hex: string): number | null {
  let h = hex;
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  else if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6 || !/^[0-9a-f]{6}$/i.test(h)) return null;
  const channel = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** True for a colour token (without its `#`) that white text cannot be read on. */
function isLightColour(token: string): boolean {
  // A gradient — `#red/blue`, `#red-blue`, `#red|blue`, `#red\blue` — is light
  // if either end is.
  const ends = token.split(/[/|\\-]/).filter((t) => t.length > 0);
  if (ends.length > 1) return ends.some(isLightColour);
  const luminance = hexLuminance(token);
  if (luminance !== null) return luminance > 0.4;
  // A name is letters only, three or more of them; `#N` in "Issue #N" is a
  // number sign in text, not a colour.
  if (!/^[a-z]{3,}$/i.test(token)) return false;
  return !DARK_NAMES.has(token.toLowerCase());
}

/**
 * True when `source` paints its own light fills, so that PlantUML's dark
 * palette — white text — would be unreadable on them.
 *
 * Read line by line, with what can only be text taken out first: comments,
 * quoted strings (`"Issue #12"`), everything after a message's `:`, and the
 * bracketed arrow colours. What remains is where PlantUML reads a fill.
 */
export function paintsOwnLightFills(source: string): boolean {
  const withoutBlockComments = source.replace(/\/'[\s\S]*?'\//g, '');
  for (const raw of withoutBlockComments.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("'")) continue;

    // A skinparam or a `<style>` property that sets a background.
    const setting = /^(?:skinparam\s+)?([\w.]*backgroundcolou?r)\s*[:\s]\s*(#?[\w/|\\-]+)/i.exec(line);
    if (setting) {
      const value = setting[2].replace(/^#/, '');
      if (value.toLowerCase() !== 'none' && isLightColour(value)) return true;
      continue;
    }

    const code = line
      .replace(/"[^"]*"/g, '""')
      .replace(/-\[[^\]]*\]-?>?/g, '->')
      .replace(/<-\[[^\]]*\]-/g, '<-')
      .replace(/:.*$/, '');
    for (const match of code.matchAll(/(?:^|\s|\|)#([A-Za-z0-9]+(?:[/|\\-][A-Za-z0-9]+)?)/g)) {
      if (isLightColour(match[1])) return true;
    }
  }
  return false;
}
