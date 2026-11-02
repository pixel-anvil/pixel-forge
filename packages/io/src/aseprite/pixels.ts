import { AseError } from './errors.js';
import type { AseCel, AseFile, AseImage, AsePalette } from './types.js';

/** Options for {@link aseImageToRgba}. */
export interface AseRgbaOptions {
  /**
   * Palette index treated as transparent (header `transparentIndex`). Only used for indexed
   * images, and only when `background` is false. Pass null to disable.
   */
  readonly transparentIndex?: number | null;
  /**
   * True when the image belongs to a background layer. Per the format notes the transparent
   * index applies to "all non-background layers", so on a background layer index
   * `transparentIndex` is an ordinary opaque colour (whatever alpha its palette entry has).
   */
  readonly background?: boolean;
}

/**
 * Convert raw cel pixels to straight-alpha RGBA8.
 *
 * - 32-bit: copied.
 * - 16-bit grayscale: `(v, a)` becomes `(v, v, v, a)`.
 * - 8-bit indexed: looked up in `palette` (its alpha is kept). An index equal to
 *   `transparentIndex` on a non-background layer becomes `(0, 0, 0, 0)`, and so does an index
 *   beyond the palette.
 *
 * @param image - raw pixels
 * @param palette - required for indexed images
 * @param options - transparency semantics for indexed images
 * @returns `width * height * 4` bytes
 * @throws AseError UNSUPPORTED when an indexed image has no palette
 */
export function aseImageToRgba(
  image: AseImage,
  palette: AsePalette | null,
  options: AseRgbaOptions = {},
): Uint8Array {
  const n = image.width * image.height;
  const src = image.data;
  if (image.depth === 32) return src.slice();
  const out = new Uint8Array(n * 4);
  if (image.depth === 16) {
    for (let i = 0; i < n; i++) {
      const v = src[i * 2] ?? 0;
      out[i * 4] = v;
      out[i * 4 + 1] = v;
      out[i * 4 + 2] = v;
      out[i * 4 + 3] = src[i * 2 + 1] ?? 0;
    }
    return out;
  }
  if (palette === null)
    throw new AseError('UNSUPPORTED', 'indexed image but the file has no palette');
  const keyed = options.background === true ? null : (options.transparentIndex ?? null);
  for (let i = 0; i < n; i++) {
    const idx = src[i] ?? 0;
    const color = idx === keyed ? undefined : palette.entries[idx];
    if (color !== undefined) {
      out[i * 4] = color.r;
      out[i * 4 + 1] = color.g;
      out[i * 4 + 2] = color.b;
      out[i * 4 + 3] = color.a;
    }
  }
  return out;
}

/** The cel in `frameIndex` on `layerIndex` (the last one if a malformed file has several). */
export function findAseCel(
  file: AseFile,
  frameIndex: number,
  layerIndex: number,
): AseCel | undefined {
  const frame = file.frames[frameIndex];
  if (frame === undefined) return undefined;
  for (let i = frame.cels.length - 1; i >= 0; i--) {
    const cel = frame.cels[i];
    if (cel?.layerIndex === layerIndex) return cel;
  }
  return undefined;
}

/**
 * Follow linked cels to the cel that owns the pixels. A linked cel shares everything with its
 * source (position and opacity included), so the source is returned.
 *
 * @throws AseError BAD_CHUNK on a link cycle or a dangling link; UNSUPPORTED for a tilemap cel
 */
export function resolveAseCel(
  file: AseFile,
  cel: AseCel,
): { readonly cel: AseCel; readonly image: AseImage } {
  let cur = cel;
  for (let hops = 0; hops <= file.frames.length; hops++) {
    const c = cur.content;
    if (c.type === 'image') return { cel: cur, image: c.image };
    if (c.type === 'tilemap')
      throw new AseError('UNSUPPORTED', 'tilemap cels have no decoded pixels');
    const next = findAseCel(file, c.framePosition, cur.layerIndex);
    if (next === undefined)
      throw new AseError(
        'BAD_CHUNK',
        `linked cel points at missing frame ${String(c.framePosition)}`,
      );
    cur = next;
  }
  throw new AseError('BAD_CHUNK', 'linked cels form a cycle');
}

/** A cel's pixels as RGBA with its placement on the canvas. */
export interface AseCelRgba {
  /** X of the top-left corner on the canvas (may be negative). */
  readonly x: number;
  /** Y of the top-left corner on the canvas (may be negative). */
  readonly y: number;
  /** Cel width. */
  readonly width: number;
  /** Cel height. */
  readonly height: number;
  /** Cel opacity 0..255 (not applied to `data`). */
  readonly opacity: number;
  /** Straight-alpha RGBA8. */
  readonly data: Uint8Array;
}

/**
 * Resolve a cel (following links) and convert its pixels to RGBA8 using the frame's palette, the
 * header's transparent index and the layer's background flag. Cel and layer opacity are reported,
 * not applied.
 *
 * @throws AseError as {@link resolveAseCel} and {@link aseImageToRgba}
 */
export function aseCelToRgba(file: AseFile, cel: AseCel): AseCelRgba {
  const { cel: source, image } = resolveAseCel(file, cel);
  const layer = file.layers[source.layerIndex];
  const palette = file.frames[cel.frameIndex]?.palette ?? file.palette;
  const data = aseImageToRgba(image, palette, {
    transparentIndex: file.header.transparentIndex,
    background: layer?.background === true,
  });
  return {
    x: source.x,
    y: source.y,
    width: image.width,
    height: image.height,
    opacity: source.opacity,
    data,
  };
}
