/** Package identifier, used by the scaffold smoke test. */
export const pngPackage = '@pixel-forge/png' as const;

export { encodePng, DEFLATE_LEVEL, DEFLATE_MEM } from './encode.js';
export { decodePng, decodePngRaw } from './decode.js';
export { PngError } from './errors.js';
export type { PngErrorCode } from './errors.js';
export type { PngImage, PngKind, DecodedRgba } from './types.js';
