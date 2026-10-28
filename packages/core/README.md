# @pixel-forge/core

Document store, transactions, patches, history, frame operations, validate() and renderFrame.

**Depends on:** `schema`, `raster`, `rig` (rig: not used yet; the rig hook is defined here). Pure: no DOM, no Node built-ins, no `Math.random`, no `Date.now`.

**Status:** store, transactions, patches, history, events, `documentHash` and the `RigRenderer` hook interface (T2.1). Frame operations and `validate()` (T2.2); `renderFrame` with post-passes, final overrides, mirror and skin (T2.3).

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
  renderParts(ctx: RigFrameContext): readonly RenderedPart[]; // FR-RIG-20 steps 1-4, parts only
}
// ctx: { view, animation (authored; a mirror's source), frameIndex, frame, partLayers (filtered, tree order) }
// RenderedPart: { layerId, partId, z, image (doc colour mode, no layer opacity), offset (canvas px) }
```

- The renderer is **parts-only**: `renderParts` covers steps 1 to 4 (pose, hierarchical snapping, variant choice with RotSprite and pivot alignment, the animation's **part** overrides) and returns the visible parts. Core owns steps 5 to 8 (see `renderFrame`). `renderFrame` (T2.3) calls `renderParts` once per frame that includes at least one part layer. When part layers are needed and no renderer is given, throw `CoreError('NO_RIG_RENDERER')` (T3.3 may then make the core adapter the default).
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

## `renderFrame` (T2.3)

```ts
renderFrame(view: DocumentView, anim: AnimRef, frame: FrameRef, opts?: {
  skin?: SkinRef | 'base';   // SkinRef = {id: SkinId} | {name: string}
  includeReference?: boolean; exportOnly?: boolean; rig?: RigRenderer; layers?: LayerId[];
}) → TiledImage            // meta.canvas size, RGBA, a fresh image each call
```

Pure; works on a store, snapshot or open transaction. The anim is found by id, or by exact `(group, direction)` (a missing direction means the undirected animation; `directionFallback` is not applied). The frame is an index or a `FrameId` of the (source) animation.

- **Pipeline** (FR-RIG-20 steps 5 to 8; the rig only does 1 to 4):
  1. _Composite (step 5)._ Pixel and reference layers in tree order, with the rig output drawn as ONE block at the tree position of the lowest (first-drawn) part layer, see below.
  2. _Post-passes (step 6)_ from the authored animation's `postPasses`, for any authored animation that declares them, with or without part layers: `removeOrphans` (raster defaults: 1 neighbour, 8-connected), then `outline` (colour from the schema field, `outsideOnly` default true, `corners: true` -> raster `'square'`, else `'round'`). The outline grows the canvas by 1 px, which is cropped back with the returned offset, so the outline is drawn only within the document canvas. An invalid outline colour (alpha 0) is `BAD_VALUE` with `details.reason: 'BAD_POSTPASS'`.
  3. _Final overrides (step 7)_: the animation's overrides with `target: 'final'` and `frameId` equal to the frame, in array order; per override `erase` first (8-bit 0/255 mask, 255 clears the pixel), then `set` painted over the result (normal "over" blend, so opaque pixels replace and transparent pixels leave the target), both at `anchor` (a canvas position), clipped to the canvas. Part overrides (`target: {partId}`) are not applied here (they are the rig's, step 4). An erase mask is read from an `IndexedImage` (its index) or, if stored as RGBA, from its alpha; a `set` image is in the document's colour mode (indexed images resolve through the base palette). A missing image is `IMAGE_MISSING`.
  4. _Mirror animations_: the source frame goes through 1 to 3 (with the source's post-passes and final overrides), then is flipped, then the mirror animation's own final overrides for that frame are applied (they are positioned on the flipped canvas). A mirror's part overrides are the rig's concern: the rig receives `ctx.animation` = the source only, so they are handled in T3.6.
  5. _Skin (step 8)_, last, always by colour on the RGBA composite for both colour modes (see Skin).
- **Layer order with a rig.** `doc.layers` and every group's `children` are ordered bottom to top: index 0 is drawn first. The rig's output (all parts, ascending `z`, ties in tree order, each with its part layer's effective opacity) is composited as one block at the tree position of the first part layer that is drawn (after the visibility, export and `layers` filters). Pixel and reference layers before that position draw below the whole block, those after it draw above it, even if they sit between two part layers in the tree. Example, tree `[bg (pixel), arm (part, z 1), fx (pixel), leg (part, z 0)]`: the block sits at `arm`, so the draw order is `bg`, then `leg` (z 0), `arm` (z 1), then `fx`; `fx` covers `leg` although `leg` is later in the tree. With no part layers the order is simply the tree order.
- **Visibility, opacity.** `visible: false` hides the whole subtree. Groups are pass-through: no isolated group compositing; a group's opacity is multiplied into its children, `eff = div255(parent * own)` per level (integer, `composite` rounding), and a leaf draws with `div255(eff * cel.opacity)` through raster `composite`.
- **Export flag.** With `exportOnly` a node is drawn only if its own `export` and all ancestors' are true (clarification 13). Reference layers need `includeReference` and are never drawn with `exportOnly`. `layers` restricts drawing: a leaf is drawn if it or an ancestor group is listed (ancestor visibility/opacity/export still apply); an unknown id throws `BAD_ARGUMENT`.
- **Cels.** Links resolve in one hop; a link to a missing cel or to another link throws `BAD_VALUE` with `details.reason: 'BROKEN_LINK'`. A missing cel draws nothing; a missing image throws `IMAGE_MISSING`.
- **Indexed images** convert through the active (base) palette (`transparentIndex` always transparent; index outside the palette: `BAD_VALUE`/`BAD_INDEX`; no palette: `NO_PALETTE`). The skin is not applied at conversion.
- **Part layers**: `rig.renderParts` is called once with the filtered part layers; a part for a layer that was not handed over is `BAD_RIG`. Part images take the part layer's effective opacity. No `rig` with part layers: `NO_RIG_RENDERER`.
- **Mirror flip**: `x' = 2*origin.x - x` (pixel-centre convention: the origin column stays, as for markers); pixels pushed off canvas are lost. Bad source: `BAD_VALUE`/`BAD_MIRROR`.
- **Skin** (last; `'base'`/none = unskinned), identical for both colour modes: a pixel of the RGBA composite whose RGB equals that of an active-palette entry with alpha > 0 takes the RGB of the skin colour for that index (remap: `palette[remap(i)]`; palette skin: `skinPalette[i]`), alpha kept. With duplicate colours in the palette the lowest index wins (even if the skin has no entry for it, then the pixel stays). Non-matching pixels (blended ones, colours outside the palette) and indices the skin palette lacks stay unchanged. Consequence: a post-pass outline colour or a final-override pixel that equals a palette colour is skinned too, and in an indexed document an authored colour that duplicates a palette entry is skinned like it. **TODO (T4.1 lint):** duplicate colours in a palette that a skin touches should be a lint warning (the skin acts by colour, so duplicates are ambiguous); not implemented here.

