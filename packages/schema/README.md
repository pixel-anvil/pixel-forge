# @pixel-forge/schema

Domain types, zod schemas, ids and constants for pixel-forge: the v1 document model (spec 3) and the `.pxf` file contracts (spec 7). No logic beyond the id generator and the JSON Schema export.

**Depends on:** `zod` (v4) only. Pure: no DOM, no Node built-ins, no `Math.random`, no `Date.now`.

**Status:** v1 model (T1.1).

## Use

```ts
import { Document, createIdGenerator, documentJsonSchema } from '@pixel-forge/schema';

const doc: Document = Document.parse(JSON.parse(text)); // throws a ZodError with paths
const gen = createIdGenerator(doc.meta.ids); // gen.next('layer') -> 'lay_7k2m9q'
const schema = documentJsonSchema(); // JSON Schema draft 2020-12
```

Each schema and its inferred type share one name (`Document`, `LayerId`, `AnimRef`…), as in the op API (spec 6.3).
Parsing checks structure only: types, ranges, names (I7), integers for pivots, offsets and origin (I5), finite angles, and id prefixes. It never adds defaults or transforms, so a parsed value equals its input.
Cross-reference invariants (I1–I4, I6) belong to `core`'s `validate()`.

## Model overview

```
Document                                   document.json; images stay in images/<id>.png
├─ meta        id, name, schemaVersion 1, canvas {w,h}, origin {x,y}, pixelsPerUnit,
│              colorMode rgba|indexed, paletteLocked, ids {seed, next}
├─ palettes[]  Palette {id, name, colors: [r,g,b,a][], ramps: {name, indices[]}[]}
├─ activePaletteId?
├─ skins[]     Skin {id, name, remap: [from,to][]}  |  {id, name, paletteId}
├─ layers[]    bottom → top; Layer = group {children[]} | pixel {cels} | reference {cels} | part
│                 each with id, name, visible, opacity 0..255, export
│                 cels: {frameId → ImageCel {imageId, offset, opacity} | LinkCel {linkTo: frameId}}
├─ rig?        bones[]  Bone {id, name, parentId?, length}
│              parts[]  Part {id, boneId, layerId, variants[] ≥1, rotation?, maxResidualDeg?}
│                         Variant {id, name, viewId, imageId, pivot, drawnAngle?, tags[]}
│              views[]  View {id, name, directions[], rest {boneId → {x,y,angle}},
│                             partVisibility {partId → bool}, defaultZ {partId → int}}
├─ animations[] AuthoredAnimation {id, group, direction?, loop, angleQuantum?, postPasses?,
│                  frames[] ≥1, overrides[]}
│                 Frame {id, durationMs, markers {name → {x,y}}, events[], rootMotion {dx,dy},
│                        boneKeys {boneId → BoneKey}, partKeys {partId → PartKey}}
│                 Override {id, frameId, target {partId}|'final', anchor, set?, erase?, baseHash}
│               MirrorAnimation {id, group, direction?, mirrorOf, overrides[]}
├─ directionFallback  {direction → direction[]}
└─ markerDefs[], eventDefs[]   {name, description?}

manifest.json      Manifest {format 'pxf', schemaVersion 1, app, created, modified}
render/index.json  RenderIndex {schemaVersion, origin, pixelsPerUnit, directionFallback, skins[],
                     animations {group → {directionKey → {loop, frames[]} | {loop, mirrorOf}}}}
```

## Storage-shape decisions

- **Arrays when order means something; records when it does not.** Layers (z order), children, palettes, colours, ramps, skins, animations, frames, variants (the first per view is the default), events and overrides (application order) are arrays. Lookups with no order are records keyed by id or name: cels, bone keys, part keys, rest poses, visibility, default z, markers, direction fallback, render-index animations. Sorted-key serialisation (NFR-03) therefore never reorders anything meaningful, and no ordered data hides in key order.
- **Keys live where they travel.** Bone keys and part keys sit inside their `Frame`, so reorder, duplicate and delete (spec 3.2) move them with no bookkeeping. Cels sit inside their pixel or reference layer (`cels[frameId]`). That makes the `(layerId, frameId)` key structural, makes "only pixel and reference layers have cels" a type fact, and makes deleting a layer delete its cels.
- **Overrides are per animation**, an ordered array with a `frameId` each. A mirror animation has no frames but can carry extra overrides keyed by its source's frame ids.
- **Mirrors are their own shape.** `MirrorAnimation` has no `frames`, `loop` or `postPasses` (FR-RIG-16: it stores only `mirrorOf` plus extra overrides). Narrow with `'mirrorOf' in a`.
- **Unions by presence.** `Cel`, `Skin`, `Animation`, `AnimRef` and the render entries are unions of strict objects with disjoint required keys, so exactly one branch can match. `Layer` uses an explicit `kind`.
- **One canonical form.** Objects are strict (unknown keys fail, so typos and newer files never pass silently). Optional fields are `exactOptional` (absent, never `undefined`). Empty bone and part keys are rejected, and skin remaps are sorted by source index with no duplicates and no identity pairs (`[n, n]`). Hashes are exactly 64 lower-case hex digits (SHA-256). Reference layers have `export: false`. `render/index.json` `skins` lists `base` exactly once and no repeats.
- **Integers.** Opacities are 0..255. Positions, offsets, pivots, z and root motion are integers. Angles are finite degrees, clockwise, with 0° along +x.
- **Ids** are `<prefix>_<body>`, for example `lay_7k2m9q`, with prefixes `doc lay frm anm bon prt var viw img ovr pal skn`. `makeId(kind, seed, counter)` writes a 6-character Crockford base32 body. The body is a bijective integer scramble of `(seed, counter)` over 2^30. One global counter lives in `meta.ids`, so undo and redo replay ids exactly. Parsers accept any `[0-9a-z]{1,24}` body. Every id is a valid name.
- **Reserved keys.** The render cache uses direction key `default` for undirected animations and skin key `base` for the unskinned render, so those names are rejected as document directions and skin names.
- **Reserved property names.** No name or record key may collide with `Object.prototype` (`__proto__`, `constructor`, `prototype`, `toString`…). zod's `z.record` silently drops a `__proto__` key, so every keyed map goes through the internal `record()` helper, which fails such a key instead. The name grammar (`NAME_REGEX`, `DIRECTION_REGEX`, `SKIN_NAME_REGEX`, `RenderImagePath`) is built from one source in `primitives.ts`.
- **Bounded depth.** The layer tree nests at most `MAX_LAYER_DEPTH` (32) levels. `Layer` and `GroupLayer` check this with an explicit stack before recursing, so a 5000-deep document fails with an ordinary issue instead of a `RangeError`.

