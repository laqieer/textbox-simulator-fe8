# FE8 Textbox Simulator

A tiny static web app that previews how **Fire Emblem: The Sacred Stones (FE8)**
dialogue text wraps inside the textbox — without rebuilding the ROM. Glyph
advance widths are pixel-exact, pulled straight from the
[fireemblem8u](https://github.com/FireEmblemUniverse/fireemblem8u) decompilation.

This is an FE8 port of [meejle's](https://github.com/meejle/meejle.github.io)
pokeemerald Textbox Simulator — same idea, FE8 font metrics and control codes.

Live use: just open `index.html`, or serve the folder (see below).

## What it does

- Type FE8 dialogue text (with `[..]` control codes like `[LF]`, `[X]`, `[A]`).
- See it laid out live in a textbox whose width (in 8px tiles) and line count
  are configurable. Defaults match the FE8 **event dialogue box**: 20 tiles
  (160px) wide × 4 lines (from `StartCgText(3, 0x12, 0x14, 4, …)` in
  `src/eventscr.c`; the text area is `boxWidth_tiles * 8` px, see
  `src/cgtext.c` line ~204).
- Optional **auto-wrap** at the box width (word-aware) to preview how wide a
  line is getting. Note: real FE8 scripts are *hand-wrapped* with explicit
  `[LF]` codes — the game engine never auto-wraps — so auto-wrap is a preview
  aid, off by default.
- Real glyphs: each character is drawn from its actual FE8 16×16 2bpp bitmap.

## Scope / honesty

- **Wrapping and widths are exact.** The engine mirrors the FE8 dialogue text
  path: in `LANG_ENGLISH` mode (`SetLang(LANG_ENGLISH)` in `src/main.c`) the
  engine uses the ASCII glyph path (`Text_DrawCharacterAscii` /
  `GetCharTextLenASCII` in `src/fontgrp.c`): **one byte per glyph**, looked up
  directly as `TextGlyphs_Talk[byte]`, advancing the cursor by `glyph->width`
  pixels, falling back to the `?` glyph for unmapped bytes. Line geometry
  follows `GetCgTextBoxDimensions` / `GetCgTextDimensions` in `src/cgtext.c`
  (`[LF]`/`[NL]` = line break, `[X]` = end, `[0x80, xx]` and other control
  codes = consumed with zero width).
- **Glyph rendering is faithful but simplified.** Bitmaps are the real
  2-bits-per-pixel glyph data; the four palette indices (0 = transparent,
  1–3 = ink shades / anti-aliasing) are flattened to a single ink color. So
  letter *shapes and widths* match the game; subtle shading does not.

## Running

No build step. Either:

```sh
# Option A: open the file directly
xdg-open index.html        # or just double-click it

# Option B: serve over HTTP (needed if your browser blocks fetch() on file://)
python3 -m http.server
# then visit http://localhost:8000/
```

## How the data was extracted

`extract.py` parses the decomp's font headers and control-code definitions and
writes two JSON files into `data/`:

| File | Contents | Source in fireemblem8u |
| --- | --- | --- |
| `data/glyph-widths.json` | `{ talk, system, special }` → char code (0–255) → `{ width, bitmap[16] }` | `src/data/fonts/glyphs_{1,2,3}.h` (`struct Glyph` defs + `TextGlyphs_*[]` pointer tables) |
| `data/control-codes.json` | control-code name → `{ bytes, layout }` | `texts/textdefs.txt` |

The pointer tables (`TextGlyphs_Talk`, `TextGlyphs_System`, `TextGlyphs_Special`)
are walked so that **array index == character code**, matching the ASCII path
(`glyphs[byte]`). NULL entries fall back to the `?` glyph exactly like the game.
The dialogue font is `talk`.

Regenerate (requires a local checkout of the decomp):

```sh
python3 extract.py /path/to/fireemblem8u
```

`control-codes.json` `layout` values:

- `end` — `[X]` (byte 0): terminates the string.
- `newline` — `[LF]`/`[NL]` (byte 1): forced line break (+16px).
- `newline2` — `[CR]`/`[NL2]` (byte 2): paragraph / page break.
- `control` — everything else: consumed, zero width, no line effect.

## Testing

`test.mjs` loads the JSON + `wrap.js` and runs the wrapping engine on real FE8
strings from `texts/texts.txt`, asserting line breaks, termination, zero-width
control codes, exact widths, and auto-wrap behavior:

```sh
node test.mjs
```

(The browser/canvas rendering can't be verified headlessly — the engine and
width checks are the proof of correctness.)

## Files

- `index.html`, `style.css`, `app.js` — the static web app.
- `wrap.js` — the pure wrapping engine (works in both the browser and Node).
- `extract.py` — reproducible data extraction from the decomp.
- `data/glyph-widths.json`, `data/control-codes.json` — extracted data.
- `test.mjs` — Node test harness.

## Credits

- Original concept and design: **meejle** —
  <https://github.com/meejle/meejle.github.io>
- Font data and text engine: the **fireemblem8u** decompilation by the Fire
  Emblem Universe community — <https://github.com/FireEmblemUniverse/fireemblem8u>

## License

MIT — see [LICENSE](LICENSE).