### Memo and cache key

- `createFrameRenderer(capacity = 64)` returns a `renderFrame`-like function with its own LRU memo (no global state; `.stats`, `.clear()`). Key: WeakMap-numbered identities of `meta`, skin, palettes, the draw list (layer, image instance + `version`, offset, final opacity), the rig block position, the post-passes node, the final overrides (node identity, anchor, set and erase image instances + `version`; the mirror's separately) and, with part layers, the rig instance, source animation node, `doc.rig` and all image instances. A hit returns a copy-on-write clone.
- `renderInputKey(view, anim, frame, opts)` is the `.pxf` per-frame hash: SHA-256 hex of canonical JSON of `{v: 1, canvas, colorMode, mirror ({origin, finals: the mirror's own final overrides} for mirrors), items [{layer, image kind + imageHash, x, y, opacity}], rigAt (part layers only), postPasses (config or null), finals [{id, anchor, set, erase image kind + hash}] of the frame, rig (part layers only: layers + opacity, source animation, frame index, doc.rig, all image hashes, renderer present), palette (indexed or skinned), skin or 'base', skin palette}`. It changes iff something reaching the pixels changes (layer names, hidden/filtered layers, durations, markers, overrides of other frames, part overrides on a frame without part layers, `baseHash` do not). The rig part is a placeholder for T3.3 to extend; a mirror's part overrides are not in the key yet (T3.6).

## Rig editing (T3.2)

`rig-edit.ts`: transaction functions over the optional `doc.rig` (created on first use). Each checks its arguments before changing anything and throws `CoreError('BAD_ARGUMENT')` with `details.reason` (`RigEditReason`: `unknown-bone | unknown-view | unknown-part | unknown-variant | bad-name | name-taken | direction-taken | cycle | has-parts | has-children | has-variants | bad-value | bone-mismatch`).

- `applySkeletonTemplate(tx, template, {viewId?, viewName?}) -> {viewId, bones, created}`: bones matched by name (reused if the parent agrees, else `bone-mismatch`), missing ones created; rest set for all template bones in the view (a new view named after the template unless `viewId`). Generate the template with `origin: doc.meta.origin` and your height.
- `addBone(tx, {name, parentId?, length}, rest?: {viewId, x, y, angle})`, `renameBone` (unique, name grammar), `setBoneLength`, `setRestPose(tx, view, bone, {x, y, angle})` (integers; children keep their offsets), `reparentBone(tx, bone, newParent?)` (`cycle` refused; **rest offsets and angles are recomputed so canvas pivots and world directions at rest do not change**).
- `deleteBone(tx, bone, {cascade?})`: **never destroys art**. A bone with parts is refused (`has-parts`, also for a cascaded descendant); a bone with children is refused (`has-children`) unless `cascade`, which deletes the subtree. Rest entries and bone keys of the deleted bones are removed.
- `addView(tx, name, directions)` (unique name; each direction unique across views), `renameView`, `deleteView` (refused while variants use it, `has-variants`).
- `setPivot(tx, part, variant, {x, y})`: integers; **may lie outside the image** (a floating wrist pixel is normal), only +-2^20 is enforced. `setPartZ(tx, view, part, z)` (FR-RIG-06).
- `bindParts(tx, {byName?, byOverlap?, layers?, rawNames?, viewId?, zByBone?, overlap?}) -> {bound, ambiguous, skipped}`: pixel layers become parts. By name: `part:<bone>[.<part>][@variant][#view]` (from `rawNames[layerId]` or the layer name) or a plain bone name. By overlap: remaining layers, only on a clear winner (`rig`'s `bindByOverlap`, default view). The layer's single drawing (image + offset) becomes a variant `default`/`@variant` with pivot = bone rest pivot - cel offset (the part renders where it was drawn); layers are grouped by (bone, part): the first layer of a group becomes the part layer in place (named `<bone>` or `<bone>_<part>`), later ones (other `@variant` / `#view`) are folded into it and removed; a different `.part` of the same bone is a separate part with its own z (`zByBone` is keyed by layer name first, then bone name; `setPartZ` is per part). Overlap only decides the bone: such a layer becomes the main part `<bone>` and only if the bone has no part yet, else it is skipped `bone-has-part` (never folded in). Binding again changes nothing. Skipped with a reason, never guessed: `no-view`, `unknown-bone`, `unknown-view`, `bone-not-in-view`, `empty`, `animated` (cels hold more than one drawing), `image-missing`, `duplicate-variant`, `name-taken` (the part layer name is used), `name-too-long`, `bone-has-part`, `no-overlap`; ambiguous overlap returns `candidates` and leaves the layer untouched.
