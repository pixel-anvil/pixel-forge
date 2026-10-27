/**
 * Transactions: the only way to change a document. A transaction edits a private working copy (an
 * immutable JSON tree plus copy-on-write images); `commit()` diffs it against the state at `begin`
 * into one patch and hands it to the store.
 * @packageDocumentation
 */
import type { TileSnapshot } from '@pixel-forge/raster';
import { ID_SPACE, makeId } from '@pixel-forge/schema';
import type { Document, IdKind, IdOf, ImageId } from '@pixel-forge/schema';
import { openDraft } from './draft.js';
import type { DraftSession } from './draft.js';
import { CoreError } from './errors.js';
import type { ChangeEvent } from './events.js';
import { checkPublished, fillOf, isStoredImage, sameTile } from './images.js';
import type { ImagePatch, StoredImage } from './images.js';
import { checkPath, childOf, formatPath, getAt, isContainer, jsonEqual, seal } from './json.js';
import type { DeepReadonly, JsonContainer, JsonPath, JsonValue } from './json.js';
import { applyOps, diff } from './patch.js';
import type { StructuralOp } from './patch.js';
import type { DocumentView } from './view.js';

/** @internal What a transaction hands its store on commit (never empty). */
export interface TxResult {
  readonly label: string;
  readonly doc: JsonValue;
  readonly ops: readonly StructuralOp[];
  readonly images: readonly ImagePatch[];
  /** New image map entries: an image to publish, or `undefined` to remove the id. */
  readonly publish: ReadonlyMap<ImageId, StoredImage | undefined>;
}

/** @internal The store side of a transaction. */
export interface TxHost {
  committedImage(id: ImageId): StoredImage | undefined;
  committedImageIds(): readonly ImageId[];
  /** Publishes a non-empty result and returns the emitted event. */
  applyTx(tx: Transaction, result: TxResult): ChangeEvent;
  /** Forgets the transaction without changes (cancel, abort, or a commit that changed nothing). */
  releaseTx(tx: Transaction): void;
}

interface Touched {
  /** The committed image when the transaction first touched the id (`undefined`: created here). */
  readonly base: StoredImage | undefined;
  /** The working copy (`undefined`: deleted here). */
  working: StoredImage | undefined;
  /** `working.version` right after it was cloned from `base`. */
  readonly v0: number;
}

