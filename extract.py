#!/usr/bin/env python3
"""Extract FE8 (fireemblem8u) dialogue assets into JSON/PNG for the simulator.

Reproducible: run from the repo root with the decomp path (default
/home/laqieer/fireemblem8u):

    python3 extract.py [--decomp /home/laqieer/fireemblem8u]

Produces into data/:
  glyphs-talk.json    char code -> {width, bitmap[16 u32]} (TextGlyphs_Talk, glyphs_2.h)
  glyphs-system.json  char code -> {width, bitmap[16 u32]} (TextGlyphs_System, glyphs_1.h)
  glyph-widths.json   { talk, system } compatibility bundle (older consumers)
  palette.json        resolved 4-colour Talk dialogue palette (idx0 transparent)
  palette-system.json resolved 4-colour System (menu/help) text palette, from
                      TEXT_COLOR_SYSTEM_WHITE (Pal_Text @ identity LUT gFontgrp_3)
  window.png          the real FE8 dialogue window frame tiles (corner/top/left/fill)
  window.json         box geometry + frame tile metadata
  window-system.png   the real FE8 menu window frame tiles (uiutils DrawUiFrame)
  window-system.json  system box geometry + DrawUiFrame model metadata
  control-codes.json  control-code name -> {bytes, layout}

How FE8 renders event dialogue (the MSG / cgtext path)
------------------------------------------------------
eventscr.c EventText_StartCgTextMsg -> StartCgText(3, 0x12, 0x14, 4, ...).
- Glyphs: SetTextFontGlyphs(TEXT_GLYPHS_TALK); ASCII path, one byte per glyph,
  advance = TextGlyphs_Talk[byte]->width, NULL -> '?' (0x3F).
- Colour: cgtext.c Text_SetColor(.., 0xb). colorId 0xb -> s2bppTo4bppLutTable[0xb]
  = gFontgrp_14, whose LUT maps 2bpp pixel values 0->palidx4, 1->13, 2->14, 3->15
  (color_lookup_tables.h). The palette bound for this path is gPal_HelpTextBox
  (cgtext.c StartCgText: ApplyPalette(gPal_HelpTextBox, pal)) -- NOT Pal_TalkText
  (that is the separate scene.c talk-bubble path, colorId 0). So the resolved
  dialogue ink is gPal_HelpTextBox[{4,13,14,15}] with pixel value 0 transparent.
- Window frame: scene.c PutTalkBubbleTm draws tiles 0x10..0x13 (corner/top/left/
  fill, with H/V flips) at palette 3, sourced from graphics/misc/Img_TalkBubble.png
  recoloured through Pal_TalkBubble.
- Geometry: x=3 tiles=24px, y=0x12=18 tiles=144px, inner width=0x14=20 tiles=160px,
  4 lines, line height 16px (cgtext.c GetCgTextBoxDimensions/GetCgTextDimensions).
"""

import argparse
import json
import os
import re
import struct
import sys

# --- Glyph + table headers ----------------------------------------------------
GLYPH_HEADERS = [
    "src/data/fonts/glyphs_1.h",
    "src/data/fonts/glyphs_2.h",
    "src/data/fonts/glyphs_3.h",
]
TABLE_NAMES = ["TextGlyphs_System", "TextGlyphs_Talk", "TextGlyphs_Special"]
CONTROL_DEFS = "texts/textdefs.txt"
UI_PALETTES = "src/data/ui/ui_palettes.s"
TALKBUBBLE_PNG = "graphics/misc/Img_TalkBubble.png"
TALKBUBBLE_PAL = "graphics/misc/Pal_TalkBubble.gbapal"
# System text (menus / help box). System text uses Pal_Text via
# InitSystemTextFont (fontgrp.c). The canonical system window is the standard UI
# menu frame (uiutils.c DrawUiFrame style 0) drawn from gUiFrameImage tiles with
# gUiFramePaletteA.
SYSTEXT_PAL_GBAPAL = "graphics/misc/Pal_Text.gbapal"
UIFRAME_4BPP = "graphics/misc/gUiFrameImage.4bpp"
UIFRAME_PAL_GBAPAL = "graphics/misc/gUiFramePaletteA.gbapal"

