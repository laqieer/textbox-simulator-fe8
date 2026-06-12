# FE8 Textbox Simulator

[![CI](https://github.com/laqieer/textbox-simulator-fe8/actions/workflows/ci.yml/badge.svg)](https://github.com/laqieer/textbox-simulator-fe8/actions/workflows/ci.yml)

A tiny static web app that previews how **Fire Emblem: The Sacred Stones (FE8)**
dialogue text wraps inside the textbox — without rebuilding the ROM. Glyph
advance widths are pixel-exact, pulled straight from the
[fireemblem8u](https://github.com/FireEmblemUniverse/fireemblem8u) decompilation.

This is an FE8 port of [meejle's](https://github.com/meejle/meejle.github.io)
pokeemerald Textbox Simulator — same idea, FE8 font metrics and control codes.

Live use: just open `index.html`, or serve the folder (see below).

## CI / Hosted

- **CI:** every push and pull request to `master` runs `node test.mjs` via the
  [CI workflow](.github/workflows/ci.yml) (see the badge above).
- **Hosted:** the app is a no-build static site deployed to **GitHub Pages**
  straight from the repo root by the [Pages workflow](.github/workflows/pages.yml)
  on every push to `master`. (The repo's Pages source must be set to
  "GitHub Actions" in **Settings → Pages**.)

## What it does

- Type FE8 dialogue text (with `[..]` control codes like `[NL]`, `[X]`, `[A]`).
- See it laid out live in a textbox whose width (in 8px tiles) and line count
  are configurable. Defaults match the FE8 **event dialogue box**: 20 tiles
  (160px) wide × 4 lines (from `StartCgText(3, 0x12, 0x14, 4, …)` in
  `src/eventscr.c`; the text area is `boxWidth_tiles * 8` px, see
  `src/cgtext.c` line ~204).
- Optional **auto-wrap** at the box width (word-aware) to preview how wide a
  line is getting. Note: real FE8 scripts are *hand-wrapped* with explicit
  `[NL]`/`[LF]` codes — the game engine never auto-wraps — so auto-wrap is a
  preview aid, off by default.
- Copy a `texts/texts.txt`-ready source string from the preview. Auto-wrapped
  line breaks are emitted as `[NL]`, and the `[X]` terminator is preserved.
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
- **Glyph rendering is faithful and shaded.** Bitmaps are the real
  2-bits-per-pixel glyph data, drawn through the real dialogue palette:
  pixel value 0 = transparent, 1 = `#DEDEDE`, 2 = `#BDBDBD`, 3 = `#292929`.
  These come from `gPal_HelpTextBox` resolved through the colour-`0xb`
  `gFontgrp_14` look-up table (pixel → palette index 4/13/14/15). The dialogue
  window frame is the real `Img_TalkBubble` tiles (`0x10..0x13`) recoloured
  through `Pal_TalkBubble` and 9-sliced (with H/V flips) exactly as
  `PutTalkBubbleTm` does in `src/scene.c`.

  > **Decomp note:** the event-MSG dialogue path
  > (`eventscr.c` → `StartCgText` → `src/cgtext.c`) binds **`gPal_HelpTextBox`**,
  > *not* `Pal_TalkText` (which an earlier assumption used). `Pal_TalkText`
  > belongs to the separate `src/scene.c` talk-bubble path at colour `0`.

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

`extract.py` parses the decomp's font headers, palettes, control-code
definitions and the dialogue-window graphics, and writes these files into
`data/`:

| File | Contents | Source in fireemblem8u |
| --- | --- | --- |
| `data/glyphs-talk.json` | char code (0–255) → `{ width, bitmap[16] }` (dialogue font) | `src/data/fonts/glyphs_2.h` (`TextGlyphs_Talk`) |
| `data/glyphs-system.json` | char code (0–255) → `{ width, bitmap[16] }` (system font) | `src/data/fonts/glyphs_1.h` (`TextGlyphs_System`) |
| `data/glyph-widths.json` | `{ talk, system }` bundle (compatibility) | as above |
| `data/palette.json` | resolved 4-colour dialogue palette (idx0 transparent) | `gPal_HelpTextBox` @ `0xb` via `gFontgrp_14` (`src/data/ui/ui_palettes.s`, `color_lookup_tables.h`) |
| `data/window.png` + `data/window.json` | the real dialogue window frame tiles + box geometry | `graphics/misc/Img_TalkBubble.png` + `Pal_TalkBubble`, `src/cgtext.c`/`src/scene.c` |
| `data/control-codes.json` | control-code name → `{ bytes, layout }` | `texts/textdefs.txt` |

The pointer tables (`TextGlyphs_Talk`, `TextGlyphs_System`) are walked so that
**array index == character code**, matching the ASCII path (`glyphs[byte]`).
NULL entries fall back to the `?` glyph exactly like the game. The dialogue font
is `talk`.

Run it against a local decomp checkout (default `/home/laqieer/fireemblem8u`):

```sh
python3 extract.py --decomp /path/to/fireemblem8u
```

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
