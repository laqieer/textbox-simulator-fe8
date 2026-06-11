// FE8 Textbox Simulator — browser UI.
//
// Loads the extracted glyph/control data, runs the shared wrapping engine
// (wrap.js), and renders the wrapped result to a canvas using the real FE8
// 16x16 2bpp glyph bitmaps.

import * as FE8Wrap from './wrap.js';

const GLYPH_ROWS = 16; // glyph cell is 16px tall
const LINE_HEIGHT = FE8Wrap.LINE_HEIGHT; // 16px between baselines

const el = {
  text: document.getElementById('text'),
  boxWidthTiles: document.getElementById('boxWidthTiles'),
  boxWidthPx: document.getElementById('boxWidthPx'),
  boxHeight: document.getElementById('boxHeight'),
  zoom: document.getElementById('zoom'),
  autoWrap: document.getElementById('autoWrap'),
  showGuides: document.getElementById('showGuides'),
  canvas: document.getElementById('canvas'),
  stats: document.getElementById('stats'),
  status: document.getElementById('status'),
  quickcodes: document.getElementById('quickcodes'),
};

const ctx = el.canvas.getContext('2d');

let widths = null; // talk width+bitmap table: code -> { width, bitmap[16] }
let controlCodes = null;

async function loadData() {
  const [w, c] = await Promise.all([
    fetch('data/glyph-widths.json').then((r) => {
      if (!r.ok) throw new Error(`glyph-widths.json: ${r.status}`);
      return r.json();
    }),
    fetch('data/control-codes.json').then((r) => {
      if (!r.ok) throw new Error(`control-codes.json: ${r.status}`);
      return r.json();
    }),
  ]);
  widths = w.talk;
  controlCodes = c;
}

// Decode one 16x16 2bpp glyph bitmap row -> per-pixel value (0..3), leftmost
// pixel is the least-significant 2 bits (verified against the decomp glyphs).
function pixelValue(row, x) {
  return (row >>> (x * 2)) & 0x3;
}

function boxWidthPx() {
  return Math.max(1, parseInt(el.boxWidthTiles.value, 10) || 1) * 8;
}

function render() {
  if (!widths) return;

  const bw = boxWidthPx();
  el.boxWidthPx.textContent = String(bw);
  const lineCount = Math.max(1, parseInt(el.boxHeight.value, 10) || 1);
  const zoom = Math.max(1, Math.min(8, parseInt(el.zoom.value, 10) || 1));
  const autoWrap = el.autoWrap.checked;
  const showGuides = el.showGuides.checked;

  const result = FE8Wrap.wrap(el.text.value, {
    widths,
    controlCodes,
    autoWrap,
    boxWidth: bw,
  });

  // Canvas logical size: box width, and at least the configured line count.
  const drawLines = Math.max(lineCount, result.lines.length);
  const logicalW = bw;
  const logicalH = drawLines * LINE_HEIGHT;

  el.canvas.width = logicalW;
  el.canvas.height = logicalH;
  el.canvas.style.width = `${logicalW * zoom}px`;
  el.canvas.style.height = `${logicalH * zoom}px`;

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, logicalW, logicalH);

  // Guides: line separators + overflow shading beyond the configured height.
  if (showGuides) {
    for (let i = 1; i < drawLines; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(0, i * LINE_HEIGHT - 1, logicalW, 1);
    }
    if (result.lines.length > lineCount) {
      ctx.fillStyle = 'rgba(255,80,80,0.12)';
      ctx.fillRect(0, lineCount * LINE_HEIGHT, logicalW, (result.lines.length - lineCount) * LINE_HEIGHT);
    }
  }

  // Draw glyphs.
  const ink = getComputedStyle(document.documentElement)
    .getPropertyValue('--glyph')
    .trim() || '#ffffff';
  ctx.fillStyle = ink;

  result.lines.forEach((line, li) => {
    let penX = 0;
    const top = li * LINE_HEIGHT;
    for (const item of line.items) {
      if (item.type !== 'char') continue; // control/raw: zero width, no glyph
      const entry = widths[String(item.code)] || widths[String(0x3f)];
      const bmp = entry.bitmap || [];
      const w = entry.width;
      for (let y = 0; y < GLYPH_ROWS; y++) {
        const row = bmp[y] | 0;
        if (row === 0) continue;
        // Only paint within the glyph's advance width (cells are 16 wide but
        // the visible glyph occupies `width` px on the left).
        const limit = Math.min(16, Math.max(w, 1) + 1);
        for (let x = 0; x < limit; x++) {
          if (pixelValue(row, x) !== 0) {
            ctx.fillRect(penX + x, top + y, 1, 1);
          }
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
  ['input', 'change'].forEach((ev) => {
    el.text.addEventListener(ev, render);
    el.boxWidthTiles.addEventListener(ev, render);
    el.boxHeight.addEventListener(ev, render);
    el.zoom.addEventListener(ev, render);
    el.autoWrap.addEventListener(ev, render);
    el.showGuides.addEventListener(ev, render);
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
      'Font data loaded. Default box: 20 tiles (160px) × 4 lines — the FE8 event dialogue box.';
    wire();
    render();
  } catch (err) {
    el.status.textContent =
      `Failed to load font data (${err.message}). Serve over HTTP: python3 -m http.server`;
    el.status.classList.add('error');
  }
})();
