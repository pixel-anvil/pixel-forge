import { RasterError } from './errors.js';
import { sha256Hex } from './sha256.js';
import { checkInts, TileStore } from './store.js';
import type { Rect, TileCoord, TileSnapshot, TileView } from './store.js';

/** A pixel as `[r, g, b, a]`, each an integer 0..255, straight (non-premultiplied) alpha. */
export type Rgba = readonly [number, number, number, number];

/**
 * Dense RGBA8 image, row-major, top-left origin, straight alpha: the shape of `@pixel-forge/png`'s
 * `PngImage` (without `kind`) and of the testkit `TestImage`.
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * State and operations common to {@link TiledImage} and {@link IndexedImage}: fixed size, sparse
 * `TILE_SIZE`-square copy-on-write tiles, versioning and tile capture. See the package README for the
 * tile / dirty-tracking contract that transactions (T2.1) build on.
 */
export abstract class SparseImage {
  /** @internal Storage; used by the sibling modules of this package only. */
  readonly store: TileStore;

  /** @internal */
  protected constructor(store: TileStore) {
    this.store = store;
  }

  /** Width in pixels (fixed). */
  get width(): number {
    return this.store.width;
  }

  /** Height in pixels (fixed). */
  get height(): number {
    return this.store.height;
  }

  /** Tiles per row. */
  get tilesX(): number {
    return this.store.tilesX;
  }

  /** Tiles per column. */
  get tilesY(): number {
    return this.store.tilesY;
  }

  /**
   * Monotonic change counter, starting at 0 for a fresh image. Every mutating call that touches at least one
   * tile advances it by exactly 1. Not touched by reads, `clone()`, `compact()` or captures.
   */
  get version(): number {
    return this.store.version;
  }

  /** Number of allocated tiles. */
  get tileCount(): number {
    return this.store.tileCount;
  }

  /** Bytes held by allocated tiles: `tileCount * TILE_SIZE^2 * bytesPerPixel`. Buffers shared with clones count in each. */
  byteSize(): number {
    return this.store.tileCount * this.store.tileBytes;
  }

  /** O(allocated tiles) copy-on-write copy. Tile buffers are shared until either image writes to a tile. */
  abstract clone(): this;

  /** A new empty image of the same kind (same transparent index) and the given size. */
  abstract emptyLike(width: number, height: number): this;

  /** Allocated tiles in row-major order. `data` is a live view, valid until the next write to this image. */
  tiles(): IterableIterator<TileView> {
    return this.store.tileViews();
  }

  /**
   * Tiles whose content may have changed in an operation after `sinceVersion` (row-major). A tile absent from
   * the list is guaranteed unchanged; `set` is exact, bulk operations (`composite`, `blit`, restore) are
   * conservative at tile granularity. Includes tiles that `restoreTiles` turned into absent tiles.
   */
  tilesChanged(sinceVersion: number): TileCoord[] {
    return this.store.changedSince(sinceVersion);
  }

  /**
   * Snapshots the given tiles (use {@link tilesChanged}). The returned buffers are immutable: the tiles are
   * marked shared, so later writes to this image copy first. `data` is `undefined` for an absent tile.
   * Throws `RasterError('BAD_TILE')` for coordinates outside the grid.
   */
  captureTiles(coords: Iterable<TileCoord>): TileSnapshot[] {
    return this.store.capture(coords);
  }

  /**
   * Puts captured tiles back (undo / redo). Buffers are adopted without copying (and marked shared);
   * `data: undefined` removes the tile. Advances `version` once; the restored tiles are reported by
   * `tilesChanged`. Throws `RasterError('BAD_TILE')` for bad coordinates or buffer length.
   */
  restoreTiles(snapshots: Iterable<TileSnapshot>): void {
    this.store.restore(snapshots);
  }

  /** Frees tiles that are entirely empty. Returns how many were freed. Does not change content or `version`. */
  compact(): number {
    return this.store.compact();
  }

  /** Makes the image empty (frees every tile). */
  clear(): void {
    this.store.clear();
  }

  /** Pixel-for-pixel equality (same kind, size and content; allocation layout is irrelevant). */
  equals(other: SparseImage): boolean {
    return this.store.equals(other.store);
  }
}

function checkChannel(v: number, what: string): void {
  if (!Number.isInteger(v) || v < 0 || v > 255) {
    throw new RasterError('BAD_VALUE', `${what} must be an integer 0..255, got ${String(v)}`);
  }
}

/**
 * Sparse RGBA8 image (straight alpha). An absent tile is fully transparent `(0, 0, 0, 0)`. A tile is
 * allocated by the first write of a value other than `(0, 0, 0, 0)` into it; values are stored exactly
 * as written (no normalisation of colour under alpha 0).
 */
