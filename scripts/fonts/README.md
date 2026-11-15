# Fonts

Subsets of two SIL Open Font License fonts, embedded into the SVG cards so they render the same everywhere. They are the two typefaces the portfolio uses. Each file holds only Basic Latin and a handful of punctuation marks.

| File | Font | Licence |
| --- | --- | --- |
| `Bricolage-400.woff2`, `Bricolage-600.woff2` | [Bricolage Grotesque](https://github.com/ateliertriay/bricolage), static instances at weight 400 and 600, optical size 14 | [OFL-bricolagegrotesque.txt](OFL-bricolagegrotesque.txt) |
| `Bricolage-Display-600.woff2` | Bricolage Grotesque, static instance at weight 600, optical size 96, for headlines | [OFL-bricolagegrotesque.txt](OFL-bricolagegrotesque.txt) |
| `JBM-400.woff2` | [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), static instance at 400 | [OFL-jetbrainsmono.txt](OFL-jetbrainsmono.txt) |

`metrics.json` holds each glyph's advance width (in ems) so `build.mjs` can wrap text without a font parser. Bricolage Grotesque has no arrow glyphs, so the cards set arrows in JetBrains Mono.
