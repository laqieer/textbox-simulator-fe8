// Deterministic screenshot generator for the FE8 textbox simulator.
//
//   node tools/screenshot.mjs
//
// Reuses the SAME wrapping engine (wrap.js) and the SAME glyph/palette/window
// data the browser uses, and renders to a PNG with @napi-rs/canvas. This is the
// deterministic fallback to a headless-browser screenshot: it draws the exact
// pixel buffer the app draws (shaded glyphs through the real dialogue palette,
// inside the real FE8 window frame), so the committed docs/preview-*.png are
// reproducible regardless of browser availability.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as FE8Wrap from '../wrap.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const data = (f) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'));

const talk = data('glyphs-talk.json');
const system = data('glyphs-system.json');
const controlCodes = data('control-codes.json');
const palette = data('palette.json').colors;
const windowMeta = data('window.json');
const glyphTables = { talk, system };

const T = windowMeta.tile;

function pixelValue(row, x) {
  return (row >>> (x * 2)) & 0x3;
}

function drawFrame(ctx, img, originX, originY, innerW, innerH) {
  const slots = { corner: 0, top: 1, left: 2, fill: 3 };
  const fx = originX - T;
  const fy = originY - T;
  const fw = innerW + 2 * T;
  const fh = innerH + 2 * T;
  const slice = (slot, x, y, flipX, flipY) => {
    ctx.save();
    ctx.translate(x + (flipX ? T : 0), y + (flipY ? T : 0));
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    ctx.drawImage(img, slot * T, 0, T, T, 0, 0, T, T);
    ctx.restore();
  };
  for (let y = fy + T; y < fy + fh - T; y += T)
    for (let x = fx + T; x < fx + fw - T; x += T) slice(slots.fill, x, y, false, false);
  for (let x = fx + T; x < fx + fw - T; x += T) {
    slice(slots.top, x, fy, false, false);
    slice(slots.top, x, fy + fh - T, false, true);
  }
  for (let y = fy + T; y < fy + fh - T; y += T) {
    slice(slots.left, fx, y, false, false);
    slice(slots.left, fx + fw - T, y, true, false);
  }
  slice(slots.corner, fx, fy, false, false);
  slice(slots.corner, fx + fw - T, fy, true, false);
  slice(slots.corner, fx, fy + fh - T, false, true);
  slice(slots.corner, fx + fw - T, fy + fh - T, true, true);
}

async function renderPNG({ text, group = 'talk', boxTiles = 20, lines = 4, zoom = 4 }) {
  const widths = glyphTables[group];
  const img = await loadImage(join(root, 'data', 'window.png'));

  const innerW = boxTiles * 8;
  const result = FE8Wrap.wrap(text, { widths, controlCodes, boxWidth: innerW });
  const drawLines = Math.max(lines, result.lines.length);
  const innerH = drawLines * windowMeta.lineHeight;

  const border = T;
  const logicalW = innerW + 2 * border;
  const logicalH = innerH + 2 * border;

  const canvas = createCanvas(logicalW * zoom, logicalH * zoom);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.scale(zoom, zoom);
  // GBA-screen backdrop.
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, logicalW, logicalH);

  const originX = border;
  const originY = border;
  drawFrame(ctx, img, originX, originY, innerW, innerH);

  const inset = windowMeta.textInsetX;
  result.lines.forEach((line, li) => {
    let penX = originX + inset;
    const top = originY + li * windowMeta.lineHeight;
    for (const item of line.items) {
      if (item.type !== 'char') continue;
      const entry = widths[String(item.code)] || widths[String(0x3f)];
      const bmp = entry.bitmap || [];
      for (let y = 0; y < 16; y++) {
        const rowv = bmp[y] | 0;
        if (rowv === 0) continue;
        for (let x = 0; x < 16; x++) {
          const v = pixelValue(rowv, x);
          if (v === 0) continue;
          const color = palette[v];
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(penX + x, top + y, 1, 1);
        }
      }
      penX += entry.width;
    }
  });

  return canvas.toBuffer('image/png');
}

const previews = [
  {
    file: 'preview-1.png',
    text: 'For first-timers.[.][LF]Game rules and[LF]controls will be[LF]explained as you[LF]play.[.][X]',
  },
  {
    file: 'preview-2.png',
    text: 'The Demon King once[LF]threatened to engulf[LF]Magvel in darkness,[LF]but was sealed away.[X]',
  },
];

for (const p of previews) {
  const buf = await renderPNG({ text: p.text });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(root, 'docs', p.file), buf);
  console.log(`wrote docs/${p.file} (${buf.length} bytes)`);
}
