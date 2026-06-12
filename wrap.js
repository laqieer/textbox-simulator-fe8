// FE8 textbox line-wrapping engine.
//
// Mirrors the FE8 (fireemblem8u) dialogue text path. FE8 (US) runs the text
// engine in LANG_ENGLISH mode, so glyph advance is the ASCII path in
// src/fontgrp.c: one byte per glyph, width = TextGlyphs_Talk[byte]->width,
// with a fallback to the '?' glyph for NULL entries. Line geometry follows
// GetCgTextBoxDimensions / GetCgTextDimensions in src/cgtext.c:
//   [NL]  (1)  -> forced line break (new line, +16px height)
//   [NL2] (2)  -> forced line break (paragraph / new page)
//   [X]   (0)  -> end of string
//   [0x80, xx] -> two-byte control code, consumed, no width
//   other ctrl -> single-byte control code, consumed, no width
//
// In the real game the script is hand-wrapped with explicit [NL] codes; the
// engine itself never auto-wraps. This simulator also offers an *optional*
// auto-wrap on pixel width (word-aware) so you can preview how wide a line is
// getting against the box. Auto-wrap is layered on top of the exact width math
// and never changes measured widths.
//
// Exposed as a UMD-ish pure module: works as an ES module (browser/Node) and
// attaches to globalThis.FE8Wrap for plain <script> use.

const LINE_HEIGHT = 16; // px per line, matches GetCgTextBoxDimensions

// Parse "[Name]" tokens out of an FE8 text string. Returns a flat token list:
//   { type: 'char', code }                 a literal byte (glyph)
//   { type: 'ctrl', name, bytes, layout }  a resolved control code
//   { type: 'raw',  name }                 an unknown [Name] (kept verbatim)
function tokenize(text, controlCodes) {
  const tokens = [];
  const re = /\[([^\]]*)\]/g;
  let pos = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    // literal text before this control code
    for (let i = pos; i < m.index; i++) {
      tokens.push({ type: 'char', code: text.charCodeAt(i) & 0xff });
    }
    const name = m[1];
    const def = controlCodes && controlCodes[name];
    if (def) {
      tokens.push({ type: 'ctrl', name, bytes: def.bytes, layout: def.layout });
    } else {
      tokens.push({ type: 'raw', name });
    }
    pos = re.lastIndex;
  }
  for (let i = pos; i < text.length; i++) {
    tokens.push({ type: 'char', code: text.charCodeAt(i) & 0xff });
  }
  return tokens;
}

// Width (px) of a single byte code via the Talk glyph table, with '?' fallback.
function glyphWidth(code, widths) {
  const entry = widths[String(code)];
  if (entry && typeof entry.width === 'number') return entry.width;
  const q = widths[String(0x3f)]; // '?'
  return q ? q.width : 0;
}

// Layout-advance width (px) of a single laid-out item: a glyph's advance for a
// char, +8 for an [A]/advance8 control, 0 otherwise. Single source of truth so
// that the auto-wrap line-width recomputes stay consistent with the engine.
function itemWidth(item, widths) {
  if (item.type === 'char') return glyphWidth(item.code, widths);
  if (item.type === 'ctrl' && item.layout === 'advance8') return 8;
  return 0;
}

