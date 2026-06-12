// FE8 Textbox Simulator — browser UI.
//
// Loads the decomp-extracted glyph/palette/window data, runs the shared
// wrapping engine (wrap.js), and renders the wrapped result to a canvas using
// the real FE8 16x16 2bpp glyph bitmaps mapped through the real 4-colour
// dialogue palette (gPal_HelpTextBox @ colorId 0xb), inside the real FE8
// dialogue window frame (Img_TalkBubble + Pal_TalkBubble).

import * as FE8Wrap from './wrap.js';

const GLYPH_ROWS = 16; // glyph cell is 16px tall
const LINE_HEIGHT = FE8Wrap.LINE_HEIGHT; // 16px between baselines

const el = {
  text: document.getElementById('text'),
  fontGroup: document.getElementById('fontGroup'),
  boxWidthTiles: document.getElementById('boxWidthTiles'),
  boxWidthPx: document.getElementById('boxWidthPx'),
  boxHeight: document.getElementById('boxHeight'),
  zoom: document.getElementById('zoom'),
  autoWrap: document.getElementById('autoWrap'),
  showFrame: document.getElementById('showFrame'),
  canvas: document.getElementById('canvas'),
  stats: document.getElementById('stats'),
  status: document.getElementById('status'),
  quickcodes: document.getElementById('quickcodes'),
};

const ctx = el.canvas.getContext('2d');

let glyphTables = null; // { talk, system }
let controlCodes = null;
let palette = null; // [null/transparent, "#..", "#..", "#.."]
let windowMeta = null;
let windowImg = null; // HTMLImageElement of data/window.png

