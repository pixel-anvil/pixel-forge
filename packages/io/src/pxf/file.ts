/**
 * The in-memory form of a `.pxf` file: what `readPxf` returns and what `writePxf` takes as `previous`.
 * @packageDocumentation
 */
import { DocumentStore, documentHash } from '@pixel-forge/core';
import type { DeepReadonly, DocumentView, StoreOptions, StoredImage } from '@pixel-forge/core';
import type { Document, ImageId, Manifest, RenderIndex } from '@pixel-forge/schema';

/** Version written to `manifest.json` `app` as `pixel-forge <version>`; a test keeps it equal to `package.json`. */
export const PIXEL_FORGE_VERSION = '0.0.0';

/** The `manifest.json` `app` value this build writes. */
export const PXF_APP = `pixel-forge ${PIXEL_FORGE_VERSION}`;

/**
 * A `.pxf` file held in memory, as read or as just written. Treat it as immutable: it is the
 * `previous` of the next `writePxf` (which decides `modified` and which render PNGs can be reused).
 */
export interface PxfFile {
  readonly manifest: Manifest;
  /** The document (no pixels). */
  readonly doc: DeepReadonly<Document>;
  /** Every `images/<id>.png`: `IndexedImage` for 8-bit grayscale PNGs, `TiledImage` for RGBA. */
  readonly images: ReadonlyMap<ImageId, StoredImage>;
  /** The PNG bytes of each image as stored in the file (reused while the pixels are unchanged). */
  readonly imagePngs: ReadonlyMap<ImageId, Uint8Array>;
  /** `render/index.json`, when the file has a (valid) render cache. */
  readonly renderIndex?: RenderIndex;
  /**
   * The cached frame PNGs, keyed by path relative to `render/`, e.g. `base/run/side/0.png`
   * (`<skin>/<index.json image path>`).
   */
  readonly renderPngs: ReadonlyMap<string, Uint8Array>;
  /** Non-fatal problems found while reading (for example an unreadable render cache). */
  readonly warnings: readonly string[];
}

/** A read-only {@link DocumentView} (doc + images) of a file, for `renderFrame`, `documentHash`, … */
export function pxfView(file: PxfFile): DocumentView {
  const ids = [...file.images.keys()].sort();
  return {
    doc: file.doc,
    image: (id) => file.images.get(id),
    imageIds: () => ids,
  };
}

const HASHES = new WeakMap<PxfFile, string>();

/** `documentHash` of the file's document and images (memoised per file). */
export function pxfContentHash(file: PxfFile): string {
  let h = HASHES.get(file);
  if (h === undefined) {
    h = documentHash(pxfView(file));
    HASHES.set(file, h);
  }
  return h;
}

/**
 * A new `DocumentStore` holding the file's document and images (images are shared copy-on-write, so
 * editing the store never touches `file`). Pass the same `file` as `previous` when saving.
 */
export function pxfStore(file: PxfFile, options: Omit<StoreOptions, 'images'> = {}): DocumentStore {
  return new DocumentStore(file.doc, { ...options, images: file.images });
}