export class TiledImage extends SparseImage {
  /** Creates an empty (fully transparent) image. The optional `store` is internal (used by `clone`). */
  constructor(width: number, height: number, store?: TileStore) {
    super(store ?? new TileStore(width, height, 4, 0));
  }

  /** Builds from dense RGBA bytes (copied). Allocates only tiles containing a non-zero byte. */
  static fromRGBA(img: RgbaImage): TiledImage {
    const out = new TiledImage(img.width, img.height);
    out.store.importDense(img.data);
    return out;
  }

  /** Dense RGBA8 copy of the whole image (`width * height * 4` bytes). */
  toRGBA(): { width: number; height: number; data: Uint8Array } {
    return { width: this.width, height: this.height, data: this.store.exportDense() };
  }

  /** SHA-256 hex of the image in the testkit layout; equals `hashRGBA(this.toRGBA())`. */
  hashRGBA(): string {
    return hashRGBA(this.toRGBA());
  }

  override clone(): this {
    return new TiledImage(this.width, this.height, this.store.clone()) as this;
  }

  override emptyLike(width: number, height: number): this {
    return new TiledImage(width, height) as this;
  }

  /**
   * The pixel at `(x, y)`. Out of bounds reads as transparent `[0, 0, 0, 0]`. Coordinates must be integers
   * (`RasterError('NON_INTEGER')` otherwise).
   */
  get(x: number, y: number): Rgba {
    checkInts('coordinate', x, y);
    const s = this.store;
    if (!s.inBounds(x, y)) return [0, 0, 0, 0];
    const t = s.peek(s.keyOf(x, y));
    if (t === undefined) return [0, 0, 0, 0];
    const o = s.offsetOf(x, y);
    return [t[o] ?? 0, t[o + 1] ?? 0, t[o + 2] ?? 0, t[o + 3] ?? 0];
  }

  /**
   * Writes a pixel. Out of bounds is a **no-op** returning `false` (so brushes and stamps can overhang the
   * canvas); returns `true` when the pixel is in bounds. Throws `RasterError` for non-integer coordinates or
   * channels outside 0..255. Writing the value already present, or `(0,0,0,0)` into an absent tile, changes
   * nothing (no allocation, no version bump).
   */
  set(x: number, y: number, rgba: Rgba): boolean {
    checkInts('coordinate', x, y);
    if ((rgba as readonly number[]).length !== 4)
      throw new RasterError('BAD_VALUE', 'a pixel needs 4 channels');
    for (const c of rgba) checkChannel(c, 'channel');
    const s = this.store;
    if (!s.inBounds(x, y)) return false;
    const key = s.keyOf(x, y);
    const o = s.offsetOf(x, y);
    const [r, g, b, a] = rgba;
    const cur = s.peek(key);
    if (cur === undefined) {
      if (r === 0 && g === 0 && b === 0 && a === 0) return true;
    } else if (cur[o] === r && cur[o + 1] === g && cur[o + 2] === b && cur[o + 3] === a) {
      return true;
    }
    const t = s.writable(key);
    t[o] = r;
    t[o + 1] = g;
    t[o + 2] = b;
    t[o + 3] = a;
    s.commit();
    return true;
  }

  /** Tight bounding box of pixels with alpha != 0, or `undefined` for an empty image. */
  bounds(): Rect | undefined {
    return this.store.boundsWhere((buf, off) => buf[off + 3] !== 0);
  }
}

/** Palette used to resolve indices: entry `i` is the colour of index `i`. */
export type Palette = readonly Rgba[];

/**
 * Sparse indexed image: one palette index (0..255) per pixel. An absent tile reads as `transparentIndex`.
 * The image does not know its palette; `transparentIndex` is the index that means "empty" for sparsity,
 * `bounds()` and compositing. See the README ("Indexed transparency") for the rationale.
 */
export class IndexedImage extends SparseImage {
  /** Index that an absent tile reads as, and that counts as "empty". Palette entry must have alpha 0. */
  readonly transparentIndex: number;

  /** Creates an empty image. The optional `store` is internal (used by `clone`). */
  constructor(width: number, height: number, transparentIndex = 0, store?: TileStore) {
    checkChannel(transparentIndex, 'transparentIndex');
    super(store ?? new TileStore(width, height, 1, transparentIndex));
    this.transparentIndex = transparentIndex;
  }

  /** Builds from a dense index buffer (`width * height` bytes, copied). */
  static fromIndices(
    width: number,
    height: number,
    data: Uint8Array,
    transparentIndex = 0,
  ): IndexedImage {
    const out = new IndexedImage(width, height, transparentIndex);
    out.store.importDense(data);
    return out;
  }

