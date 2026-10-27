/**
 * `@pixel-forge/color`: sRGB/linear/OKLab/OKLCH conversion, nearest palette colour and palette
 * operations. Pure and deterministic (see `convert.ts` for the float policy).
 * @packageDocumentation
 */

/** Package identifier, used by the scaffold smoke test. */
export const colorPackage = '@pixel-forge/color' as const;

export * from './convert.js';
export * from './nearest.js';
export * from './palette-ops.js';