async function loadData() {
  const fetchJSON = (p) =>
    fetch(p).then((r) => {
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return r.json();
    });
  const [talk, system, c, pal, win] = await Promise.all([
    fetchJSON('data/glyphs-talk.json'),
    fetchJSON('data/glyphs-system.json'),
    fetchJSON('data/control-codes.json'),
    fetchJSON('data/palette.json'),
    fetchJSON('data/window.json'),
  ]);
  glyphTables = { talk, system };
  controlCodes = c;
  palette = pal.colors;
  windowMeta = win;
  windowImg = await loadImage('data/window.png');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

function activeWidths() {
  return glyphTables[el.fontGroup ? el.fontGroup.value : 'talk'] || glyphTables.talk;
}

// Decode one 16x16 2bpp glyph bitmap row -> per-pixel value (0..3), leftmost
// pixel is the least-significant 2 bits (verified against the decomp glyphs).
function pixelValue(row, x) {
  return (row >>> (x * 2)) & 0x3;
}

function boxWidthPx() {
  return Math.max(1, parseInt(el.boxWidthTiles.value, 10) || 1) * 8;
}

// Draw the real FE8 dialogue window frame (9-slice from window.png) into a
// region of the canvas. window.png contains 4 base 8x8 tiles laid out
// horizontally: [corner, top-edge, left-edge, fill]. Other corners/edges are
// produced by H/V flips, exactly as PutTalkBubbleTm does with TILEREF flips.
function drawFrame(originX, originY, innerW, innerH) {
  const T = windowMeta.tile; // 8
  const cornerS = 0 * T;
  const topS = 1 * T;
  const leftS = 2 * T;
  const fillS = 3 * T;

  const fx = originX - T;
  const fy = originY - T;
  const fw = innerW + 2 * T;
  const fh = innerH + 2 * T;

  const slice = (sx, x, y, flipX, flipY) => {
    ctx.save();
    ctx.translate(x + (flipX ? T : 0), y + (flipY ? T : 0));
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    ctx.drawImage(windowImg, sx, 0, T, T, 0, 0, T, T);
    ctx.restore();
  };

  // Interior fill.
  for (let y = fy + T; y < fy + fh - T; y += T) {
    for (let x = fx + T; x < fx + fw - T; x += T) {
      slice(fillS, x, y, false, false);
    }
  }
  // Top + bottom edges.
  for (let x = fx + T; x < fx + fw - T; x += T) {
    slice(topS, x, fy, false, false);
    slice(topS, x, fy + fh - T, false, true);
  }
  // Left + right edges.
  for (let y = fy + T; y < fy + fh - T; y += T) {
    slice(leftS, fx, y, false, false);
    slice(leftS, fx + fw - T, y, true, false);
  }
  // Corners (TL as-is, TR=Hflip, BL=Vflip, BR=HVflip).
  slice(cornerS, fx, fy, false, false);
  slice(cornerS, fx + fw - T, fy, true, false);
  slice(cornerS, fx, fy + fh - T, false, true);
  slice(cornerS, fx + fw - T, fy + fh - T, true, true);
}

function render() {
  if (!glyphTables) return;

  const widths = activeWidths();
  const bw = boxWidthPx();
  el.boxWidthPx.textContent = String(bw);
  const lineCount = Math.max(1, parseInt(el.boxHeight.value, 10) || 1);
  const zoom = Math.max(1, Math.min(8, parseInt(el.zoom.value, 10) || 1));
  const autoWrap = el.autoWrap.checked;
  const showFrame = el.showFrame ? el.showFrame.checked : true;

  const result = FE8Wrap.wrap(el.text.value, {
    widths,
    controlCodes,
    autoWrap,
    boxWidth: bw,
  });

  const T = windowMeta.tile;
  const inset = windowMeta.textInsetX;
  const drawLines = Math.max(lineCount, result.lines.length);
  const innerW = bw;
  const innerH = drawLines * LINE_HEIGHT;

  const border = showFrame ? T : 0;
  const logicalW = innerW + 2 * border;
  const logicalH = innerH + 2 * border;

  el.canvas.width = logicalW;
  el.canvas.height = logicalH;
  el.canvas.style.width = `${logicalW * zoom}px`;
  el.canvas.style.height = `${logicalH * zoom}px`;

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, logicalW, logicalH);

  const originX = border;
  const originY = border;

  if (showFrame) {
    drawFrame(originX, originY, innerW, innerH);
  }

  // Draw glyphs, mapping pixel values 0..3 -> palette (0 transparent).
  result.lines.forEach((line, li) => {
    let penX = originX + inset;
    const top = originY + li * LINE_HEIGHT;
    for (const item of line.items) {
      if (item.type !== 'char') continue; // control/raw: zero width, no glyph
      const entry = widths[String(item.code)] || widths[String(0x3f)];
      const bmp = entry.bitmap || [];
      const w = entry.width;
      for (let y = 0; y < GLYPH_ROWS; y++) {
        const row = bmp[y] | 0;
        if (row === 0) continue;
        for (let x = 0; x < 16; x++) {
          const v = pixelValue(row, x);
          if (v === 0) continue; // transparent
          const color = palette[v];
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(penX + x, top + y, 1, 1);
        }
      }
      penX += w;
    }
  });

  const overflowW = result.width > bw;
  const overflowH = result.lines.length > lineCount;
  el.stats.textContent =
    `lines: ${result.lines.length} / ${lineCount}` +
    `  ·  widest line: ${result.width}px / ${bw}px` +
    (overflowW ? '  ⚠ width overflow' : '') +
    (overflowH ? '  ⚠ too many lines' : '');
  el.stats.style.color = overflowW || overflowH ? '#ffb0b0' : '';
}

function insertAtCursor(textarea, snippet) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const v = textarea.value;
  textarea.value = v.slice(0, start) + snippet + v.slice(end);
  const pos = start + snippet.length;
  textarea.setSelectionRange(pos, pos);
  textarea.focus();
}

function wire() {
  const inputs = [
    el.text,
    el.fontGroup,
    el.boxWidthTiles,
    el.boxHeight,
    el.zoom,
    el.autoWrap,
    el.showFrame,
  ].filter(Boolean);
  ['input', 'change'].forEach((ev) => {
    inputs.forEach((node) => node.addEventListener(ev, render));
  });
  el.quickcodes.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-code]');
    if (!btn) return;
    insertAtCursor(el.text, btn.dataset.code);
    render();
  });
}

(async function main() {
  try {
    await loadData();
    el.status.textContent =
      'Assets loaded from the fireemblem8u decomp. Default box: 20 tiles (160px) × 2 lines — the FE8 event dialogue box.';
    wire();
    render();
  } catch (err) {
    el.status.textContent =
      `Failed to load data (${err.message}). Serve over HTTP: python3 -m http.server`;
    el.status.classList.add('error');
  }
})();