GLYPH_RE = re.compile(r"struct\s+Glyph\s+(gFontgrp_\d+)\s*=\s*\{(.*?)\};", re.DOTALL)
WIDTH_RE = re.compile(r"\.width\s*=\s*(\d+)")
SJISBYTE_RE = re.compile(r"\.sjisByte1\s*=\s*(\d+)")
BITMAP_RE = re.compile(r"\.bitmap\s*=\s*\{(.*?)\}", re.DOTALL)
HEX_RE = re.compile(r"0x[0-9A-Fa-f]+")
TABLE_RE = re.compile(r"struct\s+Glyph\s*\*\s*(\w+)\s*\[\s*\]\s*=\s*\{(.*?)\};", re.DOTALL)
ENTRY_RE = re.compile(r"&\s*(gFontgrp_\d+)|(NULL)")
DEF_RE = re.compile(r"\[(.*?)\]\s*=\s*(.+)")


def strip_comments(text):
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    return text


def parse_glyphs(root):
    """name (gFontgrp_N) -> {width, sjisByte1, bitmap[16]}"""
    glyphs = {}
    for rel in GLYPH_HEADERS:
        with open(os.path.join(root, rel), "r", encoding="utf-8") as f:
            src = f.read()
        for m in GLYPH_RE.finditer(src):
            name, body = m.group(1), m.group(2)
            wm = WIDTH_RE.search(body)
            sm = SJISBYTE_RE.search(body)
            bm = BITMAP_RE.search(body)
            width = int(wm.group(1)) if wm else 0
            sjis = int(sm.group(1)) if sm else 0
            bitmap = [int(h, 16) for h in HEX_RE.findall(bm.group(1))] if bm else []
            bitmap = (bitmap + [0] * 16)[:16]
            glyphs[name] = {"width": width, "sjisByte1": sjis, "bitmap": bitmap}
    return glyphs


def parse_tables(root):
    """table name -> ordered list of glyph names or None (index == char code)."""
    tables = {}
    for rel in GLYPH_HEADERS:
        with open(os.path.join(root, rel), "r", encoding="utf-8") as f:
            src = f.read()
        for m in TABLE_RE.finditer(src):
            name, body = m.group(1), m.group(2)
            if name not in TABLE_NAMES:
                continue
            entries = [em.group(1) for em in ENTRY_RE.finditer(body)]  # None for NULL
            tables[name] = entries
    return tables


def build_glyph_table(glyphs, table):
    """char code (str) -> {width, bitmap}; NULL falls back to '?' (ASCII path)."""
    fallback_idx = ord("?")
    fallback = table[fallback_idx] if fallback_idx < len(table) else None
    out = {}
    for code in range(256):
        name = table[code] if code < len(table) else None
        resolved = name if name is not None else fallback
        if resolved is None or resolved not in glyphs:
            out[str(code)] = {"width": 0, "bitmap": [0] * 16}
        else:
            g = glyphs[resolved]
            out[str(code)] = {"width": g["width"], "bitmap": g["bitmap"]}
    return out


# --- Palettes -----------------------------------------------------------------
def bgr555_to_rgb(v):
    r = v & 31
    g = (v >> 5) & 31
    b = (v >> 10) & 31
    return (round(r * 255 / 31), round(g * 255 / 31), round(b * 255 / 31))


def rgb_hex(rgb):
    return "#%02X%02X%02X" % rgb


def parse_asm_palette(root, label):
    """Read a 16-entry BGR555 palette declared in an asm file by symbol label.

    Handles both `.byte 0xNN` (byte stream) and `.byte 0xNNNN` (halfword) forms.
    """
    path = os.path.join(root, UI_PALETTES)
    lines = open(path, "r", encoding="utf-8").read().splitlines()
    start = None
    for i, ln in enumerate(lines):
        if ln.strip() == label + ":":
            start = i
            break
    if start is None:
        raise ValueError(f"palette label {label} not found in {UI_PALETTES}")
    # Collect numeric operands and remember the directive size (.byte vs
    # .short/.hword). gba palettes are 16 BGR555 halfwords.
    raw = []  # (size_in_bytes, value)
    dir_re = re.compile(r"\.(byte|short|hword|2byte|half)\s+(0x[0-9a-fA-F]+|\d+)")
    for ln in lines[start + 1:]:
        if ".size" in ln:
            break
        m = dir_re.search(ln)
        if m:
            sz = 1 if m.group(1) == "byte" else 2
            raw.append((sz, int(m.group(2), 0)))
    if raw and raw[0][0] == 2:
        vals = [v for _sz, v in raw][:16]  # already halfwords
    else:
        # little-endian byte stream: combine consecutive byte operands into
        # halfwords (low byte first).
        bytes_only = [v & 0xFF for _sz, v in raw][:32]
        vals = [bytes_only[i] | (bytes_only[i + 1] << 8) for i in range(0, len(bytes_only) - 1, 2)][:16]
    return [bgr555_to_rgb(v) for v in vals]


