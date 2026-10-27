import { TILE_SIZE } from '@pixel-forge/schema';
import { RasterError } from './errors.js';

/** Largest allowed image width or height in pixels. */
export const MAX_DIMENSION = 65536;

const SHIFT = Math.log2(TILE_SIZE);
if (!Number.isInteger(SHIFT)) throw new Error('TILE_SIZE must be a power of two');
const MASK = TILE_SIZE - 1;

/** Integer rectangle: top-left `x, y`, size `w, h` (pixels). */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Tile grid coordinates: `tx = floor(x / TILE_SIZE)`, `ty = floor(y / TILE_SIZE)`. */
export interface TileCoord {
  readonly tx: number;
  readonly ty: number;
}

/**
 * A captured tile: `data` is the tile's pixel buffer (`TILE_SIZE * TILE_SIZE * channels` bytes, row-major)
 * or `undefined` for an absent (empty) tile. **Immutable by contract**: the image never mutates a buffer
 * it has handed out (it copies before the next write); callers must not mutate it either.
 */
export interface TileSnapshot extends TileCoord {
  readonly data: Uint8Array | undefined;
}

/** A live view of one allocated tile, from `tiles()`. `data` is valid until the next write to the image. */
export interface TileView extends TileCoord {
  /** Pixel x of the tile's top-left corner. */
  readonly x: number;
  /** Pixel y of the tile's top-left corner. */
  readonly y: number;
  readonly data: Uint8Array;
}

/** @internal Validates an image size. */
export function checkSize(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION
  ) {
    throw new RasterError(
      'BAD_SIZE',
      `invalid image size ${String(width)}x${String(height)} (1..${String(MAX_DIMENSION)})`,
    );
  }
}

/** @internal Throws unless every value is an integer. */
export function checkInts(what: string, ...values: number[]): void {
  for (const v of values) {
    if (!Number.isInteger(v))
      throw new RasterError('NON_INTEGER', `${what} must be an integer, got ${String(v)}`);
  }
}

/**
 * @internal Sparse copy-on-write tile storage shared by `TiledImage` and `IndexedImage`.
 * One tile is `TILE_SIZE * TILE_SIZE * channels` bytes. A tile that is absent reads as the `fill` byte in every
 * channel (0 for RGBA = transparent; the transparent index for indexed).
 */
export class TileStore {
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 4;
  readonly fill: number;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly tileBytes: number;
  /** Bumped by `commit()` after any operation that touched at least one tile. */
  version = 0;

  private tiles = new Map<number, Uint8Array>();
  /** Keys whose buffer may also be referenced by a clone or a captured snapshot: copy before writing. */
  private shared = new Set<number>();
  /** key -> version of the last change (kept for tiles removed by `restoreTiles`, so they are reported). */
  private stamps = new Map<number, number>();
  private dirty = false;