  /** Dense index buffer (`width * height` bytes); absent tiles are filled with `transparentIndex`. */
  toIndices(): Uint8Array {
    return this.store.exportDense();
  }

  /**
   * Resolves indices through `palette` into dense RGBA8. Throws `RasterError('BAD_VALUE')` if an index
   * (including `transparentIndex`, which fills absent tiles) is not in the palette.
   */
  toRGBA(palette: Palette): { width: number; height: number; data: Uint8Array } {
    const lut = new Uint8Array(256 * 4);
    const used = new Uint8Array(256);
    const idx = this.toIndices();
    for (const i of idx) used[i] = 1;
    for (let i = 0; i < 256; i++) {
      if (used[i] === 0) continue;
      const c = palette[i];
      if (c === undefined) {
        throw new RasterError(
          'BAD_VALUE',
          `index ${String(i)} not in a palette of ${String(palette.length)}`,
        );
      }
      lut.set(c, i * 4);
    }
    const data = new Uint8Array(idx.length * 4);
    for (let p = 0; p < idx.length; p++) {
      const i = (idx[p] ?? 0) * 4;
      data[p * 4] = lut[i] ?? 0;
      data[p * 4 + 1] = lut[i + 1] ?? 0;
      data[p * 4 + 2] = lut[i + 2] ?? 0;
      data[p * 4 + 3] = lut[i + 3] ?? 0;
    }
    return { width: this.width, height: this.height, data };
  }

  override clone(): this {
    return new IndexedImage(
      this.width,
      this.height,
      this.transparentIndex,
      this.store.clone(),
    ) as this;
  }

  override emptyLike(width: number, height: number): this {
    return new IndexedImage(width, height, this.transparentIndex) as this;
  }

  /**
   * The index at `(x, y)`. Out of bounds reads as `transparentIndex`. Coordinates must be integers.
   */
  get(x: number, y: number): number {
    checkInts('coordinate', x, y);
    const s = this.store;
    if (!s.inBounds(x, y)) return this.transparentIndex;
    const t = s.peek(s.keyOf(x, y));
    return t === undefined ? this.transparentIndex : (t[s.offsetOf(x, y)] ?? 0);
  }

  /**
   * Writes an index; same out-of-bounds (no-op, returns `false`) and no-change rules as
   * {@link TiledImage.set}. Writing `transparentIndex` into an absent tile allocates nothing.
   */
  set(x: number, y: number, index: number): boolean {
    checkInts('coordinate', x, y);
    checkChannel(index, 'index');
    const s = this.store;
    if (!s.inBounds(x, y)) return false;
    const key = s.keyOf(x, y);
    const o = s.offsetOf(x, y);
    const cur = s.peek(key);
    if ((cur === undefined ? this.transparentIndex : cur[o]) === index) return true;
    const t = s.writable(key);
    t[o] = index;
    s.commit();
    return true;
  }

  /**
   * Tight bounding box of pixels that are not empty, or `undefined`. A pixel is empty when
   * `index === transparentIndex`; pass `isTransparent` (e.g. `i => palette[i][3] === 0`) to treat
   * further alpha-0 palette entries as empty too.
   */
  bounds(isTransparent?: (index: number) => boolean): Rect | undefined {
    const t = this.transparentIndex;
    return this.store.boundsWhere((buf, off) => {
      const v = buf[off] ?? 0;
      return v !== t && isTransparent?.(v) !== true;
    });
  }
}

/**
 * SHA-256 (lower-case hex) of an RGBA image in the testkit / ADR-010 layout: `width` as uint32 big-endian,
 * `height` as uint32 big-endian, then the raw RGBA8 bytes. Pure TypeScript SHA-256 (no `node:crypto`), so
 * it matches testkit's `hashRGBA` byte for byte.
 */
export function hashRGBA(img: RgbaImage): string {
  if (
    !Number.isInteger(img.width) ||
    !Number.isInteger(img.height) ||
    img.width < 1 ||
    img.height < 1
  ) {
    throw new RasterError(
      'BAD_SIZE',
      `invalid image size ${String(img.width)}x${String(img.height)}`,
    );
  }
  if (img.data.length !== img.width * img.height * 4) {
    throw new RasterError('BAD_DATA', `data length ${String(img.data.length)} != width*height*4`);
  }
  const buf = new Uint8Array(8 + img.data.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, img.width);
  view.setUint32(4, img.height);
  buf.set(img.data, 8);
  return sha256Hex(buf);
}
