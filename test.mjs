// E2E test for the FE8 textbox wrapping engine.
//
//   node test.mjs
//
// Loads the extracted JSON data + wrap.js and runs the wrapping engine on real
// FE8 dialogue strings pulled from fireemblem8u/texts/texts.txt. Asserts that:
//   - [LF] (code 1) forces line breaks
//   - [X] terminates the string
//   - control codes (e.g. [ToggleMouthMove], [.....], [A]) are zero-width
//   - measured widths exactly match summing the Talk glyph widths
//   - auto-wrap produces >= 1 sensible break for a long single-line string

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as FE8Wrap from './wrap.js';

const here = dirname(fileURLToPath(import.meta.url));
const widths = JSON.parse(
  readFileSync(join(here, 'data', 'glyph-widths.json'), 'utf8')
).talk;
const controlCodes = JSON.parse(
  readFileSync(join(here, 'data', 'control-codes.json'), 'utf8')
);

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok   - ${msg}`);
  } else {
    console.error(`  FAIL - ${msg}`);
    failures++;
  }
}

// Reference width sum (the exact GetCgTextDimensions math) for one line of
// items, independent of the engine, to cross-check measured widths.
function refLineWidth(items) {
  let w = 0;
  for (const it of items) {
    if (it.type === 'char') {
      const e = widths[String(it.code)] || widths[String(0x3f)];
      w += e.width;
    }
  }
  return w;
}

// --- Real strings from fireemblem8u/texts/texts.txt ---------------------------

// MSG_149 (Tutorial menu), hand-wrapped with [LF]:
const MSG_149 =
  'For first-timers.[.][LF]Game rules and[LF]controls will be[LF]explained as you[LF]play.[.][X]';

// MSG with embedded zero-width control codes (cutscene line):
const CUTSCENE =
  'And his companion[.][ToggleMouthMove]...[.][ToggleMouthMove][.....]must be Lady Eirika![A][X]';

// A long single-segment string (no line breaks) to exercise auto-wrap:
const LONG =
  'The Demon King once threatened to engulf the whole of Magvel in darkness ' +
  'but was sealed away by the Sacred Stones long ago.[X]';

console.log('Test 1: [LF] forces line breaks, [X] terminates');
{
  const r = FE8Wrap.wrap(MSG_149, { widths, controlCodes });
  assert(r.lines.length === 5, `MSG_149 wraps to 5 lines (got ${r.lines.length})`);
  assert(r.height === 5 * FE8Wrap.LINE_HEIGHT, `height = 5 * 16 = ${r.height}`);
  // First line should read "For first-timers." (the [.] is zero-width)
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
  // No [ToggleMouthMove]/[A]/[X] should contribute width.
  const hasCtrl = line.items.some((it) => it.type === 'ctrl');
  assert(hasCtrl, 'control codes are present in the token stream');
  // width must equal sum of just the literal characters
  let charOnly = 0;
  for (const it of line.items) {
    if (it.type === 'char') charOnly += (widths[String(it.code)] || widths['63']).width;
  }
  assert(line.width === charOnly, `width counts glyphs only (${line.width} == ${charOnly})`);
}

console.log('Test 3: auto-wrap breaks a long string into >= 2 lines');
{
  // Pick a box width narrower than the unwrapped string but wide enough for words.
  const unwrapped = FE8Wrap.measure(LONG, { widths, controlCodes });
  const boxWidth = 224; // typical dialogue text area (see README)
  assert(unwrapped.width > boxWidth, `unwrapped width ${unwrapped.width}px exceeds box ${boxWidth}px`);
  const r = FE8Wrap.wrap(LONG, { widths, controlCodes, autoWrap: true, boxWidth });
  assert(r.lines.length >= 2, `auto-wrap yields >= 2 lines (got ${r.lines.length})`);
  // Every wrapped line must fit within the box width.
  const allFit = r.lines.every((ln) => ln.width <= boxWidth);
  assert(allFit, 'every auto-wrapped line fits within boxWidth');
  // No word should be split across lines (no line should start mid-word for a
  // word that would have fit): widths still exact.
  const exact = r.lines.every((ln) => ln.width === refLineWidth(ln.items));
  assert(exact, 'auto-wrapped line widths remain exact');
}

console.log('Test 4: known per-glyph widths (spot check vs decomp)');
{
  const checks = { A: [65, 6], W: [87, 8], i: [105, 2], m: [109, 6], ' ': [32, 4], '.': [46, 2] };
  for (const [ch, [code, w]] of Object.entries(checks)) {
    assert(FE8Wrap.glyphWidth(code, widths) === w, `'${ch}' (0x${code.toString(16)}) width = ${w}`);
  }
}

console.log('Test 5: truncated flag reflects content cut off by [X]');
{
  const clean = FE8Wrap.wrap('Hello world.[X]', { widths, controlCodes });
  assert(clean.truncated === false, 'no truncation when [X] is at the end');

  const cut = FE8Wrap.wrap('Hi[X]more text', { widths, controlCodes });
  assert(cut.truncated === true, 'truncated when glyphs follow [X]');
  assert(cut.lines.length === 1, 'content after [X] is not laid out');

  const padded = FE8Wrap.wrap('Hi[X][X]', { widths, controlCodes });
  assert(padded.truncated === false, 'a second [X] is padding, not lost text');

  const cutByBreak = FE8Wrap.wrap('Hi[X][LF]', { widths, controlCodes });
  assert(cutByBreak.truncated === true, 'truncated when a line break follows [X]');
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
}
