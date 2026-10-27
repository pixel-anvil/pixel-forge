/**
 * Sparse tiled images (RGBA8 and indexed), compositing and whole-image transforms.
 * Pure: no Node built-ins, integer maths only (NFR-02).
 * @packageDocumentation
 */

export { RasterError } from './errors.js';
export type { RasterErrorCode } from './errors.js';
export { IndexedImage, SparseImage, TiledImage, hashRGBA } from './image.js';
export type { Palette, Rgba, RgbaImage } from './image.js';
export { sha256Hex } from './sha256.js';
export { MAX_DIMENSION } from './store.js';
export type { Rect, TileCoord, TileSnapshot, TileView } from './store.js';
export { blendOver, blit, composite, div255 } from './composite.js';
export type { BlitOptions, CompositeOptions } from './composite.js';
export { crop, flipH, flipV, rot180, rot270, rot90, scaleInt, translate } from './transform.js';
export * from './postpass/index.js';
export * from './primitives/index.js';
