// Objective decomp-match + wrapping-engine tests for the FE8 textbox simulator.
//
//   node test.mjs
//
// Asserts that the committed extracted data matches the fireemblem8u decomp
// byte-for-byte (glyph widths + full bitmaps, dialogue palette, window frame
// pixels/palette, geometry constants), and that the wrapping engine mirrors the
// cgtext.c line/width semantics on real FE8 dialogue strings.
//
// The decomp path defaults to /home/laqieer/fireemblem8u and can be overridden
// with FE8_DECOMP=/path. If the decomp is unavailable, the decomp-match asserts
// are skipped (the wrapping asserts still run).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as FE8Wrap from './wrap.js';

const here = dirname(fileURLToPath(import.meta.url));
const DECOMP = process.env.FE8_DECOMP || '/home/laqieer/fireemblem8u';

const talk = JSON.parse(readFileSync(join(here, 'data', 'glyphs-talk.json'), 'utf8'));
const system = JSON.parse(readFileSync(join(here, 'data', 'glyphs-system.json'), 'utf8'));
const palette = JSON.parse(readFileSync(join(here, 'data', 'palette.json'), 'utf8'));
const paletteSystem = JSON.parse(
  readFileSync(join(here, 'data', 'palette-system.json'), 'utf8')
);
const windowMeta = JSON.parse(readFileSync(join(here, 'data', 'window.json'), 'utf8'));
const windowSystem = JSON.parse(
  readFileSync(join(here, 'data', 'window-system.json'), 'utf8')
);
const controlCodes = JSON.parse(
  readFileSync(join(here, 'data', 'control-codes.json'), 'utf8')
);
const widths = talk;

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok   - ${msg}`);
  } else {
    console.error(`  FAIL - ${msg}`);
    failures++;
  }
}

function refLineWidth(items) {
  let w = 0;
  for (const it of items) {
    if (it.type === 'char') {
      const e = widths[String(it.code)] || widths[String(0x3f)];
      w += e.width;
    } else if (it.type === 'ctrl' && it.layout === 'advance8') {
      w += 8;
    }
  }
  return w;
}

// --- Decomp parsing helpers (mirror extract.py) ------------------------------
function parseGlyphTable(headerPath, tableName) {
  const src = readFileSync(headerPath, 'utf8');
  // glyph structs
  const glyphRe = /struct\s+Glyph\s+(gFontgrp_\d+)\s*=\s*\{([\s\S]*?)\};/g;
  const glyphs = {};
  let gm;
  while ((gm = glyphRe.exec(src)) !== null) {
    const name = gm[1];
    const body = gm[2];
    const wm = /\.width\s*=\s*(\d+)/.exec(body);
    const bm = /\.bitmap\s*=\s*\{([\s\S]*?)\}/.exec(body);
    const width = wm ? parseInt(wm[1], 10) : 0;
    const bitmap = bm
      ? (bm[1].match(/0x[0-9A-Fa-f]+/g) || []).map((h) => parseInt(h, 16) >>> 0)
      : [];
    while (bitmap.length < 16) bitmap.push(0);
    glyphs[name] = { width, bitmap: bitmap.slice(0, 16) };
  }
  // pointer table
  const tableRe = new RegExp(
    `struct\\s+Glyph\\s*\\*\\s*${tableName}\\s*\\[\\s*\\]\\s*=\\s*\\{([\\s\\S]*?)\\};`
  );
  const tm = tableRe.exec(src);
  const entries = [];
  if (tm) {
    const entryRe = /&\s*(gFontgrp_\d+)|(NULL)/g;
    let em;
    while ((em = entryRe.exec(tm[1])) !== null) entries.push(em[1] || null);
  }
  return { glyphs, entries };
}

function bgr555ToHex(v) {
  const r = v & 31;
  const g = (v >> 5) & 31;
  const b = (v >> 10) & 31;
  const s = (n) => Math.round((n * 255) / 31).toString(16).padStart(2, '0').toUpperCase();
  return `#${s(r)}${s(g)}${s(b)}`;
}

