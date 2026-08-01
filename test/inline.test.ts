//
//  inline.test.ts
//  md.vscode — the span pass.
//
//  Ported from the `testHTMLInline…` / `testHTMLCurrency…` /
//  `testUnicodeSpacingAndWordBoundariesAgreeAcrossPlatforms` family in
//  `md/mdTests/mdTests.swift`, catalogued in `specs/06-tests.md` §14 and §17.
//
//  THE PHASE ORDER IS THE SPECIFICATION, and most of what follows exists to
//  pin it. Any reordering silently changes the output of real documents:
//
//      1. protect   code spans → $$…$$ → \[…\] → $…$ → \(…\)
//      2. escape    & < > "
//      3. spans     img(title) → img → link(title) → link → footnote ref
//                   → ** → __ → ~~ → * → _
//      4. breaks    soft newlines → "<br>\n"   (paragraphs only)
//      5. restore   ascending
//
//  Two families of assertion carry most of the weight. The first is the
//  currency guard, which is why "it costs $5 and $10 today" is prose: it is the
//  single most load-bearing regex in the port, and the reason md refuses
//  KaTeX's own auto-render pass (`rich/auto-render.min.js` is bundled by all
//  three apps and referenced by nothing). The second is the word class it is
//  written in terms of: `NSRegularExpression` is ICU, where `\w` is
//  `[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}‌‍]`, while **JavaScript's `\w`
//  is `[A-Za-z0-9_]`** — using it would read `ф$x$ф` as a formula and `ф_em_ф`
//  as emphasis, which is the exact regression the Kotlin port hit.
//

import { describe, expect, it } from 'vitest';

import { escapeHTML, inline } from '../src/render/inline';

const ACUTE = String.fromCodePoint(0x0301); // COMBINING ACUTE ACCENT
const ZWJ = String.fromCodePoint(0x200d); // ZERO WIDTH JOINER
const ZWNJ = String.fromCodePoint(0x200c); // ZERO WIDTH NON-JOINER
const BOM = String.fromCodePoint(0xfeff); // ZERO WIDTH NO-BREAK SPACE
const NBSP = String.fromCodePoint(0x00a0); // NO-BREAK SPACE
const SUPER_TWO = String.fromCodePoint(0x00b2); // SUPERSCRIPT TWO (No)
const ROMAN_TEN = String.fromCodePoint(0x2169); // ROMAN NUMERAL TEN (Nl)
const ARABIC_THREE = String.fromCodePoint(0x0663); // ARABIC-INDIC DIGIT THREE (Nd)
const TOKEN_OPEN = String.fromCodePoint(0xe000); // the protect placeholder's fences
const TOKEN_CLOSE = String.fromCodePoint(0xe001);

describe('escapeHTML', () => {
  it('escapes exactly four characters, ampersand first', () => {
    // `&` must be first or the three after it get double-escaped.
    expect(escapeHTML('&<>"')).toBe('&amp;&lt;&gt;&quot;');
    expect(escapeHTML('a & b')).toBe('a &amp; b');
  });

  it('leaves the apostrophe alone', () => {
    expect(escapeHTML("it's")).toBe("it's");
  });

  it('escapes the double quote so a URL cannot break out of an href', () => {
    // The whole XSS story in this family of apps is this one line. There is no
    // raw-HTML passthrough and no autolink support anywhere in the renderer.
    // The URL class is `[^)\s]+`, so it stops at the first `)` and the second
    // one is left as text — which is why the output ends in a stray paren the
    // note in `inline.ts` elides.
    expect(inline('[a]("onerror=alert(1))')).toBe(
      '<a href="&quot;onerror=alert(1">a</a>)',
    );
    expect(inline('<b>hi</b>')).toBe('&lt;b&gt;hi&lt;/b&gt;');
  });
});

