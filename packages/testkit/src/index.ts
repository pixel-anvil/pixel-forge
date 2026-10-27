/** Package identifier, used by the scaffold smoke test. */
export const testkitPackage = '@pixel-forge/testkit' as const;

export { assertImage, createImage, hashRGBA } from './image.js';
export type { Rgba, TestImage } from './image.js';
export { compareGolden, diffImages, repoRoot, resolveDiffDir } from './golden.js';
export type { GoldenOptions, GoldenResult } from './golden.js';
export { expectGolden } from './expect-golden.js';
export type { ExpectGoldenOptions } from './expect-golden.js';
export { AsciiError, asciiRows, asciiToImage, expectAscii, imageToAscii } from './ascii.js';
export type { AsciiErrorCode, ImageToAsciiOptions, Legend } from './ascii.js';
export { goldenSheet, sheetSize, LABEL_BAND } from './sheet.js';
export type { SheetEntry, SheetOptions } from './sheet.js';
export { FONT_CHARS, FONT_H, FONT_W, glyph, textWidth } from './font.js';
export { checkFixtures, listGenerators, runFixtures } from './fixtures.js';
export type { FixtureContext, RunFixturesOptions } from './fixtures.js';
export { buildSheet, findByName } from './sheet-cli.js';
export type { BuiltSheet } from './sheet-cli.js';