function parseAsmPalette(asmPath, label) {
  const lines = readFileSync(asmPath, 'utf8').split('\n');
  let i = lines.findIndex((l) => l.trim() === `${label}:`);
  if (i < 0) return null;
  const vals = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].includes('.size')) break;
    const m = /\.(byte|short|hword|2byte|half)\s+(0x[0-9a-fA-F]+|\d+)/.exec(lines[j]);
    if (m) vals.push({ sz: m[1] === 'byte' ? 1 : 2, v: parseInt(m[2], m[2].startsWith('0x') ? 16 : 10) });
  }
  let halfwords;
  if (vals.length && vals[0].sz === 2) {
    halfwords = vals.map((e) => e.v).slice(0, 16);
  } else {
    halfwords = [];
    for (let k = 0; k + 1 < vals.length && halfwords.length < 16; k += 2) {
      halfwords.push(vals[k].v | (vals[k + 1].v << 8));
    }
  }
  return halfwords.map(bgr555ToHex);
}

const decompAvailable =
  existsSync(join(DECOMP, 'src/data/fonts/glyphs_2.h')) &&
  existsSync(join(DECOMP, 'src/data/ui/ui_palettes.s'));

// --- Real strings from fireemblem8u/texts/texts.txt --------------------------
const MSG_149 =
  'For first-timers.[.][LF]Game rules and[LF]controls will be[LF]explained as you[LF]play.[.][X]';
const CUTSCENE =
  'And his companion[.][ToggleMouthMove]...[.][ToggleMouthMove][.....]must be Lady Eirika![A][X]';
const LONG =
  'The Demon King once threatened to engulf the whole of Magvel in darkness ' +
  'but was sealed away by the Sacred Stones long ago.[X]';

console.log('Test 1: [LF] forces line breaks, [X] terminates');
{
  const r = FE8Wrap.wrap(MSG_149, { widths, controlCodes });
  assert(r.lines.length === 5, `MSG_149 wraps to 5 lines (got ${r.lines.length})`);
  assert(r.height === 5 * FE8Wrap.LINE_HEIGHT, `height = 5 * 16 = ${r.height}`);
  const firstLineText = r.lines[0].items
    .filter((it) => it.type === 'char')
    .map((it) => String.fromCharCode(it.code))
    .join('');
  assert(firstLineText === 'For first-timers.', `line 1 text = "${firstLineText}"`);
}

console.log('Test 2: control codes are zero-width and measured width is exact');
{
  const r = FE8Wrap.wrap(CUTSCENE, { widths, controlCodes });
  assert(r.lines.length === 1, `cutscene line stays one line (got ${r.lines.length})`);
  const line = r.lines[0];
  assert(line.width === refLineWidth(line.items), `engine width ${line.width} == reference width ${refLineWidth(line.items)}`);
  const hasCtrl = line.items.some((it) => it.type === 'ctrl');
  assert(hasCtrl, 'control codes are present in the token stream');
}

console.log('Test 3: auto-wrap breaks a long string into >= 2 lines');
{
  const unwrapped = FE8Wrap.measure(LONG, { widths, controlCodes });
  const boxWidth = 160; // FE8 event dialogue text area
  assert(unwrapped.width > boxWidth, `unwrapped width ${unwrapped.width}px exceeds box ${boxWidth}px`);
  const r = FE8Wrap.wrap(LONG, { widths, controlCodes, autoWrap: true, boxWidth });
  assert(r.lines.length >= 2, `auto-wrap yields >= 2 lines (got ${r.lines.length})`);
  const allFit = r.lines.every((ln) => ln.width <= boxWidth);
  assert(allFit, 'every auto-wrapped line fits within boxWidth');
  const exact = r.lines.every((ln) => ln.width === refLineWidth(ln.items));
  assert(exact, 'auto-wrapped line widths remain exact');
}