describe('code spans', () => {
  // Swift: testHTMLCodeSpanIsEscapedAndNotReinterpreted
  it('escapes their content and reinterprets nothing inside', () => {
    const html = inline('`a < *b* > c`');
    expect(html).toBe('<code>a &lt; *b* &gt; c</code>');
    expect(html).not.toContain('<em>b</em>');
  });

  // Swift: testHTMLCodeSpanDollarIsNotMath
  it('wins over math', () => {
    // Code is protected first, so `$x$` inside backticks stays literal code.
    expect(inline('use `$x$` here')).toBe('use <code>$x$</code> here');
  });

  it('wins over a footnote reference', () => {
    // Swift: testFootnoteInsideCodeIsNotAReference
    const html = inline('Use `arr[^1]` here.');
    expect(html).toContain('<code>arr[^1]</code>');
    expect(html).not.toContain('<code>arr<sup');
  });

  it('restores a protected span literally, dollars and all', () => {
    // `String.replaceAll` with a *string* replacement interprets `$$`, `$&`,
    // `` $` `` and `$'`, so restoring a protected `` `$$` `` that way would
    // silently emit `<code>$</code>`. The restore passes a function instead.
    expect(inline('`$$`')).toBe('<code>$$</code>');
    expect(inline('`a$&b`')).toBe('<code>a$&amp;b</code>');
  });
});

describe('inline math and the currency guard', () => {
  // Swift: testHTMLCurrencyDollarsAreNotMath
  it('leaves two prices as prose', () => {
    // The closing `$` of the candidate span is followed by `1`, a `\p{Nd}`, so
    // the right-hand guard rejects it. This single guard is what makes
    // "$5 and $10" prose — and it is why KaTeX's whole-body delimiter scan is
    // never used.
    const html = inline('it costs $5 and $10 today');
    expect(html).toBe('it costs $5 and $10 today');
    expect(html).not.toContain('md-mathi');
  });

  it('refuses a dollar glued to a word character on either side', () => {
    for (const prose of ['a$x$b', '5$x$', '$x$b', `${ACUTE}$x$`]) {
      expect(inline(prose), prose).not.toContain('md-mathi');
    }
  });

  it('refuses a newline inside inline math', () => {
    expect(inline('$x\ny$')).not.toContain('md-mathi');
  });

  it('typesets a real formula', () => {
    expect(inline('total $a+b$ units')).toBe(
      'total <span class="md-mathi">a+b</span> units',
    );
  });

  // Swift: testHTMLInlineMathIsNotMangledByEmphasis
  it('protects the formula from the emphasis pass', () => {
    const html = inline('total $a*b*c$ units');
    expect(html).toContain('<span class="md-mathi">a*b*c</span>');
    expect(html).not.toContain('<em>');
  });

  it('accepts the \\(…\\) form as inline', () => {
    expect(inline('A \\(a_i\\) here.')).toBe('A <span class="md-mathi">a_i</span> here.');
  });

  it('accepts $$…$$ and \\[…\\] as display', () => {
    expect(inline('$$x^2 + y^2$$')).toBe('<span class="md-mathd">x^2 + y^2</span>');
    expect(inline('\\[x^2\\]')).toBe('<span class="md-mathd">x^2</span>');
  });

  it('escapes the LaTeX for HTML, since KaTeX reads the decoded textContent', () => {
    expect(inline('$a < b$')).toBe('<span class="md-mathi">a &lt; b</span>');
  });
});

