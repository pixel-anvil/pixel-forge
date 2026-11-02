/**
 * Pixel-art rotation about a pivot pixel: RotSprite, nearest neighbour, or none (FR-RIG-20 step 3,
 * FR-RIG-21). Port of the T0.4 spike reference (`spikes/rotsprite/reference/rot.mjs`); differences are
 * listed in the package README ("Rotation"). Integer maths only (NFR-02).
 *
 * Sources of the algorithms (public descriptions only; no code from any other implementation):
 * - RotSprite: Xenowhirl, "RotSprite" pixel-art rotation algorithm (2007): upscale the sprite with
 *   Scale2x, rotate the large image with nearest-neighbour sampling, then reduce it back to the
 *   original scale. Here the last two steps are fused into one sample per output pixel (README).
 * - Scale2x / EPX, which RotSprite uses for the upscale: see `scale2x.ts`.
 * - Nearest neighbour: inverse-map each output pixel centre and take the containing source pixel.
 */

import { ROTATION_ALGORITHMS, ROTATION_ALGORITHM_DEFAULT } from '@pixel-forge/schema';
import type { RotationAlgorithm } from '@pixel-forge/schema';
import { RasterError } from '../errors.js';
import { checkInts } from '../store.js';
import type { Rect } from '../store.js';
import { angleToStep, cosStepQ16, roundHalfAwayQ16, sinStepQ16 } from '../trig.js';
import { kindOf, packRect, unpackWindow } from './packed.js';
import type { Packed, PixelKind, RotatableImage } from './packed.js';
import { scale8 } from './scale2x.js';

export type { RotatableImage } from './packed.js';

/** Rotation algorithm of a part (FR-RIG-21): the schema's `RotationAlgorithm`. */
export type RotationAlgo = RotationAlgorithm;

/** A pixel position: the pivot pixel, whose centre `(x + ½, y + ½)` is the rotation centre. */
export interface Pivot {
  readonly x: number;
  readonly y: number;
}

/**
 * Result of {@link rotateAbout}. `pivotOut` is the pixel of `img` the source pivot pixel landed on:
 * drawing `img` at `dst = snappedPivot − pivotOut` puts the pivot pixel exactly on the snapped pivot.
 */
export interface RotateResult<T extends RotatableImage> {
  readonly img: T;
  readonly pivotOut: Pivot;
}

/**
 * Version of the {@link rotateAbout} output (RotSprite, nearest and none) for the same input.
 * Caches that store rotated pixels (core's render input key, the `.pxf` render cache) include it:
 * **bump it whenever a change to this module, `scale2x.ts` or the trig table changes any output
 * pixel, `pivotOut` or canvas**, so cached frames are re-rendered.
 */
export const ROTSPRITE_VERSION = 1;

/**
 * Largest opaque bounding-box area (pixels) RotSprite accepts (2^18, e.g. 512×512). The ×8 image costs
 * 256 bytes per source pixel, so this caps it at 64 MiB. `rotateAbout(..., 'rotsprite')` on a larger
 * source throws `RasterError('BAD_SIZE')` at every angle, quarter turns included, so the outcome never
 * depends on the angle; `nearest` and `none` have no such limit.
 */
export const ROTSPRITE_MAX_AREA = 1 << 18;

/**
 * A source image prepared for rotation: a copy-on-write snapshot of the image, its opaque bounding box
 * packed densely, and (for RotSprite) the cached ×8 Scale2x image, which depends only on the source.
 * The ×8 image is built lazily, on the first RotSprite rotation that is not a multiple of 90°, so a
 * handle that is only used with `nearest` / `none` never pays for it (or hits the size limit). Build
 * the handle once per part variant with {@link prepareRotSprite} and pass it to {@link rotateAbout}
 * for every angle; later changes to the original image do not affect it.
 */
export class PreparedRotSprite<T extends RotatableImage> {
  /** Snapshot of the source image (copy-on-write clone taken at preparation). Do not mutate. */
  readonly source: T;
  /** @internal Pixel kind (RGBA or indexed and the empty value). */
  readonly kind: PixelKind;
  /** @internal Opaque bounding box of `source` in source pixels; `undefined` for an empty image. */
  readonly box: Rect | undefined;
  /** @internal The pixels inside `box`, packed (0×0 for an empty image). */
  readonly packed: Packed;
  private bigCache: Packed | undefined;