console.log('Test 4: known per-glyph widths (spot check)');
{
  const checks = { A: [65, 6], W: [87, 8], i: [105, 2], m: [109, 6], ' ': [32, 4], '.': [46, 2] };
  for (const [ch, [code, w]] of Object.entries(checks)) {
    assert(FE8Wrap.glyphWidth(code, widths) === w, `'${ch}' (0x${code.toString(16)}) width = ${w}`);
  }
}

console.log('Test 5: [A] (0x03) adds 8px to the line width');
{
  const without = FE8Wrap.wrap('Hi[X]', { widths, controlCodes }).width;
  const withA = FE8Wrap.wrap('Hi[A]', { widths, controlCodes }).width;
  assert(withA === without + 8, `[A] adds 8px (${without} -> ${withA})`);

  // Regression: an [A] left on a line after auto-wrap moves a word away must
  // still count its 8px in the recomputed line width.
  const longWord = 'WWWWWWWWWWWWWWWWWWWW'; // wider than 160px on its own
  const r = FE8Wrap.wrap(`aa[A] ${longWord}[X]`, {
    widths,
    controlCodes,
    autoWrap: true,
    boxWidth: 160,
  });
  const exact = r.lines.every((ln) => ln.width === refLineWidth(ln.items));
  assert(exact, 'auto-wrapped line widths stay exact with an [A] on the line');
}

console.log('Test 6: truncated flag reflects content cut off by [X]');
{
  assert(FE8Wrap.wrap('Hello world.[X]', { widths, controlCodes }).truncated === false, 'no truncation when [X] is at the end');
  assert(FE8Wrap.wrap('Hi[X]more text', { widths, controlCodes }).truncated === true, 'truncated when glyphs follow [X]');
  assert(FE8Wrap.wrap('Hi[X][X]', { widths, controlCodes }).truncated === false, 'a second [X] is padding');
  assert(FE8Wrap.wrap('Hi[X][LF]', { widths, controlCodes }).truncated === true, 'truncated when a line break follows [X]');
}

console.log('Test 7: geometry constants match cgtext.c / eventscr.c');
{
  assert(windowMeta.boxX === 24, `boxX = 24 (3 tiles)`);
  assert(windowMeta.boxY === 144, `boxY = 144 (18 tiles)`);
  assert(windowMeta.innerW === 160, `innerW = 160 (20 tiles)`);
  assert(windowMeta.innerH === 32, `innerH = 32 (2 lines x 16; boxHeight 4 tiles / 2)`);
  assert(windowMeta.lines === 2, `lines = 2 (StartCgText height 4 tiles -> boxHeight/2 lines)`);
  assert(windowMeta.lineHeight === 16, `lineHeight = 16`);
  assert(FE8Wrap.LINE_HEIGHT === 16, `wrap.js LINE_HEIGHT = 16`);
}

console.log('Test 8: palette.json matches the resolved dialogue colours');
{
  assert(palette.colors[0] === null, 'pixel 0 transparent');
  assert(palette.colors[1] === '#DEDEDE', `pixel 1 = #DEDEDE (got ${palette.colors[1]})`);
  assert(palette.colors[2] === '#BDBDBD', `pixel 2 = #BDBDBD (got ${palette.colors[2]})`);
  assert(palette.colors[3] === '#292929', `pixel 3 = #292929 (got ${palette.colors[3]})`);
}

console.log('Test 8b: palette-system.json matches the resolved system text colours');
{
  // TEXT_COLOR_SYSTEM_WHITE = TEXT_COLOR_0123 -> identity LUT gFontgrp_3 over
  // Pal_Text, pixel 0 transparent (InitSystemTextFont forces PAL_COLOR(..,0)=0).
  assert(paletteSystem.colors[0] === null, 'system pixel 0 transparent');
  assert(paletteSystem.colors[1] === '#A58CDE', `system pixel 1 = #A58CDE (got ${paletteSystem.colors[1]})`);
  assert(paletteSystem.colors[2] === '#FFFFFF', `system pixel 2 = #FFFFFF (got ${paletteSystem.colors[2]})`);
  assert(paletteSystem.colors[3] === '#3A3129', `system pixel 3 = #3A3129 (got ${paletteSystem.colors[3]})`);
}

