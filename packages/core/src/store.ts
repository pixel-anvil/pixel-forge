/**
 * The document store: the committed immutable document, its copy-on-write images, the version
 * counter, the linear history and change events.
 * @packageDocumentation
 */
import type { Document, ImageId } from '@pixel-forge/schema';
import { CoreError } from './errors.js';
import { eventPatch } from './events.js';
import type { ChangeEvent, ChangeKind, ChangeListener } from './events.js';
import { History, invertPatch } from './history.js';
import type { HistoryEntry, HistoryInfo, Patch } from './history.js';
import { checkPublished, fillOf, isPublished, isStoredImage, publish, sameTile } from './images.js';
import type { ImagePatch, StoredImage } from './images.js';
import { isContainer, seal } from './json.js';
import type { DeepReadonly, JsonValue } from './json.js';
import { applyOps } from './patch.js';
import type { StructuralOp } from './patch.js';
import { Transaction, isThenable } from './transaction.js';
import type { TxHost, TxResult } from './transaction.js';
import type { DocumentSnapshot, DocumentView } from './view.js';

/** Options of {@link DocumentStore}. */
export interface StoreOptions {
  /**
   * The document's images. An image already published by a store (for example from another store's
   * snapshot, to fork it) is shared as is; any other instance is cloned (copy-on-write, O(tiles)), so
   * the caller may keep using its own.
   */
  readonly images?: Iterable<readonly [ImageId, StoredImage]>;
  /** History memory cap in bytes (default 512 MiB, FR-DOC-02); `Infinity` disables eviction. */
  readonly memoryCap?: number;
}

interface Subscription {
  readonly fn: ChangeListener;
  active: boolean;
}

function freezePatch(ops: readonly StructuralOp[], images: readonly ImagePatch[]): Patch {
  for (const op of ops) {
    Object.freeze(op.path);
    Object.freeze(op);
  }
  for (const p of images) {
    if (p.kind === 'tiles') {
      for (const s of p.before) Object.freeze(s);
      for (const s of p.after) Object.freeze(s);
      Object.freeze(p.before);
      Object.freeze(p.after);
    }
    Object.freeze(p);
  }
  return Object.freeze({ ops: Object.freeze([...ops]), images: Object.freeze([...images]) });
}

/**
 * A read-only view of one image map. The store never mutates a map after publishing it (every image
 * change builds a new one), so the view is O(1) and keeps showing the map it was made for. It has no
 * way to reach the underlying `Map`, and the mutators of a `Map` throw.
 */
class ImageMapView implements ReadonlyMap<ImageId, StoredImage> {
  readonly #map: ReadonlyMap<ImageId, StoredImage>;

  constructor(map: ReadonlyMap<ImageId, StoredImage>) {
    this.#map = map;
    Object.freeze(this);
  }

  get size(): number {
    return this.#map.size;
  }

  get(id: ImageId): StoredImage | undefined {
    return this.#map.get(id);
  }

  has(id: ImageId): boolean {
    return this.#map.has(id);
  }

  forEach(
    fn: (image: StoredImage, id: ImageId, map: ReadonlyMap<ImageId, StoredImage>) => void,
    thisArg?: unknown,
  ): void {
    this.#map.forEach((image, id) => {
      fn.call(thisArg, image, id, this);
    });
  }

  entries(): MapIterator<[ImageId, StoredImage]> {
    return this.#map.entries();
  }

  keys(): MapIterator<ImageId> {
    return this.#map.keys();
  }

  values(): MapIterator<StoredImage> {
    return this.#map.values();
  }

  [Symbol.iterator](): MapIterator<[ImageId, StoredImage]> {
    return this.#map.entries();
  }

  /** @throws CoreError `BAD_ARGUMENT`: a snapshot's images are read-only. */
  set(): never {
    throw readOnly();
  }

  /** @throws CoreError `BAD_ARGUMENT`: a snapshot's images are read-only. */
  delete(): never {
    throw readOnly();
  }

  /** @throws CoreError `BAD_ARGUMENT`: a snapshot's images are read-only. */
  clear(): never {
    throw readOnly();
  }
}

function readOnly(): CoreError {
  return new CoreError('BAD_ARGUMENT', 'a snapshot is read-only; its images cannot be changed');
}

