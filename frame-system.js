// FE8 system (menu / help) window frame renderer.
//
// Replicates src/uiutils.c DrawUiFrame (style 0 / gUiutils_0): the canonical FE8
// menu window. The frame is a tile grid with 2-tile-thick borders. Each of the
// 16 model entries selects an 8x8 tile from window-system.png (slot order == the
// gUiutils_0 model order extracted by extract.py). Unlike the rounded talk
// bubble there are no H/V flips -- every position has a distinct tile.
//
// DrawUiFrame draws onto a width x height tile grid (both even). Model index ->
// position follows the decomp comments:
//   model[0,1,4,5] top-left 2x2 corner block
//   model[2]       top edge        model[3]  top-right corner
//   model[6]       interior fill (sub-row iy, both cols)
//   model[7]       right edge (sub-row iy)
//   model[8]       left edge (both sub-rows)
//   model[9]       interior fill (sub-row iy+1, col 0)
//   model[10]      interior fill (sub-row iy+1, col 1)
//   model[11]      right edge (sub-row iy+1)
//   model[12]      bottom-left     model[13],[14] bottom edge
//   model[15]      bottom-right
//
// Exposed as an ES module and on globalThis for plain <script> use.

const TILE = 8;

// Draw one strip tile (slot index) at (x, y) with optional 2x scale handled by
// the caller's ctx transform. `img` is window-system.png.
function blitSlot(ctx, img, slot, x, y) {
  ctx.drawImage(img, slot * TILE, 0, TILE, TILE, x, y, TILE, TILE);
}

// Draw the system frame. (originX, originY) is the inner text-area top-left in
// canvas pixels; (innerW, innerH) is the inner area in pixels. The 2-tile border
// is drawn outside that region. `meta` is window-system.json. Returns nothing.
function drawSystemFrame(ctx, img, meta, originX, originY, innerW, innerH) {
  const T = meta.tile || TILE;
  const border = (meta.borderTiles || 2) * T;
  const m = meta.model.map((_, i) => i); // strip slots are 1:1 with model order

  // Frame rectangle in tile units.
  const x = 0;
  const y = 0;
  const widthTiles = (innerW + 2 * border) / T;
  const heightTiles = (innerH + 2 * border) / T;
  const xMax = x + widthTiles - 1;
  const yMax = y + heightTiles - 1;

  const fx = originX - border;
  const fy = originY - border;
  const px = (tx) => fx + tx * T;
  const py = (ty) => fy + ty * T;

  // Interior fill + left/right edges, two tile-rows at a time.
  for (let iy = y + 1; iy < yMax; iy += 2) {
    for (let ix = x + 1; ix < xMax; ix += 2) {
      blitSlot(ctx, img, m[6], px(ix), py(iy)); // center
      blitSlot(ctx, img, m[6], px(ix + 1), py(iy)); // center
      blitSlot(ctx, img, m[9], px(ix), py(iy + 1)); // fill (0,1)
      blitSlot(ctx, img, m[10], px(ix + 1), py(iy + 1)); // fill (1,1)
    }
    blitSlot(ctx, img, m[8], px(x), py(iy)); // left edge
    blitSlot(ctx, img, m[7], px(xMax), py(iy)); // right edge 0
    blitSlot(ctx, img, m[8], px(x), py(iy + 1)); // left edge
    blitSlot(ctx, img, m[11], px(xMax), py(iy + 1)); // right edge 1
  }

  // Top + bottom edges, two tile-cols at a time.
  for (let ix = x + 1; ix < xMax; ix += 2) {
    blitSlot(ctx, img, m[2], px(ix), py(y)); // top
    blitSlot(ctx, img, m[2], px(ix + 1), py(y)); // top
    blitSlot(ctx, img, m[13], px(ix), py(yMax)); // bottom (0,1)
    blitSlot(ctx, img, m[14], px(ix + 1), py(yMax)); // bottom (1,1)
  }

  // Corners.
  blitSlot(ctx, img, m[0], px(x), py(y)); // TL (0,0)
  blitSlot(ctx, img, m[1], px(x + 1), py(y)); // TL (1,0)
  blitSlot(ctx, img, m[4], px(x), py(y + 1)); // TL (0,1)
  blitSlot(ctx, img, m[5], px(x + 1), py(y + 1)); // TL (1,1)
  blitSlot(ctx, img, m[3], px(xMax), py(y)); // top-right
  blitSlot(ctx, img, m[12], px(x), py(yMax)); // bottom-left
  blitSlot(ctx, img, m[15], px(xMax), py(yMax)); // bottom-right
}

// Pixels of border on each side, for canvas sizing.
function systemBorderPx(meta) {
  return (meta.borderTiles || 2) * (meta.tile || TILE);
}

const api = { drawSystemFrame, systemBorderPx, TILE };

if (typeof globalThis !== 'undefined') {
  globalThis.FE8SystemFrame = api;
}

export { drawSystemFrame, systemBorderPx, TILE };
export default api;