  /** @internal Use {@link prepareRotSprite}. */
  constructor(img: T) {
    this.kind = kindOf(img);
    this.source = img.clone() as T;
    this.box = this.source.bounds();
    this.packed =
      this.box === undefined
        ? { w: 0, h: 0, p: new Uint32Array(0) }
        : packRect(this.source, this.kind, this.box);
  }

  /** @internal Throws `BAD_SIZE` if the opaque box is too large for RotSprite. */
  checkRotSpriteSize(): void {
    if (this.packed.w * this.packed.h > ROTSPRITE_MAX_AREA) {
      throw new RasterError(
        'BAD_SIZE',
        `RotSprite source ${String(this.packed.w)}x${String(this.packed.h)} exceeds ${String(ROTSPRITE_MAX_AREA)} px; use 'nearest'`,
      );
    }
  }

  /** @internal The ×8 image (`scale2x` three times), computed on first use and then cached. */
  big(): Packed {
    if (this.bigCache === undefined) {
      this.checkRotSpriteSize();
      this.bigCache = scale8(this.packed, this.kind.empty);
    }
    return this.bigCache;
  }

  /** Bytes held by the packed source and, once built, the ×8 image (for cache budgets). */
  get byteSize(): number {
    return this.packed.p.byteLength + (this.bigCache?.p.byteLength ?? 0);
  }
}

/**
 * Prepares `img` for repeated rotation: snapshots it and packs its opaque box. The ×8 Scale2x image is
 * built on the first RotSprite rotation that is not a multiple of 90° and then cached in the handle,
 * so every later {@link rotateAbout} call with it only runs the integer rotate-and-sample pass. Throws
 * `RasterError('MISMATCH')` for an unsupported image class. It does not throw for sources above
 * {@link ROTSPRITE_MAX_AREA}: only `rotateAbout(..., 'rotsprite')` does, so such a handle still works
 * with `nearest` and `none`.
 */
export function prepareRotSprite<T extends RotatableImage>(img: T): PreparedRotSprite<T> {
  return new PreparedRotSprite(img);
}

/** @internal Knobs for tests and the spike comparison; the public API always uses the defaults. */
export interface RotateInternalOptions {
  /** Force the pivot pixel's colour onto `pivotOut` (default true). */
  readonly pin?: boolean;
  /** Use exact quarter-turn permutations at multiples of 90° (default true). */
  readonly exactQuarterTurns?: boolean;
  /**
   * RotSprite sample on the pivot's ×8 centre line (`C·dx + S·dy = 0` or `C·dy − S·dx = 0`):
   * `'symmetric'` (default) picks between the two ×8 pixels by a mirror-invariant rule; `'spike'` takes
   * the one on the +x / +y side like the reference implementation.
   */
  readonly centreTie?: 'symmetric' | 'spike';
  /** Extra output margin in pixels (tests: the computed canvas must already be large enough). */
  readonly extraMargin?: number;
}

/** A dense window of rotated pixels plus where the pivot landed in it. */
interface Rotated {
  readonly buf: Uint32Array;
  readonly stride: number;
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  readonly pivotOut: Pivot;
}

/**
 * Mirror-symmetric floor of `n / 8192` (spike `sfloor`): `floor` for `n >= 0`, `ceil − 1` for `n < 0`.
 * Differs from `floor` only when `n / 8192` is an exact negative integer: a sample on a ×8 pixel edge
 * left of / above the pivot goes to the ×8 pixel farther from the pivot, as it does on the right.
 */
function sfloor8192(n: number): number {
  const q = Math.floor(n / 8192);
  return n < 0 && q * 8192 === n ? q - 1 : q;
}

/**
 * Mirror-invariant choice between the two ×8 pixels `a`, `b` either side of the pivot's centre line,
 * both inside the same source pixel whose colour is `own`: the shared colour, else the source pixel's
 * own colour, else the opaque one, else the smaller value. Depends only on `{a, b}` and `own`, so
 * mirroring the image (which swaps `a` and `b`) picks the same colour.
 * @internal Exported for the symmetry unit test.
 */
export function centreTie(a: number, b: number, own: number, empty: number): number {
  if (a === b || a === own) return a;
  if (b === own) return b;
  if (a === empty) return b;
  if (b === empty) return a;
  return a < b ? a : b;
}

