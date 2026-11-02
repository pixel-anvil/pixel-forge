/**
 * Change events emitted by the document store.
 * @packageDocumentation
 */
import type { TileSnapshot } from '@pixel-forge/raster';
import type { ImageId } from '@pixel-forge/schema';
import type { Patch } from './history.js';
import type { ImagePatch } from './images.js';
import type { JsonPath } from './json.js';

/** What produced a change: a committed transaction, an undo or a redo. */
export type ChangeKind = 'commit' | 'undo' | 'redo';

/**
 * Emitted synchronously after every state change, in version order. A transaction that changed
 * nothing emits nothing.
 */
export interface ChangeEvent {
  readonly kind: ChangeKind;
  /** The store version after the change (each change adds exactly 1). */
  readonly version: number;
  /** Label of the history entry that was committed, undone or redone. */
  readonly label: string;
  /** Id of that history entry. */
  readonly entryId: number;
  /**
   * The patch as applied to the previous state: the forward patch for `commit` and `redo`, the inverse
   * for `undo`. Applying the patches of all events in version order replays the document (editor sync).
   *
   * Listeners get a read-only *view*: structural operations are the frozen, shared ones, but the tile
   * buffers (`TileSnapshot.data`) and the images of `create`/`delete` patches are handed out as fresh
   * copies on every access (`data` is copied, `image` is a copy-on-write clone), so a listener can
   * neither corrupt the history nor the live document. Read `data` once into a local variable.
   */
  readonly patch: Patch;
  /** Paths of the structural operations, in patch order (not de-duplicated). */
  readonly paths: readonly JsonPath[];
  /** Ids of the images created, deleted or written, sorted. */
  readonly imageIds: readonly ImageId[];
}

/** A change listener. Called synchronously; see `DocumentStore.subscribe`. */
export type ChangeListener = (event: ChangeEvent) => void;

const VIEWS = new WeakMap<Patch, Patch>();

function snapshotView(s: TileSnapshot): TileSnapshot {
  return Object.freeze({
    tx: s.tx,
    ty: s.ty,
    get data(): Uint8Array | undefined {
      return s.data?.slice();
    },
  });
}

function lazyList(src: readonly TileSnapshot[]): () => readonly TileSnapshot[] {
  let list: readonly TileSnapshot[] | undefined;
  return () => (list ??= Object.freeze(src.map(snapshotView)));
}

function imagePatchView(p: ImagePatch): ImagePatch {
  if (p.kind === 'tiles') {
    const before = lazyList(p.before);
    const after = lazyList(p.after);
    return Object.freeze({
      kind: 'tiles' as const,
      id: p.id,
      get before() {
        return before();
      },
      get after() {
        return after();
      },
    });
  }
  return Object.freeze({
    kind: p.kind,
    id: p.id,
    get image() {
      return p.image.clone();
    },
  });
}

/**
 * The patch as listeners see it (see {@link ChangeEvent.patch}): same operations, with tile buffers
 * and images copied lazily on access. Memoised per patch, so a commit and its redo share one view.
 * @internal
 */
export function eventPatch(patch: Patch): Patch {
  let v = VIEWS.get(patch);
  if (v === undefined) {
    v = Object.freeze({ ops: patch.ops, images: Object.freeze(patch.images.map(imagePatchView)) });
    VIEWS.set(patch, v);
  }
  return v;
}