// Core wrap. Returns:
//   { lines: [ { items: [...], width } ], width, height, truncated }
// where items are the laid-out tokens for a line (chars + zero-width ctrls).
// `truncated` is true when an [X] terminator cuts off rendered content that
// follows it (more glyphs or a line break before any subsequent [X]).
//
// options:
//   widths       (required) Talk width table: code -> { width, bitmap }
//   controlCodes (required) name -> { bytes, layout }
//   boxWidth     (px) used only when autoWrap is true
//   autoWrap     (bool) break lines when they exceed boxWidth at word boundaries
function wrap(text, options) {
  const widths = options.widths;
  const controlCodes = options.controlCodes || {};
  const autoWrap = !!options.autoWrap;
  const boxWidth = options.boxWidth || 0;

  const tokens = tokenize(text, controlCodes);

  const lines = [];
  let cur = { items: [], width: 0 };
  let truncated = false;

  const pushLine = () => {
    lines.push(cur);
    cur = { items: [], width: 0 };
  };

  // For word-aware auto-wrap we track the start index of the current word
  // within cur.items and its pixel width, so we can move a too-long word to
  // the next line whole.
  let wordStart = 0; // index in cur.items where the current word began
  let wordWidth = 0; // px width of the current (unbroken) word

  const resetWord = () => {
    wordStart = cur.items.length;
    wordWidth = 0;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.type === 'ctrl') {
      if (tok.layout === 'end') {
        // [X] terminates the string. If any layout-affecting content follows
        // (more glyphs or line breaks before the next [X], if any), it is cut
        // off and never rendered -- flag that for callers.
        for (let j = i + 1; j < tokens.length; j++) {
          const rest = tokens[j];
          if (rest.type === 'char' && glyphWidth(rest.code, widths) > 0) {
            truncated = true;
            break;
          }
          if (
            rest.type === 'ctrl' &&
            (rest.layout === 'newline' || rest.layout === 'newline2')
          ) {
            truncated = true;
            break;
          }
          if (rest.type === 'ctrl' && rest.layout === 'end') {
            break; // a second [X]: trailing data is just padding, not "lost" text
          }
        }
        break; // [X] terminates
      }
      if (tok.layout === 'newline' || tok.layout === 'newline2') {
        pushLine();
        resetWord();
        continue;
      }
      if (tok.layout === 'advance8') {
        // [A] (0x03): adds 8px to the line width (GetCgTextBoxDimensions
        // case 0x03: `w += 8`). Treated as a word boundary, like a space.
        cur.items.push(tok);
        cur.width += 8;
        resetWord();
        continue;
      }
      // any other control code: consumed, zero width, no layout effect
      cur.items.push(tok);
      continue;
    }

    if (tok.type === 'raw') {
      // unknown [Name]: keep it but treat as zero-width / non-layout
      cur.items.push(tok);
      continue;
    }

    // tok.type === 'char'
    const w = glyphWidth(tok.code, widths);
    const isSpace = tok.code === 0x20;

    if (autoWrap && boxWidth > 0 && !isSpace) {
      // Would adding this glyph overflow the box?
      if (cur.width + w > boxWidth && cur.items.length > 0) {
        // Break before the current word if it fits on its own line,
        // otherwise hard-break here.
        if (wordStart > 0 && wordWidth + w <= boxWidth) {
          const moved = cur.items.splice(wordStart);
          // recompute current line width after removing the moved word
          cur.width = 0;
          for (const it of cur.items) cur.width += itemWidth(it, widths);
          // trim a trailing space left on the line
          while (
            cur.items.length &&
            cur.items[cur.items.length - 1].type === 'char' &&
            cur.items[cur.items.length - 1].code === 0x20
          ) {
            const sp = cur.items.pop();
            cur.width -= glyphWidth(sp.code, widths);
          }
          pushLine();
          // start the new line with the moved word
          let newW = 0;
          for (const it of moved) newW += itemWidth(it, widths);
          cur.items = moved;
          cur.width = newW;
          wordStart = 0;
          wordWidth = newW;
        } else {
          pushLine();
          resetWord();
        }
      }
    }

    cur.items.push(tok);
    cur.width += w;
    if (isSpace) {
      resetWord();
    } else {
      wordWidth += w;
    }
  }

  pushLine();

  let maxWidth = 0;
  for (const ln of lines) if (ln.width > maxWidth) maxWidth = ln.width;
  const height = lines.length * LINE_HEIGHT;

  return { lines, width: maxWidth, height, truncated };
}

// Convenience: measured width (px) of the longest line and total height,
// matching GetCgTextBoxDimensions semantics (no auto-wrap).
function measure(text, options) {
  const r = wrap(text, Object.assign({}, options, { autoWrap: false }));
  return { width: r.width, height: r.height, lines: r.lines.length };
}

const api = { tokenize, glyphWidth, wrap, measure, LINE_HEIGHT };

// Attach to global for plain <script> usage.
if (typeof globalThis !== 'undefined') {
  globalThis.FE8Wrap = api;
}

export { tokenize, glyphWidth, wrap, measure, LINE_HEIGHT };
export default api;