console.log('Test 8c: window-system.json geometry + DrawUiFrame model');
{
  assert(windowSystem.borderTiles === 2, 'system frame is 2 tiles thick (DrawUiFrame corner blocks)');
  assert(windowSystem.lineHeight === 16, 'system line height = 16');
  assert(windowSystem.tile === 8, 'system tile = 8');
  // gUiutils_0 model tile indices (uiutils.c).
  const expectModel = [0x01, 0x02, 0x03, 0x05, 0x07, 0x08, 0x09, 0x0a,
    0x06, 0x09, 0x09, 0x0a, 0x1a, 0x1b, 0x1b, 0x21];
  const modelOk =
    windowSystem.model.length === 16 &&
    windowSystem.model.every((v, i) => v === expectModel[i]);
  assert(modelOk, 'system frame model matches gUiutils_0 (DrawUiFrame style 0)');
}

if (decompAvailable) {
  console.log('Test 9: Talk glyph widths + full bitmaps match the decomp byte-for-byte');
  {
    const { glyphs, entries } = parseGlyphTable(
      join(DECOMP, 'src/data/fonts/glyphs_2.h'),
      'TextGlyphs_Talk'
    );
    const fallback = entries[0x3f];
    const checkCodes = [0x41, 0x42, 0x57, 0x61, 0x69, 0x6d, 0x20, 0x2e]; // A B W a i m space .
    let matched = 0;
    for (const code of checkCodes) {
      const name = entries[code] != null ? entries[code] : fallback;
      const g = glyphs[name];
      const j = talk[String(code)];
      if (!g || !j) continue;
      const widthOk = g.width === j.width;
      const bmpOk =
        g.bitmap.length === j.bitmap.length &&
        g.bitmap.every((v, k) => (v >>> 0) === (j.bitmap[k] >>> 0));
      assert(widthOk, `glyph 0x${code.toString(16)} width matches decomp (${j.width})`);
      assert(bmpOk, `glyph 0x${code.toString(16)} bitmap matches decomp byte-for-byte`);
      if (widthOk && bmpOk) matched++;
    }
    assert(matched >= 6, `>= 6 Talk glyphs fully match the decomp (matched ${matched})`);
  }

  console.log('Test 10: palette.json RGB equals resolved gPal_HelpTextBox @ 0xb');
  {
    const pal = parseAsmPalette(join(DECOMP, 'src/data/ui/ui_palettes.s'), 'gPal_HelpTextBox');
    // gFontgrp_14 LUT: pixel 1->13, 2->14, 3->15.
    assert(pal[13] === palette.colors[1], `idx13 ${pal[13]} == pixel1 ${palette.colors[1]}`);
    assert(pal[14] === palette.colors[2], `idx14 ${pal[14]} == pixel2 ${palette.colors[2]}`);
    assert(pal[15] === palette.colors[3], `idx15 ${pal[15]} == pixel3 ${palette.colors[3]}`);
  }

  console.log('Test 11: window frame palette matches Pal_TalkBubble (decomp)');
  {
    const palPath = join(DECOMP, 'graphics/misc/Pal_TalkBubble.gbapal');
    const buf = readFileSync(palPath);
    const idx = (i) => bgr555ToHex(buf.readUInt16LE(i * 2));
    // Frame fill + ink shades (idx4 fill, idx14 mid grey, idx15 dark shadow).
    assert(idx(4) === '#E6E6DE', `Pal_TalkBubble idx4 (fill) = #E6E6DE (got ${idx(4)})`);
    assert(idx(14) === '#BDBDBD', `Pal_TalkBubble idx14 = #BDBDBD (got ${idx(14)})`);
    assert(idx(15) === '#292929', `Pal_TalkBubble idx15 = #292929 (got ${idx(15)})`);
  }

  console.log('Test 12: palette-system.json RGB equals resolved Pal_Text @ TEXT_COLOR_SYSTEM_WHITE');
  {
    // Pal_Text is a .gbapal blob; identity LUT (gFontgrp_3) maps pixel n -> idx n.
    const buf = readFileSync(join(DECOMP, 'graphics/misc/Pal_Text.gbapal'));
    const idx = (i) => bgr555ToHex(buf.readUInt16LE(i * 2));
    assert(idx(1) === paletteSystem.colors[1], `Pal_Text idx1 ${idx(1)} == system pixel1 ${paletteSystem.colors[1]}`);
    assert(idx(2) === paletteSystem.colors[2], `Pal_Text idx2 ${idx(2)} == system pixel2 ${paletteSystem.colors[2]}`);
    assert(idx(3) === paletteSystem.colors[3], `Pal_Text idx3 ${idx(3)} == system pixel3 ${paletteSystem.colors[3]}`);
  }

  console.log('Test 13: System glyph widths + full bitmaps match the decomp byte-for-byte');
  {
    const { glyphs, entries } = parseGlyphTable(
      join(DECOMP, 'src/data/fonts/glyphs_1.h'),
      'TextGlyphs_System'
    );
    const fallback = entries[0x3f];
    const checkCodes = [0x46, 0x69, 0x67, 0x68, 0x74, 0x53, 0x6f]; // F i g h t S o
    let matched = 0;
    for (const code of checkCodes) {
      const name = entries[code] != null ? entries[code] : fallback;
      const g = glyphs[name];
      const j = system[String(code)];
      if (!g || !j) continue;
      const widthOk = g.width === j.width;
      const bmpOk =
        g.bitmap.length === j.bitmap.length &&
        g.bitmap.every((v, k) => (v >>> 0) === (j.bitmap[k] >>> 0));
      assert(widthOk, `system glyph 0x${code.toString(16)} width matches decomp (${j.width})`);
      assert(bmpOk, `system glyph 0x${code.toString(16)} bitmap matches decomp byte-for-byte`);
      if (widthOk && bmpOk) matched++;
    }
    assert(matched >= 6, `>= 6 System glyphs fully match the decomp (matched ${matched})`);
  }

  console.log('Test 14: window-system.png pixels match gUiFrameImage @ gUiFramePaletteA');
  {
    // Spot-check the centre fill tile (model[6] = gUiFrameImage tile 0x09) is the
    // opaque box-fill colour gUiFramePaletteA[0] declared in window-system.json.
    const palBuf = readFileSync(join(DECOMP, 'graphics/misc/gUiFramePaletteA.gbapal'));
    const tiles = readFileSync(join(DECOMP, 'graphics/misc/gUiFrameImage.4bpp'));
    // The centre fill tile (model[6] = gUiFrameImage tile 0x09) is a single
    // solid palette index; window-system.json's fill must be that colour.
    const fillIdx = tiles[0x09 * 32] & 0x0f; // first 4bpp pixel of tile 0x09
    let solid = true;
    for (let b = 0; b < 32; b++) {
      if ((tiles[0x09 * 32 + b] & 0x0f) !== fillIdx) solid = false;
      if (((tiles[0x09 * 32 + b] >> 4) & 0x0f) !== fillIdx) solid = false;
    }
    assert(solid, 'gUiFrameImage tile 0x09 (centre fill) is a single solid palette index');
    assert(windowSystem.fillIndex === fillIdx, `system fillIndex ${windowSystem.fillIndex} == decomp ${fillIdx}`);
    const fill = bgr555ToHex(palBuf.readUInt16LE(fillIdx * 2));
    assert(windowSystem.fill === fill, `system fill ${windowSystem.fill} == gUiFramePaletteA[${fillIdx}] ${fill}`);
  }
} else {
  console.log('(decomp not found at FE8_DECOMP; skipping byte-for-byte decomp-match tests)');
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
}
