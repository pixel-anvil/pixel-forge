/** Glyph width of the built-in bitmap font, in font pixels. */
export const FONT_W = 3;
/** Glyph height of the built-in bitmap font, in font pixels. */
export const FONT_H = 5;

/** Tiny hard-coded 3x5 font: digits, A-Z and a few symbols. Each glyph is 5 rows of 3 chars, `#` = on. */
const ROWS: Record<string, readonly string[]> = {
  '0': ['###', '# #', '# #', '# #', '###'],
  '1': [' # ', '## ', ' # ', ' # ', '###'],
  '2': ['###', '  #', '###', '#  ', '###'],
  '3': ['###', '  #', '###', '  #', '###'],
  '4': ['# #', '# #', '###', '  #', '  #'],
  '5': ['###', '#  ', '###', '  #', '###'],
  '6': ['###', '#  ', '###', '# #', '###'],
  '7': ['###', '  #', '  #', ' # ', ' # '],
  '8': ['###', '# #', '###', '# #', '###'],
  '9': ['###', '# #', '###', '  #', '###'],
  A: [' # ', '# #', '###', '# #', '# #'],
  B: ['## ', '# #', '## ', '# #', '## '],
  C: ['###', '#  ', '#  ', '#  ', '###'],
  D: ['## ', '# #', '# #', '# #', '## '],
  E: ['###', '#  ', '###', '#  ', '###'],
  F: ['###', '#  ', '###', '#  ', '#  '],
  G: ['###', '#  ', '# #', '# #', '###'],
  H: ['# #', '# #', '###', '# #', '# #'],
  I: ['###', ' # ', ' # ', ' # ', '###'],
  J: ['  #', '  #', '  #', '# #', '###'],
  K: ['# #', '# #', '## ', '# #', '# #'],
  L: ['#  ', '#  ', '#  ', '#  ', '###'],
  M: ['# #', '###', '###', '# #', '# #'],
  N: ['## ', '# #', '# #', '# #', '# #'],
  O: ['###', '# #', '# #', '# #', '###'],
  P: ['###', '# #', '###', '#  ', '#  '],
  Q: ['###', '# #', '# #', '###', '  #'],
  R: ['###', '# #', '## ', '# #', '# #'],
  S: ['###', '#  ', '###', '  #', '###'],
  T: ['###', ' # ', ' # ', ' # ', ' # '],
  U: ['# #', '# #', '# #', '# #', '###'],
  V: ['# #', '# #', '# #', '# #', ' # '],
  W: ['# #', '# #', '###', '###', '# #'],
  X: ['# #', '# #', ' # ', '# #', '# #'],
  Y: ['# #', '# #', ' # ', ' # ', ' # '],
  Z: ['###', '  #', ' # ', '#  ', '###'],
  '-': ['   ', '   ', '###', '   ', '   '],
  _: ['   ', '   ', '   ', '   ', '###'],
  '.': ['   ', '   ', '   ', '   ', ' # '],
  ':': ['   ', ' # ', '   ', ' # ', '   '],
  '/': ['  #', '  #', ' # ', '#  ', '#  '],
  ' ': ['   ', '   ', '   ', '   ', '   '],
};
const UNKNOWN: readonly string[] = ['###', '# #', '# #', '# #', '###'];

/** Rows of `#`/space for a character (lower case folds to upper case; unknown chars draw a box). */
export function glyph(ch: string): readonly string[] {
  return ROWS[ch.toUpperCase()] ?? UNKNOWN;
}

/** All characters the font defines. */
export const FONT_CHARS: string = Object.keys(ROWS).join('');

/** Width in font pixels of `text` (glyph width plus 1 px spacing, none after the last). */
export function textWidth(text: string): number {
  const n = text.length;
  return n === 0 ? 0 : n * (FONT_W + 1) - 1;
}