/** @internal True for promises and other thenables. */
export function isThenable(v: unknown): boolean {
  return (
    (typeof v === 'object' || typeof v === 'function') &&
    v !== null &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}

function missing(id: ImageId): CoreError {
  return new CoreError('IMAGE_MISSING', `no image ${id}`, { imageId: id });
}

/**
 * An open transaction on a `DocumentStore`. Obtain one with `store.begin(label)` or
 * `store.transact(label, fn)`. One transaction per store at a time (no nesting, no savepoints):
 * helpers that compose operations take a `Transaction` parameter instead of beginning their own.
 *
 * Every mutating call applies at once to the working copy, so later reads (`doc`, `get`, `image`)
 * see it; the committed store state does not change until `commit()`. **Any error thrown by a
 * transaction method aborts the transaction** (as if cancelled; later calls throw `TX_CLOSED`), so
 * validate inputs before mutating.
 */
export class Transaction implements DocumentView {
  /** The label recorded in the history (FR-DOC-02); MCP mutations use `AI: <tool>` (FR-AI-14). */
  readonly label: string;
  private readonly host: TxHost;
  private readonly base: JsonValue;
  private current: JsonValue;
  private readonly touched = new Map<ImageId, Touched>();
  private draft: DraftSession<Document> | undefined;
  /** First error raised by a tx method during an `update` recipe (rethrown even if the recipe caught it). */
  private failure: { error: unknown } | undefined;
  private open = true;
  /** True while a `writeImage` callback runs: no transaction or store call is allowed meanwhile. */
  private imageBusy = false;
  /** The `TX_BUSY` error that aborted the transaction from inside a `writeImage` callback. */
  private busyError: CoreError | undefined;
  /** Ids handed out by `newId` in this transaction. */
  private allocated = 0;
  /** True once `set`/`insert`/`remove` addressed `meta.ids` (or a parent of it) explicitly. */
  private idsEdited = false;

  /** @internal Created by the store. */
  constructor(host: TxHost, label: string, doc: JsonValue) {
    this.host = host;
    this.label = label;
    this.base = doc;
    this.current = doc;
  }

  /** False after `commit`, `cancel` or an aborting error. */
  get isOpen(): boolean {
    return this.open;
  }

  /** @internal True while a `writeImage` callback runs. */
  get busy(): boolean {
    return this.imageBusy;
  }

  /**
   * @internal Aborts the transaction because `what` was called during a `writeImage` callback and
   * returns the `TX_BUSY` error to throw.
   */
  abortBusy(what: string): CoreError {
    const e = new CoreError(
      'TX_BUSY',
      `${what} is not allowed inside a writeImage callback (the transaction was aborted)`,
    );
    this.busyError ??= e;
    if (this.open) this.abort();
    return e;
  }

  /** The working document, including this transaction's edits so far. Frozen. */
  get doc(): DeepReadonly<Document> {
    this.assertOpen();
    return this.current as unknown as DeepReadonly<Document>;
  }

  /** The working value at a JSON path, or `undefined` when it does not resolve. */
  get(path: JsonPath): JsonValue | undefined {
    return this.guard('get', () => getAt(this.current, path), true);
  }

  /**
   * Edits the document through a mutable draft typed as `Document`. Only the nodes the recipe writes
   * are copied; the result is diffed into minimal operations at commit. Inside the recipe you may call
   * `newId` (it advances `draft.meta.ids`) and the image methods, but not `set`, `insert`, `remove`,
   * `update` or `commit` (`TX_BUSY`). Assigning `undefined` throws `BAD_VALUE`: use `delete`. Drafts
   * are revoked when the recipe returns, so do not keep them; compare entities by `id`, not identity.
   */
  update(recipe: (draft: Document) => void): void {
    this.guard('update', () => {
      this.assertNoDraft('update');
      const session = openDraft<Document>(this.current as JsonContainer);
      this.draft = session;
      try {
        const run: (draft: Document) => unknown = recipe;
        const r = run(session.draft);
        if (isThenable(r)) throw new CoreError('TX_ASYNC', 'update recipes are synchronous');
        if (this.failure !== undefined) throw this.failure.error;
        if (session.error !== undefined) throw session.error;
      } catch (e) {
        session.discard();
        throw e;
      } finally {
        this.draft = undefined;
        this.failure = undefined;
      }
      this.current = session.finish();
    });
  }

  /**
   * Sets the value at `path`: replaces an existing value (object key or array index), or adds a new
   * object key. `value` must be plain JSON; it is copied and frozen. Setting an equal value records
   * nothing. Use {@link insert} to grow an array and {@link remove} to delete. `set([], v)` replaces the
   * root, which must be a plain JSON object (`BAD_VALUE` otherwise, as in the store constructor).
   */
  set(path: JsonPath, value: unknown): void {
    this.guard('set', () => {
      this.assertNoDraft('set');
      checkPath(path);
      const v = seal(value);
      this.noteIds(path);
      if (path.length === 0) {
        if (!isContainer(v) || Array.isArray(v)) {
          throw new CoreError('BAD_VALUE', 'a document is a JSON object (set([]) needs an object)');
        }
        this.apply({ op: 'replace', path: [], before: this.current, after: v });
        return;
      }
      const { parent, last } = this.parentOf(path);
      const cur = childOf(parent, last);
      if (Array.isArray(parent) && cur === undefined) {
        throw new CoreError('BAD_PATH', `set ${formatPath(path)}: no such index (use insert)`, {
          path: [...path],
        });
      }
      if (cur === undefined) this.apply({ op: 'add', path: [...path], after: v });
      else if (!jsonEqual(cur, v))
        this.apply({ op: 'replace', path: [...path], before: cur, after: v });
    });
  }

  /** Inserts `value` into the array at `path` (`path[-1]` is the index, `0..length`). */
  insert(path: JsonPath, value: unknown): void {
    this.guard('insert', () => {
      this.assertNoDraft('insert');
      checkPath(path);
      const v = seal(value);
      this.noteIds(path);
      const { parent } = this.parentOf(path);
      if (!Array.isArray(parent)) {
        throw new CoreError('BAD_PATH', `insert ${formatPath(path)}: not an array`, {
          path: [...path],
        });
      }
      this.apply({ op: 'add', path: [...path], after: v });
    });
  }

  /** Removes the object key or the array element (later elements shift left) at `path`. */
  remove(path: JsonPath): void {
    this.guard('remove', () => {
      this.assertNoDraft('remove');
      checkPath(path);
      this.noteIds(path);
      const { parent, last } = this.parentOf(path);
      const cur = childOf(parent, last);
      if (cur === undefined) {
        throw new CoreError('BAD_PATH', `remove ${formatPath(path)}: nothing there`, {
          path: [...path],
        });
      }
      this.apply({ op: 'remove', path: [...path], before: cur });
    });
  }

  /**
   * Allocates the next id of `kind` from `meta.ids` (spec 3.4.12) and advances the counter in the
   * working document. The counter is document state, so undo restores it: an operation run again
   * after an undo, or redone, yields the same ids.
   */
  newId<K extends IdKind>(kind: K): IdOf<K> {
    return this.guard('newId', () => {
      if (this.draft !== undefined) {
        const ids = this.draft.draft.meta.ids;
        const id = nextId(kind, ids.seed, ids.next);
        ids.next += 1;
        this.allocated++;
        return id;
      }
      const ids = (this.current as unknown as Document).meta.ids;
      const id = nextId(kind, ids.seed, ids.next);
      this.apply({
        op: 'replace',
        path: ['meta', 'ids', 'next'],
        before: ids.next,
        after: ids.next + 1,
      });
      this.allocated++;
      return id;
    });
  }

  /** The working image with this id (created or written in this transaction, else the committed one). */
  image(id: ImageId): StoredImage | undefined {
    this.assertOpen();
    const t = this.touched.get(id);
    return t === undefined ? this.host.committedImage(id) : t.working;
  }

  /** Ids of the working images, sorted. */
  imageIds(): readonly ImageId[] {
    this.assertOpen();
    const ids = new Set(this.host.committedImageIds());
    for (const [id, t] of this.touched) {
      if (t.working === undefined) ids.delete(id);
      else ids.add(id);
    }
    return [...ids].sort();
  }

  /**
   * Stores a copy of `image` (a `TiledImage` or `IndexedImage`; the caller keeps its own instance)
   * under a newly allocated `img_` id and returns the id. Referencing it from the document is up to you.
   */
  createImage(image: StoredImage): ImageId {
    return this.guard('createImage', () => {
      if (!isStoredImage(image)) {
        throw new CoreError('BAD_ARGUMENT', 'createImage takes a TiledImage or an IndexedImage');
      }
      const id = this.newId('image');
      if (this.touched.has(id) || this.host.committedImage(id) !== undefined) {
        throw new CoreError('IMAGE_EXISTS', `allocated image id ${id} is already in use`, {
          imageId: id,
        });
      }
      const working = image.clone();
      this.touched.set(id, { base: undefined, working, v0: working.version });
      return id;
    });
  }

  /**
   * Runs `fn` with the mutable working copy of image `id` and returns its result. The first write in
   * a transaction makes an O(tiles) copy-on-write clone; only tiles that are written get copied. Any
   * raster call works (`set`, `composite`, `blit`, `clear`, `restoreTiles`...); the size and kind are
   * fixed. Do not keep the image after `fn` returns.
   *
   * While `fn` runs the working image is half-edited, so the transaction is locked: any call on this
   * transaction other than the reads `doc`, `get`, `image` and `imageIds` (`commit`, `cancel`, `set`,
   * `update`, `newId`, `createImage`, a nested `writeImage`...), and `begin`/`undo`/`redo`/
   * `clearHistory` on the store, throws `TX_BUSY` and aborts the transaction, even if `fn` catches
   * the error (it is rethrown when `fn` returns). The image is never published while `fn` runs.
   */
  writeImage<R>(id: ImageId, fn: (image: StoredImage) => R): R {
    return this.guard('writeImage', () => {
      let t = this.touched.get(id);
      if (t === undefined) {
        const base = this.host.committedImage(id);
        if (base === undefined) throw missing(id);
        checkPublished(id, base);
        const working = base.clone();
        t = { base, working, v0: working.version };
        this.touched.set(id, t);
      }
      const img = t.working;
      if (img === undefined) throw missing(id);
      this.imageBusy = true;
      let r: R;
      try {
        r = fn(img);
      } finally {
        this.imageBusy = false;
      }
      // a transaction call inside the callback aborted us, even if the callback caught its error
      if (this.busyError !== undefined) throw this.busyError;
      if (isThenable(r)) throw new CoreError('TX_ASYNC', 'writeImage callbacks are synchronous');
      return r;
    });
  }

  /** Deletes image `id`. Removing the document's references to it is up to you (`validate()` checks). */
  deleteImage(id: ImageId): void {
    this.guard('deleteImage', () => {
      const t = this.touched.get(id);
      if (t === undefined) {
        const base = this.host.committedImage(id);
        if (base === undefined) throw missing(id);
        checkPublished(id, base);
        this.touched.set(id, { base, working: undefined, v0: base.version });
        return;
      }
      if (t.working === undefined) throw missing(id);
      t.working = undefined;
    });
  }

  /**
   * Commits: diffs the working copy against the state at `begin` into one patch, publishes it, records
   * one history entry, adds 1 to the store `version` and emits a change event, which is returned. A
   * transaction whose net effect is nothing records and emits nothing and returns `undefined`; ids
   * allocated by such a transaction are not consumed (only when `meta.ids.next` moved exactly by the
   * `newId` calls and was not edited explicitly; an explicit edit of `meta.ids` commits).
   * @throws CoreError `TX_BUSY` inside a `writeImage` callback, `IMAGE_MUTATED` if a published base
   *   image was mutated outside a transaction (the transaction is aborted).
   */
  commit(): ChangeEvent | undefined {
    return this.guard('commit', () => {
      this.assertNoDraft('commit');
      const ops: StructuralOp[] = [];
      diff(this.base, this.current, [], ops);
      const images: ImagePatch[] = [];
      const publish = new Map<ImageId, StoredImage | undefined>();
      const touched = [...this.touched].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [id, { base, working, v0 }] of touched) {
        // a published image mutated behind the store's back would poison `before`: fail now, not later
        if (base !== undefined) checkPublished(id, base);
        if (base === undefined) {
          if (working === undefined) continue;
          images.push({ kind: 'create', id, image: working });
          publish.set(id, working);
        } else if (working === undefined) {
          images.push({ kind: 'delete', id, image: base });
          publish.set(id, undefined);
        } else {
          const patch = tilesPatch(id, base, working, v0);
          if (patch === undefined) continue;
          images.push(patch);
          publish.set(id, working);
        }
      }
      if (images.length === 0 && (ops.length === 0 || this.onlyAllocations(ops))) {
        this.close();
        return undefined;
      }
      this.open = false;
      return this.host.applyTx(this, {
        label: this.label,
        doc: this.current,
        ops,
        images,
        publish,
      });
    });
  }

  /**
   * Discards every edit. Does nothing on a closed transaction, so it is safe in `finally`.
   * @throws CoreError `TX_BUSY` (and aborts) when called inside a `writeImage` callback.
   */
  cancel(): void {
    if (!this.open) return;
    if (this.imageBusy) throw this.abortBusy('cancel');
    this.abort();
  }

  private abort(): void {
    this.draft?.discard();
    this.close();
  }

  private close(): void {
    this.open = false;
    this.draft = undefined;
    this.touched.clear();
    this.host.releaseTx(this);
  }

  private assertOpen(): void {
    if (!this.open) throw new CoreError('TX_CLOSED', `transaction "${this.label}" is closed`);
  }

  private assertNoDraft(what: string): void {
    if (this.draft !== undefined) {
      throw new CoreError('TX_BUSY', `${what} is not allowed inside an update recipe`);
    }
  }

  /**
   * Runs `fn` on an open transaction. An error aborts the transaction; inside an `update` recipe it is
   * remembered and the abort happens when the recipe returns (even if the recipe caught the error).
   */
  private guard<R>(what: string, fn: () => R, readOnly = false): R {
    this.assertOpen();
    if (this.imageBusy && !readOnly) throw this.abortBusy(what);
    try {
      return fn();
    } catch (e) {
      if (this.open) {
        if (this.draft === undefined) this.abort();
        else this.failure ??= { error: e };
      }
      throw e;
    }
  }

  /** Remembers that the caller addressed `meta.ids` (or `meta`, or the root) by path. */
  private noteIds(path: JsonPath): void {
    if (path.length === 0 || (path[0] === 'meta' && (path.length === 1 || path[1] === 'ids'))) {
      this.idsEdited = true;
    }
  }

  /**
   * True when the only change is `meta.ids.next` and it moved exactly by this transaction's `newId`
   * calls: the ids were stored nowhere, so they can be handed out again and the transaction is a
   * no-op. An explicit edit of `meta.ids` (`set`, or a recipe that sets another value) is a change.
   */
  private onlyAllocations(ops: readonly StructuralOp[]): boolean {
    const [op] = ops;
    return (
      !this.idsEdited &&
      this.allocated > 0 &&
      ops.length === 1 &&
      op?.op === 'replace' &&
      op.path.length === 3 &&
      op.path[0] === 'meta' &&
      op.path[1] === 'ids' &&
      op.path[2] === 'next' &&
      typeof op.before === 'number' &&
      op.after === op.before + this.allocated
    );
  }

  private parentOf(path: JsonPath): { parent: JsonContainer; last: string | number } {
    if (path.length === 0) throw new CoreError('BAD_PATH', 'this operation needs a non-empty path');
    const parent = getAt(this.current, path.slice(0, -1));
    if (parent === undefined || !isContainer(parent)) {
      throw new CoreError('BAD_PATH', `no container at ${formatPath(path.slice(0, -1))}`, {
        path: [...path],
      });
    }
    const last = path.at(-1);
    if (last === undefined)
      throw new CoreError('BAD_PATH', 'this operation needs a non-empty path');
    return { parent, last };
  }

  private apply(op: StructuralOp): void {
    this.current = applyOps(this.current, [op], false);
  }
}