def parse_gbapal(path):
    data = open(path, "rb").read()
    n = len(data) // 2
    vals = struct.unpack("<%dH" % n, data[: n * 2])
    return [bgr555_to_rgb(v) for v in vals[:16]]


# gFontgrp_14 (colorId 0xb) LUT: pixel value -> palette index.
TALK_LUT = {0: 4, 1: 13, 2: 14, 3: 15}


def resolve_talk_palette(root):
    """Resolved 4-colour Talk@0xb dialogue palette.

    pixel value 0 is rendered transparent (null); 1/2/3 map to gPal_HelpTextBox
    indices 13/14/15 via the gFontgrp_14 LUT. (Pixel 0 -> palidx4 is the box-fill
    colour, but a whole-zero source byte renders transparent, so the simulator
    treats glyph pixel value 0 as transparent.)
    """
    pal = parse_asm_palette(root, "gPal_HelpTextBox")
    entries = [None]  # idx0 transparent
    for px in (1, 2, 3):
        entries.append(rgb_hex(pal[TALK_LUT[px]]))
    return {
        "colors": entries,
        "source": "gPal_HelpTextBox",
        "colorId": "0xb",
        "lut": "gFontgrp_14",
        "lut_pixel_to_palidx": {str(k): v for k, v in TALK_LUT.items()},
    }


# gFontgrp_3 (colorId TEXT_COLOR_0123) LUT is the identity LUT: pixel value ->
# palette index unchanged (color_lookup_tables.h: COLOR_CONVERT(pixel)=pixel).
# TEXT_COLOR_SYSTEM_WHITE == TEXT_COLOR_0123 (fontgrp.h), and system text binds
# Pal_Text (fontgrp.c InitSystemTextFont: ApplyPalette(Pal_Text, ...) then forces
# palette index 0 = transparent). So system ink = Pal_Text[{1,2,3}], pixel 0
# transparent.
SYSTEM_LUT = {0: 0, 1: 1, 2: 2, 3: 3}


def resolve_system_palette(root):
    """Resolved 4-colour system (menu/help) text palette.

    pixel value 0 transparent; 1/2/3 map to Pal_Text indices 1/2/3 via the
    identity gFontgrp_3 LUT (TEXT_COLOR_SYSTEM_WHITE = TEXT_COLOR_0123). This is
    the white-on-dark system font the help box / menus draw, NOT the dialogue
    talk-bubble ink (gPal_HelpTextBox @ 0xb / gFontgrp_14).
    """
    pal = parse_gbapal(os.path.join(root, SYSTEXT_PAL_GBAPAL))
    entries = [None]  # idx0 transparent (PAL_COLOR(.., 0) = 0 in InitSystemTextFont)
    for px in (1, 2, 3):
        entries.append(rgb_hex(pal[SYSTEM_LUT[px]]))
    return {
        "colors": entries,
        "source": "Pal_Text",
        "color": "TEXT_COLOR_SYSTEM_WHITE (TEXT_COLOR_0123)",
        "lut": "gFontgrp_3 (identity)",
        "lut_pixel_to_palidx": {str(k): v for k, v in SYSTEM_LUT.items()},
    }


# --- System window frame (uiutils.c DrawUiFrame style 0) ----------------------
# gUiutils_0 model tilemap (uiutils.c): 16 tile indices into gUiFrameImage laid
# out as a 4x4 model that DrawUiFrame expands into a frame with 2-tile-thick
# corner blocks. Index meaning matches DrawUiFrame's comments.
UIFRAME_MODEL = [
    0x01, 0x02, 0x03, 0x05,
    0x07, 0x08, 0x09, 0x0A,
    0x06, 0x09, 0x09, 0x0A,
    0x1A, 0x1B, 0x1B, 0x21,
]


def decode_4bpp_tile(data, tile_index):
    """Return an 8x8 list of palette indices for a 4bpp tile (32 bytes)."""
    base = tile_index * 32
    px = [[0] * 8 for _ in range(8)]
    for ty in range(8):
        for tx in range(4):
            b = data[base + ty * 4 + tx]
            px[ty][tx * 2] = b & 0xF
            px[ty][tx * 2 + 1] = (b >> 4) & 0xF
    return px


