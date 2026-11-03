/**
 * `@pixel-forge/convert`: pure image-to-sprite steps over `RgbaImage`. No decoding here: PNG bytes are
 * decoded in `@pixel-forge/io` (`decodeImageFile`).
 * @packageDocumentation
 */

/** Package identifier. */
export const convertPackage = '@pixel-forge/convert' as const;

export { ConvertError } from './errors.js';
export type { ConvertErrorCode } from './errors.js';
export { cropImage } from './crop.js';
export type { CropOptions } from './crop.js';
export { MAX_RGB_TOLERANCE, autoKeyColor, removeBackground, rgbDistanceSq } from './background.js';
export type {
  BackgroundAlpha,
  BackgroundColor,
  BackgroundFlood,
  BackgroundKey,
  BackgroundNone,
  BackgroundOptions,
  RgbTriple,
} from './background.js';
export { FLOYD_STEINBERG, bayerMatrix, bayerThreshold } from './dither.js';
export type { BayerSize, DiffusionTap } from './dither.js';
export {
  DEFAULT_ALPHA_THRESHOLD,
  DEFAULT_DITHER_SPREAD,
  MAX_QUANTIZE_COLORS,
  TRANSPARENT_INDEX,
  quantize,
} from './quantize.js';
export type { DitherMode, QuantizeOptions, QuantizeResult } from './quantize.js';
