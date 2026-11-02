/**
 * Image store helpers: the stored image type, image patches (tile before/after, create, delete) and
 * the guard that detects a published image being mutated outside a transaction.
 * @packageDocumentation
 */
import { IndexedImage, TiledImage, sha256Hex } from '@pixel-forge/raster';
import type { TileSnapshot } from '@pixel-forge/raster';
import type { ImageId } from '@pixel-forge/schema';
import { CoreError } from './errors.js';

/**
 * An image held by the store: RGBA8 ({@link TiledImage}) or palette indices ({@link IndexedImage}).
 *
 * **Immutable by contract.** Every instance returned by a store, snapshot or history entry is never
 * mutated again by core: commits, undo and redo publish a new copy-on-write instance instead. Callers
 * must not mutate it either (use `tx.writeImage`); the store detects a mutation through `version`
 * and throws `IMAGE_MUTATED` the next time it touches that image.
 */
export type StoredImage = TiledImage | IndexedImage;

/** Read access to a document's images. Implemented by the store, its snapshots and transactions. */
export interface ImageSource {
  /** The image with this id, or `undefined`. Never mutate the result. */
  image(id: ImageId): StoredImage | undefined;
}

/** Tile before/after of one image written in a transaction (only tiles whose bytes changed). */
export interface TilesPatch {
  readonly kind: 'tiles';
  readonly id: ImageId;
  /** Content before the transaction; `data: undefined` is an absent (empty) tile. */
  readonly before: readonly TileSnapshot[];
  /** Content after the transaction, same coordinates and order as `before`. */
  readonly after: readonly TileSnapshot[];
}

/** An image created by a transaction; undo removes it, redo puts this same instance back. */
export interface CreateImagePatch {
  readonly kind: 'create';
  readonly id: ImageId;
  readonly image: StoredImage;
}

/** An image deleted by a transaction; undo puts this same instance back. */
export interface DeleteImagePatch {
  readonly kind: 'delete';
  readonly id: ImageId;
  readonly image: StoredImage;
}

/** One image change. A patch has at most one image patch per image id, sorted by id. */
export type ImagePatch = TilesPatch | CreateImagePatch | DeleteImagePatch;

/** True for the two raster image classes the store accepts. */
export function isStoredImage(v: unknown): v is StoredImage {
  return v instanceof TiledImage || v instanceof IndexedImage;
}

/** The byte an absent tile reads as: 0 for RGBA, `transparentIndex` for indexed. */
export function fillOf(img: StoredImage): number {
  return img instanceof IndexedImage ? img.transparentIndex : 0;
}

/** True when two tile snapshots hold the same pixels (an absent tile equals an all-`fill` buffer). */
export function sameTile(
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
  fill: number,
): boolean {
  if (a === b) return true;
  const n = a?.length ?? b?.length ?? 0;
  for (let i = 0; i < n; i++) {
    if ((a === undefined ? fill : a[i]) !== (b === undefined ? fill : b[i])) return false;
  }
  return true;
}

/** Distinct tile buffers currently allocated in `img`, row-major. */
export function tileBuffers(img: StoredImage): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const t of img.tiles()) out.push(t.data);
  return out;
}

/** Records the version of every image the store publishes, to detect mutations outside transactions. */
const PUBLISHED = new WeakMap<StoredImage, number>();

/** Marks `img` as published (immutable from now on) and returns it. */
export function publish<T extends StoredImage>(img: T): T {
  PUBLISHED.set(img, img.version);
  return img;
}

/** True when `img` was published by a store and has not been mutated since (safe to share). */
export function isPublished(img: StoredImage): boolean {
  return PUBLISHED.get(img) === img.version;
}

/** Throws `IMAGE_MUTATED` when a published image's `version` moved since it was published. */
export function checkPublished(id: ImageId, img: StoredImage): void {
  const v = PUBLISHED.get(img);
  if (v !== undefined && v !== img.version) {
    throw new CoreError(
      'IMAGE_MUTATED',
      `image ${id} was mutated outside a transaction (version ${String(v)} -> ${String(img.version)}); use tx.writeImage`,
      { imageId: id },
    );
  }
}

const HASHES = new WeakMap<StoredImage, { version: number; hash: string }>();

/**
 * Content hash of one image: `hashRGBA` (ADR-010 layout) for RGBA; for indexed, SHA-256 over
 * `u32be width, u32be height, u8 transparentIndex, indices`. Memoised per instance and version.
 */
export function imageHash(img: StoredImage): string {
  const memo = HASHES.get(img);
  if (memo?.version === img.version) return memo.hash;
  let hash: string;
  if (img instanceof TiledImage) {
    hash = img.hashRGBA();
  } else {
    const idx = img.toIndices();
    const buf = new Uint8Array(9 + idx.length);
    const view = new DataView(buf.buffer);
    view.setUint32(0, img.width);
    view.setUint32(4, img.height);
    buf[8] = img.transparentIndex;
    buf.set(idx, 9);
    hash = sha256Hex(buf);
  }
  HASHES.set(img, { version: img.version, hash });
  return hash;
}