function conflict(id: ImageId, message: string): CoreError {
  return new CoreError('PATCH_CONFLICT', `image ${id}: ${message}`, { imageId: id });
}

/**
 * Holds one document: the committed JSON (immutable, structurally shared between versions), an image
 * store mapping `ImageId` to copy-on-write images, a `version`, one linear undo/redo history with a
 * memory cap (FR-DOC-02) and synchronous change events. All changes go through transactions.
 *
 * ```ts
 * const store = new DocumentStore(doc, { images });
 * store.transact('Set duration', (tx) => {
 *   tx.update((d) => { d.animations[0]!.frames[0]!.durationMs = 120 });
 * });
 * store.undo();
 * ```
 */
export class DocumentStore implements DocumentView {
  private current: JsonValue;
  private imageMap: Map<ImageId, StoredImage>;
  private sortedIds: readonly ImageId[] | undefined;
  private imagesView: ReadonlyMap<ImageId, StoredImage> | undefined;
  private ver = 0;
  private active: Transaction | undefined;
  private readonly hist: History;
  private readonly listeners: Subscription[] = [];
  private dispatching = false;
  private readonly host: TxHost;

  /**
   * Creates a store at version 0 with an empty history. The document is copied and frozen once
   * (sealed sub-trees, such as another store's snapshot, are shared). It is not validated here:
   * parse it with the schema (io does) and run `validate()` first.
   * @throws CoreError `BAD_VALUE` (not plain JSON), `BAD_ARGUMENT` (not an image, bad cap),
   *   `IMAGE_EXISTS` (duplicate image id).
   */
  constructor(doc: Document | DeepReadonly<Document>, options: StoreOptions = {}) {
    const sealed = seal(doc);
    if (!isContainer(sealed) || Array.isArray(sealed)) {
      throw new CoreError('BAD_VALUE', 'a document is a JSON object');
    }
    this.current = sealed;
    this.hist = new History(options.memoryCap);
    this.imageMap = new Map();
    for (const [id, img] of options.images ?? []) {
      if (!isStoredImage(img)) {
        throw new CoreError('BAD_ARGUMENT', `image ${id} is not a TiledImage or IndexedImage`);
      }
      if (this.imageMap.has(id)) {
        throw new CoreError('IMAGE_EXISTS', `duplicate image id ${id}`, { imageId: id });
      }
      this.imageMap.set(id, isPublished(img) ? img : publish(img.clone()));
    }
    this.host = {
      committedImage: (id) => this.imageMap.get(id),
      committedImageIds: () => this.imageIds(),
      applyTx: (tx, result) => this.applyTx(tx, result),
      releaseTx: (tx) => {
        if (this.active === tx) this.active = undefined;
      },
    };
  }

  /** The committed document. Deeply frozen; a new object after each change (untouched parts shared). */
  get doc(): DeepReadonly<Document> {
    return this.current as unknown as DeepReadonly<Document>;
  }

  /**
   * Monotonic change counter, 0 at creation, +1 per committed transaction, undo and redo (a no-op
   * transaction leaves it unchanged). Runtime state: it is not stored in the document.
   */
  get version(): number {
    return this.ver;
  }

  /** The committed image with this id, or `undefined`. Immutable by contract: never mutate it. */
  image(id: ImageId): StoredImage | undefined {
    return this.imageMap.get(id);
  }

  /** Ids of the committed images, sorted. */
  imageIds(): readonly ImageId[] {
    this.sortedIds ??= Object.freeze([...this.imageMap.keys()].sort());
    return this.sortedIds;
  }

  /** The committed state as an O(1), never-changing snapshot. */
  snapshot(): DocumentSnapshot {
    this.imagesView ??= new ImageMapView(this.imageMap);
    const images = this.imagesView;
    const ids = this.imageIds();
    return Object.freeze({
      version: this.ver,
      doc: this.doc,
      images,
      image: (id: ImageId) => images.get(id),
      imageIds: () => ids,
    });
  }

  /** The open transaction, if any. */
  get transaction(): Transaction | undefined {
    return this.active;
  }

  /**
   * Opens a transaction labelled `label` (shown in the history, e.g. `AI: rig.setPose`).
   * @throws CoreError `TX_ACTIVE` if one is already open (transactions do not nest), `TX_BUSY`
   *   from inside a change listener or an image callback, `BAD_ARGUMENT` for an empty label.
   */
  begin(label: string): Transaction {
    this.assertIdle('begin');
    if (typeof label !== 'string' || label.length === 0) {
      throw new CoreError('BAD_ARGUMENT', 'a transaction needs a non-empty label');
    }
    const tx = new Transaction(this.host, label, this.current);
    this.active = tx;
    return tx;
  }