  constructor(width: number, height: number, channels: 1 | 4, fill: number) {
    checkSize(width, height);
    this.width = width;
    this.height = height;
    this.channels = channels;
    this.fill = fill;
    this.tilesX = Math.ceil(width / TILE_SIZE);
    this.tilesY = Math.ceil(height / TILE_SIZE);
    this.tileBytes = TILE_SIZE * TILE_SIZE * channels;
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  keyOf(x: number, y: number): number {
    return (y >> SHIFT) * this.tilesX + (x >> SHIFT);
  }

  /** Byte offset of pixel `(x, y)` inside its tile. */
  offsetOf(x: number, y: number): number {
    return (((y & MASK) << SHIFT) | (x & MASK)) * this.channels;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Current tile buffer (possibly shared: do not write), or undefined when absent. */
  peek(key: number): Uint8Array | undefined {
    return this.tiles.get(key);
  }

  /** A buffer safe to write: allocates, or copies a shared tile, and stamps the tile as changed. */
  writable(key: number): Uint8Array {
    let t = this.tiles.get(key);
    if (t === undefined) {
      t = new Uint8Array(this.tileBytes);
      if (this.fill !== 0) t.fill(this.fill);
      this.tiles.set(key, t);
    } else if (this.shared.has(key)) {
      t = t.slice();
      this.tiles.set(key, t);
      this.shared.delete(key);
    }
    this.stamps.set(key, this.version + 1);
    this.dirty = true;
    return t;
  }

  /** Ends a mutating operation: advances `version` once if any tile was touched. */
  commit(): void {
    if (this.dirty) {
      this.version++;
      this.dirty = false;
    }
  }

  /** Forget all change history (fresh image from a constructor-style operation). */
  markPristine(): void {
    this.version = 0;
    this.stamps.clear();
    this.dirty = false;
  }

  /** True when the pixel at `off` is "empty" (every channel equals `fill`). */
  isEmptyPixel(buf: Uint8Array, off: number): boolean {
    for (let c = 0; c < this.channels; c++) if (buf[off + c] !== this.fill) return false;
    return true;
  }

  /** RGBA: alpha != 0. Indexed: index != fill. */
  isVisible(buf: Uint8Array, off: number): boolean {
    return this.channels === 4 ? buf[off + 3] !== 0 : buf[off] !== this.fill;
  }

  /**
   * Copies the pixel at `src[srcOff]` to `(x, y)` (must be in bounds). Does nothing if the value is already
   * there; never allocates a tile for an empty value. Call `commit()` after a batch.
   */
  setRaw(x: number, y: number, src: Uint8Array, srcOff: number): void {
    const key = this.keyOf(x, y);
    const off = this.offsetOf(x, y);
    const cur = this.tiles.get(key);
    const n = this.channels;
    let same = true;
    for (let c = 0; c < n; c++) {
      if ((cur === undefined ? this.fill : cur[off + c]) !== src[srcOff + c]) {
        same = false;
        break;
      }
    }
    if (same) return;
    const t = this.writable(key);
    for (let c = 0; c < n; c++) t[off + c] = src[srcOff + c] ?? 0;
  }

  /** Calls `cb` for every stored pixel that is not empty, in unspecified order. */
  forEachStored(cb: (x: number, y: number, buf: Uint8Array, off: number) => void): void {
    const w = this.width;
    const h = this.height;
    for (const [key, buf] of this.tiles) {
      const x0 = (key % this.tilesX) * TILE_SIZE;
      const y0 = Math.floor(key / this.tilesX) * TILE_SIZE;
      const ex = Math.min(TILE_SIZE, w - x0);
      const ey = Math.min(TILE_SIZE, h - y0);
      for (let ly = 0; ly < ey; ly++) {
        for (let lx = 0; lx < ex; lx++) {
          const off = ((ly << SHIFT) | lx) * this.channels;
          if (!this.isEmptyPixel(buf, off)) cb(x0 + lx, y0 + ly, buf, off);
        }
      }
    }
  }

  /** Tight bounding box of in-image pixels for which `pred` holds; undefined if none. */
  boundsWhere(pred: (buf: Uint8Array, off: number) => boolean): Rect | undefined {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (const [key, buf] of this.tiles) {
      const x0 = (key % this.tilesX) * TILE_SIZE;
      const y0 = Math.floor(key / this.tilesX) * TILE_SIZE;
      const ex = Math.min(TILE_SIZE, this.width - x0);
      const ey = Math.min(TILE_SIZE, this.height - y0);
      for (let ly = 0; ly < ey; ly++) {
        for (let lx = 0; lx < ex; lx++) {
          if (!pred(buf, ((ly << SHIFT) | lx) * this.channels)) continue;
          const x = x0 + lx;
          const y = y0 + ly;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < 0 ? undefined : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /** Allocated tiles in row-major order (deterministic). */
  *tileViews(): IterableIterator<TileView> {
    const keys = [...this.tiles.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      const data = this.tiles.get(key);
      if (data === undefined) continue;
      const tx = key % this.tilesX;
      const ty = Math.floor(key / this.tilesX);
      yield { tx, ty, x: tx * TILE_SIZE, y: ty * TILE_SIZE, data };
    }
  }

  /** Tiles changed after `since`, row-major. Includes tiles removed by `restoreTiles`. */
  changedSince(since: number): TileCoord[] {
    const keys: number[] = [];
    for (const [key, stamp] of this.stamps) if (stamp > since) keys.push(key);
    keys.sort((a, b) => a - b);
    return keys.map((key) => ({ tx: key % this.tilesX, ty: Math.floor(key / this.tilesX) }));
  }

  private keyOfTile(c: TileCoord): number {
    if (
      !Number.isInteger(c.tx) ||
      !Number.isInteger(c.ty) ||
      c.tx < 0 ||
      c.ty < 0 ||
      c.tx >= this.tilesX ||
      c.ty >= this.tilesY
    ) {
      throw new RasterError(
        'BAD_TILE',
        `tile (${String(c.tx)}, ${String(c.ty)}) outside the ${String(this.tilesX)}x${String(this.tilesY)} grid`,
      );
    }
    return c.ty * this.tilesX + c.tx;
  }

  capture(coords: Iterable<TileCoord>): TileSnapshot[] {
    const out: TileSnapshot[] = [];
    for (const c of coords) {
      const key = this.keyOfTile(c);
      const data = this.tiles.get(key);
      if (data !== undefined) this.shared.add(key);
      out.push({ tx: c.tx, ty: c.ty, data });
    }
    return out;
  }

  restore(snaps: Iterable<TileSnapshot>): void {
    try {
      for (const s of snaps) {
        const key = this.keyOfTile(s);
        if (s.data !== undefined && s.data.length !== this.tileBytes) {
          throw new RasterError(
            'BAD_TILE',
            `tile data length ${String(s.data.length)} != ${String(this.tileBytes)}`,
          );
        }
        if (this.tiles.get(key) === s.data) continue;
        if (s.data === undefined) {
          this.tiles.delete(key);
          this.shared.delete(key);
        } else {
          this.tiles.set(key, s.data);
          this.shared.add(key);
        }
        this.stamps.set(key, this.version + 1);
        this.dirty = true;
      }
    } finally {
      this.commit();
    }
  }

  /** Drops tiles whose bytes are all empty. Content-neutral, so it does not advance the version. */
  compact(): number {
    let removed = 0;
    for (const [key, buf] of [...this.tiles]) {
      let empty = true;
      for (const b of buf) {
        if (b !== this.fill) {
          empty = false;
          break;
        }
      }
      if (empty) {
        this.tiles.delete(key);
        this.shared.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Removes every tile (the image becomes empty). */
  clear(): void {
    if (this.tiles.size === 0) return;
    for (const key of this.tiles.keys()) this.stamps.set(key, this.version + 1);
    this.tiles.clear();
    this.shared.clear();
    this.dirty = true;
    this.commit();
  }

  /** O(tiles) copy-on-write clone: the two stores share every tile buffer until one of them writes. */
  clone(): TileStore {
    const c = new TileStore(this.width, this.height, this.channels, this.fill);
    c.tiles = new Map(this.tiles);
    c.stamps = new Map(this.stamps);
    c.version = this.version;
    this.shared = new Set(this.tiles.keys());
    c.shared = new Set(this.shared);
    return c;
  }

  equals(other: TileStore): boolean {
    if (
      other.width !== this.width ||
      other.height !== this.height ||
      other.channels !== this.channels ||
      other.fill !== this.fill
    ) {
      return false;
    }
    const same = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => {
      if (a === b) return true;
      for (let i = 0; i < this.tileBytes; i++) {
        if ((a === undefined ? this.fill : a[i]) !== (b === undefined ? this.fill : b[i]))
          return false;
      }
      return true;
    };
    for (const [key, buf] of this.tiles) if (!same(buf, other.tiles.get(key))) return false;
    for (const [key, buf] of other.tiles)
      if (!this.tiles.has(key) && !same(undefined, buf)) return false;
    return true;
  }

  /** Writes the whole image into a new dense row-major buffer (`width * height * channels`). */
  exportDense(): Uint8Array {
    const c = this.channels;
    const out = new Uint8Array(this.width * this.height * c);
    if (this.fill !== 0) out.fill(this.fill);
    for (const v of this.tileViews()) {
      const ex = Math.min(TILE_SIZE, this.width - v.x);
      const ey = Math.min(TILE_SIZE, this.height - v.y);
      for (let ly = 0; ly < ey; ly++) {
        const src = v.data.subarray(ly * TILE_SIZE * c, (ly * TILE_SIZE + ex) * c);
        out.set(src, ((v.y + ly) * this.width + v.x) * c);
      }
    }
    return out;
  }

  /** Loads a dense buffer: allocates only tiles holding a non-empty pixel. Does not touch `version`. */
  importDense(data: Uint8Array): void {
    const c = this.channels;
    if (data.length !== this.width * this.height * c) {
      throw new RasterError(
        'BAD_DATA',
        `data length ${String(data.length)} != ${String(this.width)}*${String(this.height)}*${String(c)}`,
      );
    }
    for (let ty = 0; ty < this.tilesY; ty++) {
      for (let tx = 0; tx < this.tilesX; tx++) {
        const x0 = tx * TILE_SIZE;
        const y0 = ty * TILE_SIZE;
        const ex = Math.min(TILE_SIZE, this.width - x0);
        const ey = Math.min(TILE_SIZE, this.height - y0);
        let any = false;
        for (let ly = 0; ly < ey && !any; ly++) {
          const start = ((y0 + ly) * this.width + x0) * c;
          for (let i = 0; i < ex * c; i++) {
            if (data[start + i] !== this.fill) {
              any = true;
              break;
            }
          }
        }
        if (!any) continue;
        const buf = this.writable(ty * this.tilesX + tx);
        for (let ly = 0; ly < ey; ly++) {
          const start = ((y0 + ly) * this.width + x0) * c;
          buf.set(data.subarray(start, start + ex * c), ly * TILE_SIZE * c);
        }
      }
    }
    this.markPristine();
  }
}
