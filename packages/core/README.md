# @pixel-forge/core

Document store, transactions, patches, history, frame operations, validate() and renderFrame.

**Depends on:** `schema`, `raster`, `rig` (rig: not used yet; the rig hook is defined here). Pure: no DOM, no Node built-ins, no `Math.random`, no `Date.now`.

**Status:** store, transactions, patches, history, events, `documentHash` and the `RigRenderer` hook interface (T2.1). Frame operations and `validate()` (T2.2) and `renderFrame` (T2.3) come next.

## Use

```ts
import { DocumentStore, documentHash } from '@pixel-forge/core';

const store = new DocumentStore(doc, { images }); // doc: a parsed schema Document; images: [ImageId, TiledImage | IndexedImage][]
store.subscribe((e) => console.log(e.kind, e.version, e.label, e.paths));

store.transact('Insert frame', (tx) => {
  const id = tx.newId('frame'); // from meta.ids: undo/redo replay the same ids
  tx.update((d) => {
    const anim = d.animations.find((a) => a.id === animId);
    if (anim && 'frames' in anim)
      anim.frames.splice(2, 0, {
        id,
        durationMs: 100,
        markers: {},
        events: [],
        rootMotion: { dx: 0, dy: 0 },
        boneKeys: {},
        partKeys: {},
      });
  });
  tx.writeImage(imageId, (img) => {
    if (img instanceof TiledImage) img.set(3, 4, [255, 0, 0, 255]); // IndexedImage takes an index
  });
});
store.undo(); // store.redo()
documentHash(store); // deterministic fingerprint of doc + images
```

## API

| Area           | Exports                                                                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store          | `DocumentStore(doc, {images?, memoryCap?})`: `doc`, `version`, `image(id)`, `imageIds()`, `snapshot()`, `begin(label)`, `transact(label, fn)`, `transaction`, `undo()`, `redo()`, `canUndo`, `canRedo`, `historyInfo()`, `setMemoryCap(bytes)`, `clearHistory()`, `subscribe(listener)` |
| Transaction    | `doc`, `get(path)`, `update(recipe)`, `set(path, v)`, `insert(path, v)`, `remove(path)`, `newId(kind)`, `image(id)`, `imageIds()`, `createImage(img)`, `writeImage(id, fn)`, `deleteImage(id)`, `commit()`, `cancel()`, `isOpen`, `label`                                               |
| Views          | `DocumentView` (`doc`, `image(id)`, `imageIds()`), implemented by the store, `DocumentSnapshot` and `Transaction`; `StoredImage = TiledImage \| IndexedImage`; `ImageSource`                                                                                                            |
| Patches        | `Patch {ops, images}`, `StructuralOp` (`AddOp`, `RemoveOp`, `ReplaceOp`), `ImagePatch` (`TilesPatch`, `CreateImagePatch`, `DeleteImagePatch`), `invertOp`, `invertOps`, `invertPatch`                                                                                                   |
| History        | `HistoryEntry`, `HistoryEntryInfo`, `HistoryInfo`, `DEFAULT_MEMORY_CAP`, `estimatePatchBytes`, `estimateJsonBytes` and the overhead constants                                                                                                                                           |
| Events         | `ChangeEvent {kind, version, label, entryId, patch, paths, imageIds}`, `ChangeKind`, `ChangeListener`                                                                                                                                                                                   |
| Hashing / JSON | `documentHash(view)`, `documentCanonical(view)`, `imageHash(img)`, `canonicalJson`, `jsonEqual`, `getAt`, `isSealed`, `JsonValue`, `JsonPath`, `DeepReadonly`                                                                                                                           |
| Rig hook       | `RigRenderer`, `RigFrameContext`, `RenderedPart` (types only)                                                                                                                                                                                                                           |
| Errors         | `CoreError` with `code`: `TX_ACTIVE`, `TX_CLOSED`, `TX_BUSY`, `TX_ASYNC`, `BAD_PATH`, `BAD_VALUE`, `BAD_ARGUMENT`, `IMAGE_EXISTS`, `IMAGE_MISSING`, `IMAGE_MUTATED`, `ID_EXHAUSTED`, `PATCH_CONFLICT`, `NO_RIG_RENDERER` (reserved for T2.3)                                            |