  /**
   * Runs `fn` in a new transaction and commits it (unless `fn` closed it itself); if `fn` throws, the
   * transaction is cancelled and the error rethrown. `fn` must be synchronous (`TX_ASYNC` otherwise).
   * Returns what `fn` returns. This is how op handlers run (FR-AI-14: one call, one transaction).
   */
  transact<R>(label: string, fn: (tx: Transaction) => R): R {
    const tx = this.begin(label);
    let result: R;
    try {
      result = fn(tx);
    } catch (e) {
      tx.cancel();
      throw e;
    }
    if (isThenable(result)) {
      tx.cancel();
      throw new CoreError('TX_ASYNC', 'transact callbacks are synchronous');
    }
    if (tx.isOpen) tx.commit();
    return result;
  }

  /** True when there is an applied history entry to undo. */
  get canUndo(): boolean {
    return this.hist.canUndo;
  }

  /** True when there is an undone entry to redo. */
  get canRedo(): boolean {
    return this.hist.canRedo;
  }

  /**
   * Reverts the newest applied entry (its inverse patch), bumps `version` and emits an `undo` event,
   * which is returned. Returns `undefined` when there is nothing to undo.
   * @throws CoreError `TX_ACTIVE` while a transaction is open; `TX_BUSY` from inside a change
   *   listener; `IMAGE_MUTATED` or `PATCH_CONFLICT` if the state no longer matches the history (the
   *   store is left unchanged). A listener error is thrown after the undo is applied.
   */
  undo(): ChangeEvent | undefined {
    this.assertIdle('undo');
    const entry = this.hist.peekUndo();
    if (entry === undefined) return undefined;
    const inverse = invertPatch(entry.patch);
    this.applyPatch(inverse);
    this.hist.markUndone();
    return this.emit('undo', entry, freezePatch(inverse.ops, inverse.images));
  }

  /** Re-applies the next undone entry; like {@link undo}, with a `redo` event. */
  redo(): ChangeEvent | undefined {
    this.assertIdle('redo');
    const entry = this.hist.peekRedo();
    if (entry === undefined) return undefined;
    this.applyPatch(entry.patch);
    this.hist.markRedone();
    return this.emit('redo', entry, entry.patch);
  }

  /** History entries (oldest first) and memory use, for a UI or a status line. */
  historyInfo(): HistoryInfo {
    return this.hist.info();
  }

  /**
   * Sets the history memory cap in bytes (applies to undo and redo entries together) and evicts at
   * once if needed: the entry farthest from the current position goes first, and the newest applied
   * entry is never evicted (see the README, "History and memory").
   * @throws CoreError `TX_BUSY` from inside a change listener, `BAD_ARGUMENT` for a bad cap.
   */
  setMemoryCap(bytes: number): void {
    this.assertNotDispatching('setMemoryCap');
    this.hist.setCap(bytes);
  }

  /** Drops the whole history (both sides). The document and `version` are unchanged. */
  clearHistory(): void {
    this.assertIdle('clearHistory');
    this.hist.clear();
  }

  /**
   * Calls `listener` synchronously after every commit, undo and redo, in version order, and returns an
   * unsubscribe function. Every listener of an event sees `store.version === event.version`.
   *
   * **Listeners must not change the store**: `begin`, `transact`, `undo`, `redo`, `clearHistory` and
   * `setMemoryCap` throw `TX_BUSY` while an event is being delivered (schedule follow-up changes
   * asynchronously, e.g. in a microtask). Reads, `snapshot()` and (un)subscribing are fine. If
   * listeners throw, the others still run; the error (or an `AggregateError`) is then rethrown to
   * the caller of the change that produced the event only, and that change is already applied.
   */
  subscribe(listener: ChangeListener): () => void {
    if (typeof listener !== 'function') {
      throw new CoreError('BAD_ARGUMENT', 'subscribe takes a function');
    }
    const sub: Subscription = { fn: listener, active: true };
    this.listeners.push(sub);
    return () => {
      if (!sub.active) return;
      sub.active = false;
      this.listeners.splice(this.listeners.indexOf(sub), 1);
    };
  }