function nextId<K extends IdKind>(kind: K, seed: number, next: number): IdOf<K> {
  if (next >= ID_SPACE) {
    throw new CoreError('ID_EXHAUSTED', 'the document id counter is exhausted (2^30 ids)');
  }
  return makeId(kind, seed, next);
}

/**
 * The tile patch of an image written in a transaction (the raster recipe: changed tiles since `v0`,
 * captured on the committed base and on the working copy), without tiles whose bytes did not change.
 * `undefined` when nothing changed.
 */
function tilesPatch(
  id: ImageId,
  base: StoredImage,
  working: StoredImage,
  v0: number,
): ImagePatch | undefined {
  const changed = working.tilesChanged(v0);
  if (changed.length === 0) return undefined;
  const before = base.captureTiles(changed);
  const after = working.captureTiles(changed);
  const fill = fillOf(base);
  const keepBefore: TileSnapshot[] = [];
  const keepAfter: TileSnapshot[] = [];
  for (const [i, b] of before.entries()) {
    const a = after[i];
    if (a === undefined || sameTile(b.data, a.data, fill)) continue;
    keepBefore.push(b);
    keepAfter.push(a);
  }
  return keepBefore.length === 0
    ? undefined
    : { kind: 'tiles', id, before: keepBefore, after: keepAfter };
}