def extract_system_window(root, out_dir):
    """Compose window-system.png: the 16 distinct gUiutils_0 model frame tiles
    (recoloured through gUiFramePaletteA), laid out one per 8px slot in model
    order, plus geometry metadata so the simulator can replicate DrawUiFrame.

    Palette index 0 in the frame is the box-fill colour gUiFramePaletteA[0]
    (NOT transparent): the menu interior is opaque. The simulator renders this
    strip 1:1 and treats it as opaque tiles.
    """
    from PIL import Image

    pal = parse_gbapal(os.path.join(root, UIFRAME_PAL_GBAPAL))
    tiles = open(os.path.join(root, UIFRAME_4BPP), "rb").read()

    n = len(UIFRAME_MODEL)
    out = Image.new("RGBA", (TILE * n, TILE), (0, 0, 0, 0))
    opx = out.load()
    for slot, tidx in enumerate(UIFRAME_MODEL):
        cells = decode_4bpp_tile(tiles, tidx)
        for y in range(TILE):
            for x in range(TILE):
                idx = cells[y][x]
                r, g, b = pal[idx]
                opx[slot * TILE + x, y] = (r, g, b, 255)
    out.save(os.path.join(out_dir, "window-system.png"))

    # The box interior fill is whatever the centre tile (model[6]) is solidly
    # painted with; that tile is a single repeated palette index.
    center_cells = decode_4bpp_tile(tiles, UIFRAME_MODEL[6])
    fill_idx = center_cells[0][0]
    fill = rgb_hex(pal[fill_idx])
    window = {
        # Frame is 2 tiles thick on every side (DrawUiFrame corner blocks are
        # 2x2 tiles). The text area is the inner region.
        "borderTiles": 2,
        "lines": 2,
        "lineHeight": 16,       # system font line height (16px cell)
        "textInsetX": 4,        # menu text inset (Text_SetCursor 4)
        "textInsetY": 0,        # text sits at the top of each 16px line cell
        "tile": TILE,
        "fill": fill,           # opaque box interior (centre tile colour)
        "fillIndex": fill_idx,  # gUiFramePaletteA index of the interior fill
        # gUiutils_0 model in DrawUiFrame slot order (index -> gUiFrameImage tile,
        # mirrored 1:1 into window-system.png slots).
        "modelSlots": list(range(len(UIFRAME_MODEL))),
        "model": UIFRAME_MODEL,
        "palette": "gUiFramePaletteA (BGPAL_WINDOW_FRAME)",
        "image": "gUiFrameImage (uiutils.c, DrawUiFrame style 0 / gUiutils_0)",
        "source": "src/uiutils.c DrawUiFrame + gUiutils_0",
    }
    with open(os.path.join(out_dir, "window-system.json"), "w", encoding="utf-8") as f:
        json.dump(window, f, indent=2)
        f.write("\n")
    return window


# --- Window frame -------------------------------------------------------------
# Img_TalkBubble.png tile indices used by PutTalkBubbleTm (tiles 0x10..0x13):
#   0 = corner (top-left), 1 = top edge, 2 = left edge, 3 = interior fill.
FRAME_TILES = {"corner": 0, "top": 1, "left": 2, "fill": 3}
TILE = 8


