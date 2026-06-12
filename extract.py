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
  window.png          the real FE8 dialogue window frame tiles (corner/top/left/fill)
  window.json         box geometry + frame tile metadata
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

    window = extract_window(root, out_dir)

    control = parse_control_codes(root)
    dump("control-codes.json", control, indent=2, sort_keys=True)

    nonzero = sum(1 for v in talk_tab.values() if v["width"] > 0)
    print(f"Parsed {len(glyphs)} glyph structs from {len(tables)} tables.")
    print(f"Talk: {nonzero}/256 codes have nonzero width.")
    print(f"Palette (Talk@0xb): {palette['colors']}")
    print(f"Window geometry: box {window['boxX']},{window['boxY']} "
          f"inner {window['innerW']}x{window['innerH']} lineH {window['lineHeight']}")
    print(f"Control codes: {len(control)} entries.")
    for ch in "AWim .":
        code = ord(ch)
        w = talk_tab.get(str(code), {}).get("width")
        print(f"  '{ch}' (0x{code:02X}) -> width {w}")


if __name__ == "__main__":
    main(sys.argv)