/** Packed pivot colour (empty when the pivot is outside the opaque box). */
function pivotColour<T extends RotatableImage>(
  prep: PreparedRotSprite<T>,
  px: number,
  py: number,
): number {
  const box = prep.box;
  if (box === undefined) return prep.kind.empty;
  const lx = px - box.x;
  const ly = py - box.y;
  if (lx < 0 || ly < 0 || lx >= box.w || ly >= box.h) return prep.kind.empty;
  return prep.packed.p[ly * box.w + lx] ?? prep.kind.empty;
}

/** Crops `out` (pivot at `(-dx0, -dy0)`) to its non-empty pixels plus the pivot pixel. */
function trim(
  out: Uint32Array,
  ow: number,
  oh: number,
  ox: number,
  oy: number,
  empty: number,
): Rotated {
  let x0 = ox;
  let x1 = ox;
  let y0 = oy;
  let y1 = oy;
  for (let y = 0; y < oh; y++) {
    const row = y * ow;
    for (let x = 0; x < ow; x++) {
      if (out[row + x] === empty) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return {
    buf: out,
    stride: ow,
    x0,
    y0,
    w: x1 - x0 + 1,
    h: y1 - y0 + 1,
    pivotOut: { x: ox - x0, y: oy - y0 },
  };
}

/** Exact rotation by `quarter` × 90° clockwise: a pixel permutation (d → R·d). */
function rotateQuarter<T extends RotatableImage>(
  prep: PreparedRotSprite<T>,
  px: number,
  py: number,
  quarter: number,
): Rotated {
  const { empty } = prep.kind;
  const box = prep.box ?? { x: px, y: py, w: 1, h: 1 };
  const { p } = prep.packed;
  const map = (dx: number, dy: number): [number, number] =>
    quarter === 0 ? [dx, dy] : quarter === 1 ? [-dy, dx] : quarter === 2 ? [-dx, -dy] : [dy, -dx];
  const a = map(box.x - px, box.y - py);
  const b = map(box.x + box.w - 1 - px, box.y + box.h - 1 - py);
  const dx0 = Math.min(a[0], b[0], 0);
  const dx1 = Math.max(a[0], b[0], 0);
  const dy0 = Math.min(a[1], b[1], 0);
  const dy1 = Math.max(a[1], b[1], 0);
  const ow = dx1 - dx0 + 1;
  const oh = dy1 - dy0 + 1;
  const out = new Uint32Array(ow * oh);
  if (empty !== 0) out.fill(empty);
  if (prep.box !== undefined) {
    for (let y = 0; y < box.h; y++) {
      for (let x = 0; x < box.w; x++) {
        const v = p[y * box.w + x] ?? empty;
        if (v === empty) continue;
        const [rx, ry] = map(box.x + x - px, box.y + y - py);
        out[(ry - dy0) * ow + (rx - dx0)] = v;
      }
    }
  }
  return trim(out, ow, oh, -dx0, -dy0, empty);
}

/** RotSprite or nearest at a step that is not a multiple of 90°. */
function rotateGeneral<T extends RotatableImage>(
  prep: PreparedRotSprite<T>,
  px: number,
  py: number,
  step: number,
  algo: 'rotsprite' | 'nearest',
  opts: RotateInternalOptions,
): Rotated {
  const { empty } = prep.kind;
  const C = cosStepQ16(step);
  const S = sinStepQ16(step);
  const box = prep.box ?? { x: px, y: py, w: 0, h: 0 };

  // Output offsets d (relative to the pivot pixel) that can receive content: the forward-rotated
  // corners of the opaque box, in doubled pixel-centre coordinates so everything stays integer.
  const us = [2 * (box.x - px) - 1, 2 * (box.x + box.w - px) - 1];
  const vs = [2 * (box.y - py) - 1, 2 * (box.y + box.h - py) - 1];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let ext = 0;
  for (const u of us) {
    for (const v of vs) {
      const X = C * u - S * v;
      const Y = S * u + C * v;
      if (X < minX) minX = X;
      if (X > maxX) maxX = X;
      if (Y < minY) minY = Y;
      if (Y > maxY) maxY = Y;
      ext = Math.max(ext, Math.abs(u), Math.abs(v));
    }
  }
  // 1 px covers the ×8 sampling slack (≤ 0.18 px); |C² + S² − 65536²| ≤ 92683 adds ≤ 2.2e-5 px per px.
  const margin = 1 + Math.floor(ext / 65536) + (opts.extraMargin ?? 0);
  const TWO_Q = 2 * 65536;
  const dx0 = Math.min(Math.floor(minX / TWO_Q) - margin, 0);
  const dx1 = Math.max(Math.ceil(maxX / TWO_Q) + margin, 0);
  const dy0 = Math.min(Math.floor(minY / TWO_Q) - margin, 0);
  const dy1 = Math.max(Math.ceil(maxY / TWO_Q) + margin, 0);
  const ow = dx1 - dx0 + 1;
  const oh = dy1 - dy0 + 1;
  const out = new Uint32Array(ow * oh);
  if (empty !== 0) out.fill(empty);

  if (prep.box !== undefined) {
    if (algo === 'rotsprite') {
      sampleRotSprite(prep, px, py, C, S, dx0, dy0, ow, oh, out, opts.centreTie ?? 'symmetric');
    } else {
      sampleNearest(prep, px, py, C, S, dx0, dy0, ow, oh, out);
    }
  }
  return trim(out, ow, oh, -dx0, -dy0, empty);
}

/**
 * Fused rotate + downsample (spike step 2): output pixel at offset `d` from the pivot reads the ×8
 * pixel at `8·p + 4 + sfloor(R⁻¹·d · 8)`, i.e. nearest-neighbour rotation of the ×8 image about the
 * pivot block's centre, sampled once at each output pixel's centre.
 */
function sampleRotSprite<T extends RotatableImage>(
  prep: PreparedRotSprite<T>,
  px: number,
  py: number,
  C: number,
  S: number,
  dx0: number,
  dy0: number,
  ow: number,
  oh: number,
  out: Uint32Array,
  tie: 'symmetric' | 'spike',
): void {
  const { empty } = prep.kind;
  const box = prep.box ?? { x: 0, y: 0, w: 0, h: 0 };
  const big = prep.big();
  const BW = big.w;
  const BH = big.h;
  const bp = big.p;
  const src = prep.packed.p;
  const sw = prep.packed.w;
  const cx8 = 8 * (px - box.x) + 4; // pivot centre in ×8 space (a ×8 pixel corner)
  const cy8 = 8 * (py - box.y) + 4;
  const symmetric = tie === 'symmetric';
  for (let j = 0; j < oh; j++) {
    const dy = dy0 + j;
    let nx = C * dx0 + S * dy; // 65536 · (R⁻¹ d).x
    let ny = C * dy - S * dx0; // 65536 · (R⁻¹ d).y
    let o = j * ow;
    for (let i = 0; i < ow; i++, o++, nx += C, ny -= S) {
      const sx = cx8 + sfloor8192(nx);
      const sy = cy8 + sfloor8192(ny);
      if (sx < 0 || sy < 0 || sx >= BW || sy >= BH) continue;
      let v = bp[sy * BW + sx] ?? empty;
      if (symmetric && (nx === 0) !== (ny === 0)) {
        // The sample lies on the pivot's vertical (nx = 0) or horizontal (ny = 0) ×8 centre line,
        // exactly between two ×8 pixels of one source pixel: resolve it mirror-symmetrically.
        const own = src[(sy >> 3) * sw + (sx >> 3)] ?? empty;
        const other = nx === 0 ? bp[sy * BW + sx - 1] : bp[(sy - 1) * BW + sx];
        v = centreTie(other ?? empty, v, own, empty);
      }
      out[o] = v;
    }
  }
}

/** Nearest neighbour: output pixel centre, inverse-rotated, picks the source pixel containing it. */
function sampleNearest<T extends RotatableImage>(
  prep: PreparedRotSprite<T>,
  px: number,
  py: number,
  C: number,
  S: number,
  dx0: number,
  dy0: number,
  ow: number,
  oh: number,
  out: Uint32Array,
): void {
  const { empty } = prep.kind;
  const box = prep.box ?? { x: 0, y: 0, w: 0, h: 0 };
  const src = prep.packed.p;
  const lx = px - box.x;
  const ly = py - box.y;
  for (let j = 0; j < oh; j++) {
    const dy = dy0 + j;
    let nx = C * dx0 + S * dy;
    let ny = C * dy - S * dx0;
    let o = j * ow;
    for (let i = 0; i < ow; i++, o++, nx += C, ny -= S) {
      const sx = lx + roundHalfAwayQ16(nx);
      const sy = ly + roundHalfAwayQ16(ny);
      if (sx < 0 || sy < 0 || sx >= box.w || sy >= box.h) continue;
      out[o] = src[sy * box.w + sx] ?? empty;
    }
  }
}

function checkPivot(img: RotatableImage, pivot: Pivot): void {
  checkInts('pivot', pivot.x, pivot.y);
  if (pivot.x < 0 || pivot.y < 0 || pivot.x >= img.width || pivot.y >= img.height) {
    throw new RasterError(
      'BAD_VALUE',
      `pivot (${String(pivot.x)}, ${String(pivot.y)}) is outside the ${String(img.width)}x${String(img.height)} image`,
    );
  }
}

/**
 * @internal {@link rotateAbout} for `rotsprite` / `nearest` with test knobs; returns the dense window
 * (before it is turned into an image).
 */
export function rotateWindow<T extends RotatableImage>(
  prep: PreparedRotSprite<T>,
  pivot: Pivot,
  deg: number,
  algo: 'rotsprite' | 'nearest',
  opts: RotateInternalOptions = {},
): Rotated {
  checkPivot(prep.source, pivot);
  const step = angleToStep(deg);
  if (algo === 'rotsprite') prep.checkRotSpriteSize(); // before the quarter-turn shortcut: angle-independent
  const { x: px, y: py } = pivot;
  const r =
    step % 360 === 0 && (opts.exactQuarterTurns ?? true)
      ? rotateQuarter(prep, px, py, step / 360)
      : rotateGeneral(prep, px, py, step, algo, opts);
  if (opts.pin ?? true) {
    r.buf[(r.y0 + r.pivotOut.y) * r.stride + r.x0 + r.pivotOut.x] = pivotColour(prep, px, py);
  }
  return r;
}

/**
 * Rotates `img` by `deg` degrees clockwise (y down) about the centre of the pivot pixel `pivot`.
 *
 * - `img` is a `TiledImage` or `IndexedImage`, or a {@link PreparedRotSprite} handle (reuses its
 *   cached ×8 image; the result has the handle's image type).
 * - `deg` must be a multiple of 0.25° (any sign; `RasterError('BAD_VALUE')` otherwise). `pivot` must be
 *   an integer pixel inside the image (`NON_INTEGER` / `BAD_VALUE`). Unknown `algo`: `BAD_VALUE`.
 * - `'rotsprite'` (default): Scale2x ×3, then one integer nearest sample of the ×8 image per output
 *   pixel (see the README). Throws `RasterError('BAD_SIZE')` above {@link ROTSPRITE_MAX_AREA} at every
 *   angle, multiples of 90° included. `'nearest'`: integer nearest neighbour on the source. Both copy source
 *   values only, so the output colours are a subset of the input colours (RGBA pixels with alpha 0
 *   become `(0,0,0,0)`), and at multiples of 90° both are the exact pixel permutation (`rot90` etc.).
 *   The output is cropped to its non-empty pixels plus the pivot pixel; the pivot pixel's colour is
 *   copied onto `pivotOut`.
 * - `'none'`: a copy of the input (full canvas, nothing rotated) with `pivotOut = pivot`.
 *
 * Draw the result at `snappedPivot − pivotOut`. The input is never modified; the output is a new image.
 */
export function rotateAbout<T extends RotatableImage>(
  img: T | PreparedRotSprite<T>,
  pivot: Pivot,
  deg: number,
  algo: RotationAlgo = ROTATION_ALGORITHM_DEFAULT,
): RotateResult<T> {
  if (!(ROTATION_ALGORITHMS as readonly string[]).includes(algo)) {
    throw new RasterError('BAD_VALUE', `unknown rotation algorithm ${JSON.stringify(algo)}`);
  }
  const source = img instanceof PreparedRotSprite ? img.source : img;
  const kind = kindOf(source);
  if (algo === 'none') {
    checkPivot(source, pivot);
    angleToStep(deg);
    return { img: source.clone() as T, pivotOut: { x: pivot.x, y: pivot.y } };
  }
  const prep = img instanceof PreparedRotSprite ? img : new PreparedRotSprite(img);
  const r = rotateWindow(prep, pivot, deg, algo);
  const out = unpackWindow(kind, r.buf, r.stride, r.x0, r.y0, r.w, r.h) as T;
  return { img: out, pivotOut: r.pivotOut };
}