def extract_window(root, out_dir):
    """Compose window.png (4 base frame tiles recoloured via Pal_TalkBubble)."""
    from PIL import Image

    pal = parse_gbapal(os.path.join(root, TALKBUBBLE_PAL))
    src = Image.open(os.path.join(root, TALKBUBBLE_PNG))
    sw, _sh = src.size
    cols = sw // TILE
    spx = src.load()

    order = ["corner", "top", "left", "fill"]
    out = Image.new("RGBA", (TILE * len(order), TILE), (0, 0, 0, 0))
    opx = out.load()
    for slot, name in enumerate(order):
        tidx = FRAME_TILES[name]
        tx, ty = (tidx % cols) * TILE, (tidx // cols) * TILE
        for y in range(TILE):
            for x in range(TILE):
                idx = spx[tx + x, ty + y]
                if idx == 0:
                    opx[slot * TILE + x, y] = (0, 0, 0, 0)  # transparent
                else:
                    r, g, b = pal[idx]
                    opx[slot * TILE + x, y] = (r, g, b, 255)
    out.save(os.path.join(out_dir, "window.png"))

    window = {
        "boxX": 24,            # x=3 tiles * 8
        "boxY": 144,           # y=0x12 (18) tiles * 8
        "innerW": 160,         # width=0x14 (20) tiles * 8
        "innerH": 32,          # boxHeight 4 tiles (32px) = 2 lines * 16px
        "lines": 2,
        "lineHeight": 16,
        "textInsetX": 4,       # Text_SetCursor(.., 4)
        "textInsetY": 0,
        "tile": TILE,
        "screenW": 240,
        "screenH": 160,
        "frame": {
            "slots": order,
            "corner": {"slot": 0, "flips": "TL as-is; TR=Hflip; BL=Vflip; BR=HVflip"},
            "top": {"slot": 1, "note": "bottom edge = Vflip"},
            "left": {"slot": 2, "note": "right edge = Hflip"},
            "fill": {"slot": 3},
        },
        "palette": "Pal_TalkBubble (palette 3)",
        "tiles_source": "graphics/misc/Img_TalkBubble.png 0x10..0x13",
    }
    with open(os.path.join(out_dir, "window.json"), "w", encoding="utf-8") as f:
        json.dump(window, f, indent=2)
        f.write("\n")
    return window


# --- Control codes ------------------------------------------------------------
def parse_control_codes(root):
    path = os.path.join(root, CONTROL_DEFS)
    text = strip_comments(open(path, "r", encoding="utf-8").read())
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        m = DEF_RE.match(line)
        if not m:
            continue
        name = m.group(1)
        try:
            values = [int(v.strip(), 0) for v in m.group(2).split(",")]
        except ValueError:
            continue
        if values == [0]:
            layout = "end"
        elif values in ([1], [2]) and name in ("NL", "LF"):
            layout = "newline"
        elif values in ([1], [2]) and name in ("NL2", "CR"):
            layout = "newline2"
        elif values == [1]:
            layout = "newline"
        elif values == [2]:
            layout = "newline2"
        elif values == [3]:
            layout = "advance8"  # [A]: +8px width (GetCgTextBoxDimensions case 0x03)
        else:
            layout = "control"
        out[name] = {"bytes": values, "layout": layout}
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("decomp_pos", nargs="?", default=None)
    ap.add_argument("--decomp", default=None)
    args = ap.parse_args(argv[1:])
    root = args.decomp or args.decomp_pos or "/home/laqieer/fireemblem8u"

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    os.makedirs(out_dir, exist_ok=True)

    glyphs = parse_glyphs(root)
    tables = parse_tables(root)

    talk_tab = build_glyph_table(glyphs, tables["TextGlyphs_Talk"])
    sys_tab = build_glyph_table(glyphs, tables["TextGlyphs_System"])
    bundle = {"talk": talk_tab, "system": sys_tab}

    def dump(name, obj, **kw):
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as f:
            json.dump(obj, f, **kw)
            f.write("\n")

    dump("glyphs-talk.json", talk_tab, separators=(",", ":"))
    dump("glyphs-system.json", sys_tab, separators=(",", ":"))
    dump("glyph-widths.json", bundle, separators=(",", ":"))

    palette = resolve_talk_palette(root)
    dump("palette.json", palette, indent=2)

    palette_system = resolve_system_palette(root)
    dump("palette-system.json", palette_system, indent=2)

    window = extract_window(root, out_dir)
    window_system = extract_system_window(root, out_dir)

    control = parse_control_codes(root)
    dump("control-codes.json", control, indent=2, sort_keys=True)

    nonzero = sum(1 for v in talk_tab.values() if v["width"] > 0)
    print(f"Parsed {len(glyphs)} glyph structs from {len(tables)} tables.")
    print(f"Talk: {nonzero}/256 codes have nonzero width.")
    print(f"Palette (Talk@0xb): {palette['colors']}")
    print(f"Palette (System, TEXT_COLOR_SYSTEM_WHITE/Pal_Text): {palette_system['colors']}")
    print(f"Window geometry: box {window['boxX']},{window['boxY']} "
          f"inner {window['innerW']}x{window['innerH']} lineH {window['lineHeight']}")
    print(f"System window: border {window_system['borderTiles']} tiles, "
          f"fill {window_system['fill']}, lineH {window_system['lineHeight']}")
    print(f"Control codes: {len(control)} entries.")
    for ch in "AWim .":
        code = ord(ch)
        w = talk_tab.get(str(code), {}).get("width")
        print(f"  '{ch}' (0x{code:02X}) -> width {w}")


if __name__ == "__main__":
    main(sys.argv)