  private assertNotDispatching(what: string): void {
    if (this.dispatching) {
      throw new CoreError(
        'TX_BUSY',
        `${what}: not allowed inside a change listener (schedule follow-up changes asynchronously)`,
      );
    }
  }

  private assertIdle(what: string): void {
    this.assertNotDispatching(what);
    if (this.active?.busy === true) throw this.active.abortBusy(what);
    if (this.active !== undefined) {
      throw new CoreError(
        'TX_ACTIVE',
        `${what}: transaction "${this.active.label}" is open (transactions do not nest)`,
      );
    }
  }

  /** Installs a new image map; the sorted ids are dropped only when the set of ids changed. */
  private setImages(next: Map<ImageId, StoredImage>, idsChanged: boolean): void {
    this.imageMap = next;
    this.imagesView = undefined;
    if (idsChanged) this.sortedIds = undefined;
  }

  private applyTx(tx: Transaction, result: TxResult): ChangeEvent {
    if (this.active !== tx) throw new CoreError('TX_CLOSED', 'not the open transaction');
    this.active = undefined;
    let next = this.imageMap;
    let idsChanged = false;
    if (result.publish.size > 0) {
      next = new Map(this.imageMap);
      for (const [id, img] of result.publish) {
        if (img === undefined) {
          next.delete(id);
          idsChanged = true;
        } else {
          idsChanged ||= !next.has(id);
          next.set(id, publish(img));
        }
      }
    }
    const patch = freezePatch(result.ops, result.images);
    const entry = this.hist.record(result.label, patch);
    this.current = result.doc;
    if (next !== this.imageMap) this.setImages(next, idsChanged);
    return this.emit('commit', entry, patch);
  }

  /** Applies a patch strictly to the committed state; on any error nothing changes. */
  private applyPatch(patch: Patch): void {
    const doc = applyOps(this.current, patch.ops, true);
    let next = this.imageMap;
    let idsChanged = false;
    if (patch.images.length > 0) {
      next = new Map(this.imageMap);
      for (const p of patch.images) {
        const cur = next.get(p.id);
        switch (p.kind) {
          case 'create':
            if (cur !== undefined) throw conflict(p.id, 'already exists');
            checkPublished(p.id, p.image);
            next.set(p.id, publish(p.image));
            idsChanged = true;
            break;
          case 'delete':
            if (cur === undefined) throw conflict(p.id, 'missing');
            checkPublished(p.id, cur);
            next.delete(p.id);
            idsChanged = true;
            break;
          case 'tiles': {
            if (cur === undefined) throw conflict(p.id, 'missing');
            checkPublished(p.id, cur);
            const now = cur.captureTiles(p.before);
            const fill = fillOf(cur);
            for (const [i, snap] of now.entries()) {
              if (!sameTile(snap.data, p.before[i]?.data, fill)) {
                throw conflict(p.id, `tile (${String(snap.tx)}, ${String(snap.ty)}) differs`);
              }
            }
            const img = cur.clone();
            img.restoreTiles(p.after);
            next.set(p.id, publish(img));
            break;
          }
        }
      }
    }
    this.current = doc;
    if (next !== this.imageMap) this.setImages(next, idsChanged);
  }

  private emit(kind: ChangeKind, entry: HistoryEntry, patch: Patch): ChangeEvent {
    this.ver++;
    const event: ChangeEvent = Object.freeze({
      kind,
      version: this.ver,
      label: entry.label,
      entryId: entry.id,
      patch: eventPatch(patch),
      paths: Object.freeze(patch.ops.map((op) => op.path)),
      imageIds: Object.freeze(patch.images.map((p) => p.id)),
    });
    this.dispatch(event);
    return event;
  }

  /**
   * Delivers one event to every listener. Store changes are refused meanwhile (`TX_BUSY`), so there is
   * never a second event in flight and every listener sees `store.version === event.version`.
   */
  private dispatch(event: ChangeEvent): void {
    const errors: unknown[] = [];
    this.dispatching = true;
    try {
      for (const sub of [...this.listeners]) {
        if (!sub.active) continue;
        try {
          sub.fn(event);
        } catch (e) {
          errors.push(e);
        }
      }
    } finally {
      this.dispatching = false;
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'change listeners failed');
  }
}