## Evolving the schema (ADR-005)

1. **Additive change** (the default): add an **optional** (`exactOptional`) field, a new union branch, or a looser bound. Don't bump `SCHEMA_VERSION`. Old files still parse. Older pf versions reject newer files with an "unrecognized key" error, rather than dropping data.
2. **Never** add `.default()` or transforms. Parsing must stay identity so that load → save is byte-stable.
3. **Breaking change** (rename, removal, a new required field, a tighter bound, a changed meaning): write an ADR. Bump `SCHEMA_VERSION`. Add a forward-only migration in `io` (the migration registry, T4.2) that runs on raw JSON before `Document.parse`. Keep the frozen v1 fixture (`fixtures/frozen/v1/minimal-document.json`) opening.
4. Update the TSDoc, this README and `docs/contracts/` when generated.

## Decisions the spec leaves open (pending a spec fix)

`LinkCel` links within the same layer only. `View` has a `name` (needed for `#<view>` binding). `Variant.image` is renamed `imageId`. A part's "PartName" in ops is its part layer's name. `drawnAngle` defaults to the rest angle. An undirected animation uses `views[0]`. In indexed mode, transparency is a palette colour with alpha 0. The outline colour is RGBA8. Render-cache mirrors list no frames.

## Domain types summary

- **Document**: meta + palettes + skins + layer tree + optional rig + animations + direction fallback + marker/event defs. No pixels; images are `images/<ImageId>.png`.
- **Meta**: doc id, name, schema version 1, canvas size, integer origin (engine anchor, mirror axis), pixels per unit, colour mode `rgba | indexed`, palette lock, id generator state.
- **Ids**: branded strings `lay_7k2m9q` per kind; deterministic seeded generator, no randomness (I4).
- **Palette**: ordered RGBA8 colours (≤ 256) + named ramps (index lists).
- **Skin**: index remap (sorted pairs) or a whole alternative palette; `base` = unskinned.
- **Layer**: `group` (children) | `pixel` (cels) | `reference` (cels, never exported) | `part` (rig-computed); each has name, visible, opacity 0..255, export.
- **Cel**: per (layer, frame), stored in the layer: image + integer offset + opacity, or a same-layer link to another frame (one hop, I3).
- **Rig**: bones (forest, length), parts (bone + part layer + variants), views (directions, rest pose per bone, visibility and default z per part).
- **Variant**: per part and view: image, integer pivot (pixel centre), optional drawn angle, tags.
- **Animation**: authored `{group, direction?, loop, angleQuantum?, postPasses?, frames, overrides}` or mirror `{group, direction?, mirrorOf, overrides}`; `(group, direction)` unique (I6).
- **Frame**: stable id, duration ms, markers (canvas px, anatomical names), events, integer root motion, sparse bone keys and part keys.
- **BoneKey**: angle (relative to rest), integer offset, flipX, interp `step | linear | ease-in-out`.
- **PartKey**: variant (id or `'auto'`), z, visible; step interpolation.
- **Override**: frame, target part (anchor relative to the snapped pivot) or `'final'` (canvas anchor), set image and/or erase mask (an 8-bit 0/255 mask in every colour mode; erase applies before set), `baseHash` of the bbox ±1 for staleness.
- **Refs** (ops): `AnimRef = {group, direction?} | {id}`; `FrameRef = index | FrameId`.
- **Render cache**: `manifest.json` and `render/index.json`, giving per group/direction loop and frames (hash, duration, PNG path, markers, events, root motion), or `mirrorOf` for a mirror.
- **Constants**: `TILE_SIZE` 16, `ANGLE_QUANTUM_DEFAULT` 1, `MAX_RESIDUAL_DEG_DEFAULT` 22.5, `HYSTERESIS_DEG_DEFAULT` 5, `NAME_REGEX`, `MAX_LAYER_DEPTH` 32, `SCHEMA_VERSION` 1, conventional direction names.
