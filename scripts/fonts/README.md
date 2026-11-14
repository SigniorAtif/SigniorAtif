# Fonts

Subsets of three SIL Open Font License fonts, embedded into the SVG cards so they render the same everywhere. Each file holds only Basic Latin and a handful of punctuation marks.

| File | Font | Licence |
| --- | --- | --- |
| `InstrumentSerif-Regular.woff2`, `InstrumentSerif-Italic.woff2` | [Instrument Serif](https://github.com/Instrument/instrument-serif) | [OFL-instrumentserif.txt](OFL-instrumentserif.txt) |
| `Inter-400.woff2`, `Inter-600.woff2` | [Inter](https://github.com/rsms/inter), static instances at 400 and 600 | [OFL-inter.txt](OFL-inter.txt) |
| `JBM-400.woff2` | [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), static instance at 400 | [OFL-jetbrainsmono.txt](OFL-jetbrainsmono.txt) |

`metrics.json` holds each glyph's advance width (in ems) so `build.mjs` can wrap text without a font parser.
