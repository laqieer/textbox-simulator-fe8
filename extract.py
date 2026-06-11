#!/usr/bin/env python3
"""Extract FE8 (fireemblem8u) font glyph data into JSON for the Textbox Simulator.

Reads the decomp's font headers and control-code definitions and produces:

  data/glyph-widths.json   char code (0-255) -> { width, bitmap } per font table
  data/control-codes.json  control-code name -> { bytes, layout }

How FE8 renders dialogue text
-----------------------------
FE8 (US) runs the text engine in LANG_ENGLISH mode (see src/main.c:
`SetLang(LANG_ENGLISH)`). In that mode the engine takes the ASCII path
(Text_DrawCharacterAscii / GetCharTextLenASCII in src/fontgrp.c): one byte per
glyph, looked up directly as `glyphs[byte]`, advancing the cursor by
`glyph->width` pixels. The active glyph table for dialogue is `TextGlyphs_Talk`
(set by SetTextFontGlyphs(TEXT_GLYPHS_TALK)). A NULL entry falls back to the
'?' glyph. This script therefore maps each byte value 0-255 to the width (and
bitmap) of TextGlyphs_Talk[byte], plus the System/Special tables for reference.

Run from the repo root with the decomp path:

  python3 extract.py /home/laqieer/fireemblem8u

(If omitted, defaults to /home/laqieer/fireemblem8u.)
"""

import json
import os
import re
import sys

# Glyph struct headers and the pointer-table headers in the decomp.
GLYPH_HEADERS = [
    "src/data/fonts/glyphs_1.h",
    "src/data/fonts/glyphs_2.h",
    "src/data/fonts/glyphs_3.h",
]
TABLE_NAMES = ["TextGlyphs_System", "TextGlyphs_Talk", "TextGlyphs_Special"]
CONTROL_DEFS = "texts/textdefs.txt"

GLYPH_RE = re.compile(
    r"struct\s+Glyph\s+(gFontgrp_\d+)\s*=\s*\{(.*?)\};",
    re.DOTALL,
)
WIDTH_RE = re.compile(r"\.width\s*=\s*(\d+)")
SJISBYTE_RE = re.compile(r"\.sjisByte1\s*=\s*(\d+)")
BITMAP_RE = re.compile(r"\.bitmap\s*=\s*\{(.*?)\}", re.DOTALL)
HEX_RE = re.compile(r"0x[0-9A-Fa-f]+")
TABLE_RE = re.compile(
    r"struct\s+Glyph\s*\*\s*(\w+)\s*\[\s*\]\s*=\s*\{(.*?)\};",
    re.DOTALL,
)
ENTRY_RE = re.compile(r"&\s*(gFontgrp_\d+)|\bNULL\b")
# textdefs lines: [Name] = v   or   [Name] = v1, v2
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
            bitmap = []
            if bm:
                bitmap = [int(h, 16) for h in HEX_RE.findall(bm.group(1))]
            # pad/truncate to 16 rows
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
            entries = []
            for em in ENTRY_RE.finditer(body):
                entries.append(em.group(1))  # gFontgrp_N or None for NULL
            tables[name] = entries
    return tables


def build_width_table(glyphs, table):
    """char code (str) -> {width, bitmap} for one pointer table.

    Mirrors the LANG_ENGLISH ASCII path: index == byte value; NULL falls back
    to the '?' (0x3F) glyph, exactly like Text_DrawCharacterAscii.
    """
    fallback_idx = ord("?")
    fallback_name = (
        table[fallback_idx] if fallback_idx < len(table) else None
    )
    out = {}
    for code in range(256):
        name = table[code] if code < len(table) else None
        resolved = name if name is not None else fallback_name
        if resolved is None or resolved not in glyphs:
            out[str(code)] = {"width": 0, "bitmap": [0] * 16}
        else:
            g = glyphs[resolved]
            out[str(code)] = {"width": g["width"], "bitmap": g["bitmap"]}
    return out


def parse_control_codes(root):
    """Parse textdefs.txt -> name -> {bytes:[...], layout:str}.

    layout classification (for the wrapping engine):
      "end"     -> [X] (0): terminates the string
      "newline" -> [NL]/[LF] (1): forced line break, advances one line
      "newline2"-> [NL2]/[CR] (2): paragraph break (clears box / new page)
      "control" -> everything else: consumed, no glyph width, no line effect
    """
    path = os.path.join(root, CONTROL_DEFS)
    with open(path, "r", encoding="utf-8") as f:
        text = strip_comments(f.read())

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
        else:
            layout = "control"
        out[name] = {"bytes": values, "layout": layout}
    return out


def main(argv):
    root = argv[1] if len(argv) > 1 else "/home/laqieer/fireemblem8u"
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    os.makedirs(out_dir, exist_ok=True)

    glyphs = parse_glyphs(root)
    tables = parse_tables(root)

    widths = {}
    for tname in TABLE_NAMES:
        if tname in tables:
            key = tname.replace("TextGlyphs_", "").lower()  # system/talk/special
            widths[key] = build_width_table(glyphs, tables[tname])

    control = parse_control_codes(root)

    with open(os.path.join(out_dir, "glyph-widths.json"), "w", encoding="utf-8") as f:
        json.dump(widths, f, separators=(",", ":"))
        f.write("\n")

    with open(os.path.join(out_dir, "control-codes.json"), "w", encoding="utf-8") as f:
        json.dump(control, f, indent=2, sort_keys=True)
        f.write("\n")

    # Report
    talk = widths.get("talk", {})
    nonzero = sum(1 for v in talk.values() if v["width"] > 0)
    print(f"Parsed {len(glyphs)} glyph structs from {len(tables)} tables.")
    print(f"Tables emitted: {', '.join(sorted(widths))}")
    print(f"Talk: {nonzero}/256 codes have nonzero width.")
    print(f"Control codes: {len(control)} entries.")
    for ch in "AWim .":
        code = ord(ch)
        w = talk.get(str(code), {}).get("width")
        print(f"  '{ch}' (0x{code:02X}) -> width {w}")


if __name__ == "__main__":
    main(sys.argv)
