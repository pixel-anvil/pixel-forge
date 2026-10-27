/**
 * Read-only views of a document: the store, an immutable snapshot, or an open transaction.
 * @packageDocumentation
 */
import type { Document, ImageId } from '@pixel-forge/schema';
import type { ImageSource, StoredImage } from './images.js';
import type { DeepReadonly } from './json.js';

/**
 * A document plus its images, read-only. Implemented by `DocumentStore` (the committed state),
 * {@link DocumentSnapshot} (a frozen point in time) and `Transaction` (the working state). Pure
 * functions such as `renderFrame` and `documentHash` take a `DocumentView`, so they work on all three.
 */
export interface DocumentView extends ImageSource {
  /** The document JSON. Deeply frozen. */
  readonly doc: DeepReadonly<Document>;
  /** Ids of every stored image, sorted. */
  imageIds(): readonly ImageId[];
}

/**
 * The committed state at one `version`. O(1) to take and never changes afterwards: the document is
 * frozen and published images are immutable. Keep it to compare, render or fork later.
 */
export interface DocumentSnapshot extends DocumentView {
  /** Store version at the time of the snapshot. */
  readonly version: number;
  /** The image map at the time of the snapshot (never mutated). */
  readonly images: ReadonlyMap<ImageId, StoredImage>;
}