## State model (spec 6.4, ADR-007)

- **Document JSON is immutable.** Every node the store holds is deeply frozen ("sealed") and typed `DeepReadonly<Document>`. A change builds a new root that shares every untouched sub-tree with the old one, so `store.doc.layers === before.layers` when only an animation changed. Identity is therefore a valid memo key (WeakMap) for derived data such as renders.
- **Images are copy-on-write and never mutated once published.** Commits, undo and redo publish a _new_ image instance (an O(tiles) clone that shares tile buffers); old instances stay valid in snapshots and history. The store records each published image's `version` and throws `IMAGE_MUTATED` if a caller mutated one behind its back (checked when a transaction, undo or redo touches it). Never call `set` on an image from `store.image()`; use `tx.writeImage`. The `IMAGE_MUTATED` check also runs at `commit()` (on every base image the transaction touched, before the `before` tiles are captured), so a corrupted base fails the commit instead of poisoning the history.
- **Snapshots are O(1)**: `store.snapshot()` returns `{version, doc, images, image(), imageIds()}` that never changes. `snap.images` is a read-only `ReadonlyMap` view (its `set`/`delete`/`clear` throw `BAD_ARGUMENT` and it cannot reach the store's own map; the store never mutates a published map). `new DocumentStore(snap.doc, {images: snap.images})` forks without copying (sealed documents and published images are shared as is); the fork builds its own map, so the two stores share no mutable state. The constructor otherwise copies the document and clones caller images, and it does not validate: parse with the schema and run `validate()` first.
- **`version`** is runtime state, not part of the document: 0 at creation, +1 per committed transaction, undo and redo; a no-op transaction leaves it unchanged. It never decreases, so caches and the editor (spec 6.5) can use it for gap detection.
- Object key order is not significant and may change across undo/redo (a re-added key goes last). `documentHash`, `canonicalJson` and the `.pxf` writer sort keys.

## Transactions

- `store.begin(label)` opens one; `tx.commit()` / `tx.cancel()` close it. `store.transact(label, fn)` does begin, `fn(tx)`, commit, and cancels and rethrows if `fn` throws. Callbacks must be synchronous (`TX_ASYNC`).
- **No nesting, no savepoints.** `begin`, `undo`, `redo` and `clearHistory` throw `TX_ACTIVE` while a transaction is open (or `TX_BUSY` from inside a `writeImage` callback or a change listener, see below). Composite operations pass the `Transaction` to helpers (`splitRegion(tx, …)`), they never begin their own. Rationale: an op is one coarse transaction (FR-AI-14) and savepoints would add a second undo granularity nobody needs yet.
- **Any error thrown by a transaction method aborts the transaction** (it is cancelled; later calls throw `TX_CLOSED`). Inside an `update` recipe the abort happens when the recipe returns, even if the recipe caught the error. Validate inputs before mutating.
- Edits apply at once to the transaction's working copy (`tx.doc`, `tx.get`, `tx.image` see them); the store's committed state changes only at `commit()`. A cancelled transaction leaves no trace: same objects, same hash, same version, the id counter not advanced.
- **No-op detection.** `commit()` diffs the working copy against the state at `begin`. If nothing changed (including set-then-revert, writing a pixel's own value, create-then-delete an image) it records no entry, emits no event, leaves `version` alone and returns `undefined`. A transaction whose only change is `meta.ids.next` is also a no-op, **but only when the counter moved exactly by this transaction's `tx.newId` calls and nothing addressed `meta.ids` explicitly**: the ids it allocated were stored nowhere, so they are handed out again. An explicit `tx.set(['meta','ids','next'], 1000)` (or `set`/`insert`/`remove` on `meta`/the root, or a recipe that writes another value) is a real change and commits.
- **Ids** (spec 3.4.12): `tx.newId(kind)` reads `meta.ids`, returns `makeId(kind, seed, next)` and advances `next` in the working document. The counter is document state, so undo restores it and an operation re-run after an undo, or redone, produces the same ids. `ID_EXHAUSTED` at 2^30.

### Editing JSON

- **`tx.update((draft) => { … })`** is the main API. The draft is a `Proxy` typed as a mutable `Document`: read and write it with ordinary JS (`push`, `splice`, `sort`, `delete`, spread, `find`…). Only nodes on written paths are copied. Reading never copies: a child draft is created when a container is read, but its parent is copied only when something is written; `Object.keys`, `for…in`, `in` and `Reflect.ownKeys` neither copy nor create child drafts (`Object.getOwnPropertyDescriptor` reports a container value as the frozen node itself, so do not write through it; `Object.entries` and spread do read the values and so create drafts for container values), so a read-only scan commits nothing and keeps node identity. Rules: assigning `undefined` is an error (use `delete d.field`, which matches the schema's exact-optional fields, and `Reflect.deleteProperty(record, key)` for record entries, since lint forbids `delete record[key]`); arrays take only indices and `length` (no holes); values must be plain JSON (no `Date`, `Map`, class instances, cycles, non-finite numbers, `__proto__` keys), else `BAD_VALUE`; drafts are revoked when the recipe returns; compare entities by `id`, not object identity. Inside a recipe you may call `tx.newId` (it advances `draft.meta.ids`) and the image methods; `set`/`insert`/`remove`/`update`/`commit` throw `TX_BUSY`.
- **Path helpers** for generic code: `tx.set(path, value)` (replace, or add an object key; an equal value records nothing), `tx.insert(path, value)` (array insert, index `0..length`), `tx.remove(path)` (object key or array element). Paths are arrays: `['animations', 0, 'frames', 2, 'durationMs']`. `tx.set([], doc)` replaces the whole document (still diffed into minimal ops); the new root must be a plain JSON object, as in the constructor (anything else is `BAD_VALUE` and aborts).

### Editing images

- `tx.createImage(img)` stores a clone of a `TiledImage` or `IndexedImage` under a new `img_` id (from `meta.ids`) and returns the id; reference it from the document yourself.
- `tx.writeImage(id, (img) => …)` gives the mutable working copy (first touch: an O(tiles) COW clone; only written tiles are copied). Any raster call works: `set`, `composite`, `blit`, `clear`, `restoreTiles`. Size and kind are fixed: to resize or change kind, delete and create.
- **`writeImage` locks the transaction while the callback runs** (the working image is half-edited). Any call on the transaction other than the reads `doc`, `get`, `image`, `imageIds` (`commit`, `cancel`, `set`, `update`, `newId`, `createImage`, a nested `writeImage`…), and `store.begin`/`undo`/`redo`/`clearHistory`, throws `TX_BUSY` and aborts the transaction, even if the callback catches the error (`writeImage` rethrows it when the callback returns). The working image is never published while a callback runs.
- `tx.deleteImage(id)`; removing references is up to you (`validate()` checks I1).

## Patches

A `Patch` is `{ ops, images }`, frozen:

- **`ops`** is an ordered list of structural operations with RFC 6902 semantics and the old value kept: `{op:'add', path, after}` (new object key, or array insert at `path[-1]`), `{op:'remove', path, before}` (object key, or array element; later elements shift), `{op:'replace', path, before, after}` (`path` may be `[]`). Values are sealed JSON shared with the documents (zero-copy). The inverse of an op swaps `add`/`remove` (or `before`/`after`); the inverse of a list is the inverted ops in reverse order.
- The ops come from a deterministic diff at commit, not from the edit calls: objects key by key in sorted order (recursing into changed values); arrays skip the common prefix and suffix, pair the remaining elements by position (recursing, except that objects with different `id`s are replaced whole), then remove or add the surplus. One insertion, deletion or field edit is exactly one op; a reorder is one `replace` per moved element. Several separate insertions into one array in one transaction may give more ops than strictly needed (still correct).
- **`images`**: at most one per image id, sorted by id. `{kind:'tiles', id, before, after}` holds raster `TileSnapshot`s (immutable shared buffers; `data: undefined` is an absent tile) for the tiles whose bytes changed, following the raster README recipe (`tilesChanged(v0)` on the working copy, `captureTiles` on the committed base and on the working copy, false positives dropped by byte comparison). `{kind:'create'|'delete', id, image}` keeps the whole immutable instance.
- Undo applies `invertPatch(entry.patch)` strictly: the current values must equal each op's `before` and each tile's expected content, else `PATCH_CONFLICT` and nothing changes.

## History and memory (FR-DOC-02)

- One linear stack per store: applied entries (undo side) and undone entries (redo side). A new commit clears the redo side. Each entry has an `id` (1, 2, 3…, never reused), the transaction `label` (MCP: `AI: <tool>`, FR-AI-14), the forward `patch`, `tileBytes` and `structBytes`. `historyInfo()` lists entries oldest first with `applied` flags and the totals, for a UI.
- **Tile bytes are exact**: the sum of `byteLength` over the _distinct_ tile buffers referenced by any entry (each buffer counted once, via reference counting). A tile's `after` buffer in one entry is usually the `before` buffer of the next entry that writes the tile, so it counts once. A created or deleted image counts its allocated tiles. Buffers also used by the live document count too (it is the memory history keeps alive, as an upper bound).
- **Structural bytes are an estimate** (`estimatePatchBytes`): per op 64 bytes + 8 per path segment (+2 per UTF-16 unit of string segments) + `estimateJsonBytes(before/after)`, where a value costs 8 per number/boolean/null, 16 + 2 per unit per string, 16 + 8 per element per array, 16 + (16 + 2 per key unit) per key per object, children added; per image patch 64 bytes + 32 per tile snapshot. Shared sub-trees are counted in full, so this over-estimates.
- **Cap and eviction**: default 512 MiB (`DEFAULT_MEMORY_CAP`), set with `memoryCap` or `setMemoryCap` (`Infinity` disables). The cap applies to the **total of both sides** (undo and redo). Whenever `tileBytes + structBytes` exceeds it (after a commit or a cap change), entries are evicted from the end **farthest from the current position**: the oldest applied entry is `applied` steps away (that many undos), the farthest undone entry is `redo count` steps away (that many redos); the farther end is evicted first, and on a tie the redo end. **The newest applied entry (the one `undo` reverts) is never evicted**, so a single entry bigger than the cap is kept. Example: after 10 small edits and 50 large strokes, all 50 undone, lowering the cap drops the redo strokes from the far end first (50 steps away against 10) and leaves the 10 undo steps alone; only if the cap is so low that the ends are level do both shrink toward the current position, alternating. A commit clears the redo side first, so then only the undo end is trimmed. Eviction runs on `commit` and `setMemoryCap` only, never on `undo`/`redo`.

## Events

`subscribe(listener)` returns an unsubscribe function. Listeners run synchronously after each commit, undo and redo, once the state and `version` are updated, with `{kind, version, label, entryId, patch, paths, imageIds}`. Every listener of an event sees `store.version === event.version`. `patch` is what was applied to the previous state (the inverse for undo), so replaying the patches of all events in version order reproduces the document (editor sync, spec 6.5).

- **Listeners must not change the store.** `begin`, `transact`, `undo`, `redo`, `clearHistory` and `setMemoryCap` throw `TX_BUSY` during delivery (reads, `snapshot()` and (un)subscribing are fine). A listener that wants a follow-up change schedules it asynchronously (a microtask, `setTimeout`, the editor's next frame). This keeps one event in flight at a time, so ordering and the `version` guarantee are trivial.
- **Errors**: if listeners throw, the others still run, then the error (or an `AggregateError`) is rethrown to the caller of the change that produced the event only (the change is already applied).
- **Event patches are read-only views.** Operations are the frozen shared ones, but `TileSnapshot.data` of tile patches and the `image` of create/delete patches are fresh copies made lazily on each access (`data` is a `slice()`, `image` a copy-on-write clone), so a listener cannot corrupt the history or the live image through the event; `tx`/`ty` and `before`/`after` lists cost nothing. Read `data` once into a local variable. Rationale: the history and the published images share these buffers by design (zero-copy), and a plain freeze cannot protect typed arrays; copies on access cost only for listeners that read pixels (sync to an editor), which need their own copy anyway. A debug check or freeze-by-contract would detect a corruption late or not at all.

## `documentHash`

`documentHash(view)` is the lower-case hex SHA-256 of `documentCanonical(view)`: canonical JSON (sorted keys) of `{doc, images}`, where each image is `{kind, width, height, transparentIndex?, hash}` (`hashRGBA` for RGBA, ADR-010; for indexed, SHA-256 of `u32be w, u32be h, u8 transparentIndex, indices`). It ignores key order and tile allocation, works on the store, a snapshot or an open transaction, and memoises image hashes per immutable instance.

## Rig render hook (contract for T2.3 and T3.3)

`renderFrame` takes the renderer as an option, `renderFrame(view, animRef, frameRef, { rig?: RigRenderer, … })`, not a store registration: it stays a pure function of a `DocumentView` (store, snapshot or open transaction, so `attributeEdit` and split checks can render inside a transaction), and one renderer, with its caches, serves every view. The op context (T5.1, `ctx.renderer`) owns one renderer per document host.

```ts
interface RigRenderer {
  renderParts(ctx: RigFrameContext): readonly RenderedPart[]; // FR-RIG-20 steps 1-4
  finishFrame?(ctx: RigFrameContext, composite: StoredImage): StoredImage; // steps 6-7
}
// ctx: { view, animation (authored; a mirror's source), frameIndex, frame, partLayers (filtered, tree order) }
// RenderedPart: { layerId, partId, z, image (doc colour mode, no layer opacity), offset (canvas px) }
```

- `renderFrame` (T2.3) calls `renderParts` once per frame that includes at least one part layer, composites the parts in ascending `z` (ties in tree order) and the pixel layers (step 5), applying layer and group visibility and opacity, then calls `finishFrame` on the whole composite (post-passes, then final overrides) and applies the skin (step 8). When part layers are needed and no renderer is given, throw `CoreError('NO_RIG_RENDERER')` (T3.3 may then make the core adapter the default).
- The renderer (T3.3: rig's pure `renderParts` plus a core adapter) must be deterministic and read-only. Caches may key on published images and frozen document nodes (`WeakMap`), which never change; that is how the `(variant, angle)` cache stays valid across versions. The renderFrame memo can key on `doc.rig`, the animation object and image instances by identity.

## Notes for later cards

- **T2.2 frame ops**: write each op as `(tx, …) => void` using `tx.update` and `tx.newId('frame'|'override')`; materialise links before deleting a frame in the same transaction. `validate(view: DocumentView)` should accept a store, snapshot or transaction (it should also check `palette[transparentIndex].alpha === 0` for indexed images, raster README).
- **T2.3 renderFrame**: take a `DocumentView`; see the hook contract above.
- **T3.5 split**: one transaction: `createImage` for the part, `writeImage` to clear the source pixels, `update` to add the part layer and part; recomposite inside the transaction (`renderFrame(tx, …)`) to check W2b before `commit()`.
- **T5.1 ops**: run each handler as `store.transact(\`AI: ${tool}\`, (tx) => handler({ tx, … }, input))`for MCP calls (FR-AI-14). Handlers never begin or commit; an error aborts and nothing is recorded.`ChangeEvent.paths`/`imageIds`can feed an op's`changed`output.`doc.undo`/`doc.redo`map to`store.undo()`/`store.redo()`(they return`undefined` when there is nothing to do).
- **Proposals (M3, not implemented, not blocked)**: fork with `new DocumentStore(snap.doc, { images: snap.images })` (O(1)), run the operations on the fork, then accept by replaying them on the main store in one `transact` if `store.version` still equals the fork's base `snap.version`. Applying the fork's net patch directly would need a `tx.applyPatch(patch)` (an additive change: `applyOps` already exists).

## Frame operations and `validate()` (T2.2)

All frame operations take the open `Transaction` (`store.transact('Insert frame', (tx) => insertFrame(tx, { group: 'run', direction: 'side' }, 2, { position: 'after' }))`). `AnimRef` is `{id}` or `{group, direction?}`; `FrameRef` is a 0-based index or a `FrameId`. `resolveAnimation(doc, ref)` and `resolveFrame(anim, ref)` are exported.

- `insertFrame(tx, anim, at, {position, durationMs?}) -> FrameId`: empty frame (no keys, cels or overrides); default duration is the reference frame's.
- `duplicateFrame(tx, anim, frame) -> FrameId`: the copy sits right after the source. Cels link to the source (an existing link stays a link to the same target, so I3 holds); keys, part keys, markers, events, root motion and duration are copied; overrides of that frame (in any animation, so a mirror's extra overrides too) are copied with new override ids and **cloned `set`/`erase` images**, so editing one never changes the other.
- `deleteFrame(tx, anim, frame)`: per layer, the first cel that links to the deleted cel (layer tree order, then cel record order) receives a clone of the image (offset and opacity kept) and the other links of that layer are repointed to it; then the frame, its cels and its overrides (mirror extras included) are removed. Images left unreferenced by the removal are deleted from the store. Refuses the last frame.
- `reorderFrames(tx, anim, newOrder)`: `newOrder` must be a permutation of the frame ids. Cels, links and overrides are keyed by id, so they stay attached.
- Refusals are `CoreError('BAD_ARGUMENT')` with `details.reason` in `unknown-animation | unknown-frame | mirror-animation | last-frame | bad-order | bad-duration` (`FrameOpReason`); no new error code was added. Mirror animations have no frames and are always refused.

`validate(view) -> Finding[]` (`{code, severity, path, message}`; store, snapshot or transaction). `FINDING_CODES` lists every code. If the document fails `Document.safeParse` (this covers I5 integers/finite angles and the I7 name grammar, which transactions do not enforce) only `SCHEMA` findings are returned. Otherwise:

- I1: bone parents (`BONE_PARENT_MISSING`, `BONE_CYCLE`), parts (`PART_BONE_MISSING`, `PART_LAYER_MISSING`, `PART_LAYER_NOT_PART`, `PART_LAYER_SHARED`), variants/views (`VARIANT_VIEW_MISSING`, `VIEW_BONE_MISSING`, `VIEW_PART_MISSING`), keys (`BONE_KEY_BONE_MISSING`, `PART_KEY_PART_MISSING`, `PART_KEY_VARIANT_MISSING`), overrides (`OVERRIDE_PART_MISSING`, `OVERRIDE_FRAME_MISSING`; a mirror's overrides must name a frame of its source), cels (`CEL_FRAME_MISSING`: the key must be a frame of some authored animation), palettes/skins/ramps (`ACTIVE_PALETTE_MISSING`, `SKIN_PALETTE_MISSING`, `SKIN_INDEX_RANGE`, `RAMP_INDEX_RANGE`), `IMAGE_MISSING`.
- I2: `INDEX_OUT_OF_RANGE`, `TRANSPARENT_INDEX_OPAQUE` (indexed documents, stored images other than erase masks), and for palette-locked RGBA only the warning `PALETTE_LOCK_COLOR` on stored images: the render-based lint (T4.1) is authoritative.
- I3: `LINK_TARGET_MISSING`, `LINK_TO_LINK`, `LINK_SELF`.
- I4: `ID_DUPLICATE` (every id in the document, any kind); `ID_COUNTER_BEHIND` (warning). Detection: the schema generator encodes a bijective scramble of `(seed, counter)`; `validate` inverts it for each 6-character id, verifies the result by re-encoding with `makeId`, and reports ids whose counter is >= `meta.ids.next` (they could be issued again). It is a warning because a hand-written 6-character id decodes to an arbitrary counter. If the schema's scramble changes, the re-encode check fails and the detector goes silent rather than wrong.
- I6: `ANIM_KEY_DUPLICATE`, `MIRROR_SOURCE_MISSING`, `MIRROR_OF_MIRROR`, `MIRROR_GROUP_MISMATCH`.
- I7 uniqueness (the spec only fixes the grammar, so this is a decision): part-layer names unique document-wide (`PART_LAYER_NAME_DUPLICATE`, error: ops address part layers by name); other layer names unique among siblings (`LAYER_NAME_DUPLICATE`, warning); bone, view, skin, marker-def, event-def names and ramp names per palette unique (errors); variant names unique per part and view (`VARIANT_NAME_DUPLICATE`, warning). Animations are identified by `(group, direction)` (I6).
- Images: every stored image should be referenced (`IMAGE_ORPHAN`, warning), kind should match the colour mode (`IMAGE_KIND_MISMATCH`, warning; erase masks are exempt, they are 8-bit masks in every mode), `PART_LAYER_UNBOUND` (warning).