describe('the ICU word class, spelled out', () => {
  // Swift: testUnicodeSpacingAndWordBoundariesAgreeAcrossPlatforms
  it('counts a Cyrillic letter as a word character', () => {
    // JS's `\w` is ASCII; using it here would turn `ф$x$ф` into a formula and
    // `ф_em_ф` into emphasis, on this platform alone.
    expect(inline('ф$x$ф')).not.toContain('md-mathi');
    expect(inline('ф_em_ф')).not.toContain('<em>');
  });

  it('counts a non-ASCII digit and a number-letter as word characters', () => {
    expect(inline(`${ARABIC_THREE}$x$`)).not.toContain('md-mathi');
    expect(inline(`${ROMAN_TEN}$x$`)).not.toContain('md-mathi');
  });

  it('counts a combining mark, ZWJ and ZWNJ as word characters', () => {
    for (const joiner of [ACUTE, ZWJ, ZWNJ]) {
      expect(inline(`e${joiner}$x$`)).not.toContain('md-mathi');
    }
  });

  it('does NOT count a superscript two — and the ports disagree about it', () => {
    // `²` is `No`: Alphabetic says no, `\p{Nd}` says no, so ICU's `\w` does not
    // match it and `²$x$` IS a formula here. The two LaTeX writers spell the
    // same guard `[\p{L}\p{N}_]`, where `²` *is* a word character and the same
    // input is prose; Kotlin spells it a third way again (`[\p{L}\p{N}_$]`).
    // This file follows the Swift HTML writer, whose bytes the golden corpus
    // was captured from. Recorded, not resolved — port spec OQ-3. Unifying the
    // three is a four-repo change, not a port decision.
    expect(inline(`${SUPER_TWO}$x$`)).toContain('md-mathi');
  });
});

describe('emphasis', () => {
  // Swift: testHTMLInlineEmphasis
  it('converts the five delimiters', () => {
    expect(inline('**bold** and *italic* and ~~gone~~')).toBe(
      '<strong>bold</strong> and <em>italic</em> and <del>gone</del>',
    );
    expect(inline('__bold__ and _italic_')).toBe(
      '<strong>bold</strong> and <em>italic</em>',
    );
  });

  it('runs bold before italic, so *** nests', () => {
    expect(inline('***x***')).toBe('<em><strong>x</strong></em>');
  });

  it('uses "no delimiter inside" content classes', () => {
    expect(inline('**a*b**')).not.toContain('<strong>');
  });

  it('replaces every match, not the first', () => {
    // The Swift calls `stringByReplacingMatches`, so each pattern carries `g`.
    expect(inline('*a* and *b* and *c*')).toBe('<em>a</em> and <em>b</em> and <em>c</em>');
    expect(inline('`x` and `y`')).toBe('<code>x</code> and <code>y</code>');
  });

  // Swift: testHTMLUnderscoreInWordIsNotItalic
  it('guards underscore italics at word boundaries so snake_case survives', () => {
    expect(inline('call some_long_name now')).not.toContain('<em>');
    expect(inline('a_b_c is one word')).not.toContain('<em>');
  });
});

describe('links and images', () => {
  // Swift: testHTMLLink / testHTMLLinkWithTitle
  it('converts links, with and without a title', () => {
    expect(inline('[site](https://nettrash.me)')).toBe(
      '<a href="https://nettrash.me">site</a>',
    );
    expect(inline('[site](https://nettrash.me "Hover title")')).toBe(
      '<a href="https://nettrash.me" title="Hover title">site</a>',
    );
  });

  // Swift: testHTMLImage / testHTMLImageWithTitle
  it('converts images, emitting a void tag that is not self-closed', () => {
    expect(inline('![Alt text](https://nettrash.me/favicon.ico)')).toBe(
      '<img src="https://nettrash.me/favicon.ico" alt="Alt text">',
    );
    // Attribute order is src, alt, title.
    expect(inline('![Alt](https://nettrash.me/favicon.ico "The favicon")')).toBe(
      '<img src="https://nettrash.me/favicon.ico" alt="Alt" title="The favicon">',
    );
  });

  // Swift: testHTMLLinkedImage
  it('runs the image pass before the link pass', () => {
    // Image syntax is link syntax with a leading `!`, so the link pass would
    // otherwise eat it.
    expect(
      inline('[![badge](https://nettrash.me/favicon.ico)](https://nettrash.me)'),
    ).toBe(
      '<a href="https://nettrash.me"><img src="https://nettrash.me/favicon.ico" alt="badge"></a>',
    );
  });

  it('runs the titled forms before the untitled ones', () => {
    // Otherwise the untitled pattern stops at the first `)` and the title
    // leaks into the document as text.
    expect(inline('[a](u "t")')).not.toContain('&quot;t&quot;)');
  });

  it('allows an empty alt but not an empty label', () => {
    expect(inline('![](x.png)')).toBe('<img src="x.png" alt="">');
    expect(inline('[](x)')).toBe('[](x)');
  });

  it('spells ICU’s \\s out, so U+FEFF is allowed inside a URL', () => {
    // Measured: ICU `\s` matches TAB, U+000B, NBSP and U+2003 but *not*
    // U+FEFF; JavaScript's `\s` matches U+FEFF and is a different set again.
    // The URL class is `[^)\s]+`, so the two disagree on exactly this input.
    expect(inline(`[a](x${BOM}y)`)).toBe(`<a href="x${BOM}y">a</a>`);
    // NBSP is `\p{Z}` in both, and still ends the URL.
    expect(inline(`[a](x${NBSP}y)`)).not.toContain('<a href');
  });
});

describe('footnote references', () => {
  it('leaves a placeholder for the document-wide numbering pass', () => {
    // The number and the target depend on the order of first reference across
    // the whole document, which a span pass cannot know.
    expect(inline('a[^b]')).toBe('a<sup class="md-fnref" data-fn="b"></sup>');
  });

  it('accepts only the ASCII identifier set the parser accepts', () => {
    expect(inline('[^café]')).toBe('[^café]');
    expect(inline('[^two words]')).toBe('[^two words]');
  });

  // Swift: testFootnoteReferenceCannotBreakOutIntoMarkup
  it('runs last, after images and links', () => {
    // Running it earlier let an image carry the markup into an `alt`
    // attribute — straight through the quoting this pass relies on — and let
    // a link wrap it in an `<a>` inside another `<a>`.
    const image = inline('![alt [^a] here](i.png)');
    expect(image).not.toContain('alt="alt <sup');
    expect(image).not.toContain('<img');

    // The accepted casualty: a reference inside a link label simply stops
    // that label being a link, which is the harmless failure.
    const link = inline('[see [^a] here](u)');
    expect(link).not.toContain('<a href="u">');
    expect(link).not.toContain('</a></a>');

    // Ordinary links and images are untouched by the footnote pass.
    expect(inline('[text](u) and ![a](i.png)')).toBe(
      '<a href="u">text</a> and <img src="i.png" alt="a">',
    );
  });
});

describe('restore', () => {
  it('leaks the private-use token when a code span sits inside display math', () => {
    // KNOWN LATENT BUG, REPRODUCED DELIBERATELY. A later protect pass can
    // swallow an earlier pass's token, and because restore runs ascending the
    // enclosed token is restored before its enclosing HTML is back in the
    // string — so the raw U+E000 / U+E001 survive into the page. Restoring
    // descending, or restoring twice, would fix it; neither is done, because
    // the three shipping apps all behave this way, byte parity is the
    // contract, and changing it is a four-repo product decision (OQ-6).
    const html = inline('$$ `x` $$');
    expect(html).toBe(
      `<span class="md-mathd"> ${TOKEN_OPEN}0${TOKEN_CLOSE} </span>`,
    );
    expect(html).toContain(TOKEN_OPEN);
  });

  it('does not convert soft breaks unless the paragraph renderer asks', () => {
    // `<br>` insertion happens between the span pass and restore, so a
    // multi-line display-math span keeps its own internal newlines instead of
    // having `<br>`s injected into the formula. Only `renderBlock`'s paragraph
    // case turns it on; see html.test.ts.
    expect(inline('a\nb')).toBe('a\nb');
  });
});
