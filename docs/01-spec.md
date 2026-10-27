# pixel-forge — Product & Technical Specification

| | |
|---|---|
| Version | **0.2.1** (0.2 after spec review; 0.2.1 has small additions from the plan review: FR-GD-03 game-driven playback, FR-DOC-05 cell selection, M1a tool list) |
| Date | 2026-10-26 |
| Status | **Awaiting user review** |
| Inputs | `00-research-and-options.md` (Option D chosen; §5 lists the pitfalls not to inherit) |

Requirement IDs (`FR-*`, `NFR-*`, `W*`) are stable. The plan and tests refer to them. `[M1a]`-style tags show the milestone.

---

## 1. Purpose

A pixel-art editor and animator for game assets, with three things that set it apart:
1. **A pixel-aware rig.** Characters are built from part layers on a skeleton and posed, with one or more views per character. Each part is either rotated with RotSprite, swapped for a hand-drawn variant, or baked and retouched. Retouches follow their part when it's re-posed.
2. **LLM-native.** One typed operation API is shared by the CLI, the **MCP server**, the UI and (later) an in-app AI panel. Agents check their own work through rendered previews and precise lint.
3. **Game-engine output.** A Godot import plugin turns a document into an atlas, a frame table and metadata. It's re-imported automatically on save and drives any sprite node, including custom lit billboards.

### 1.1 Goals
- G1: Make the user's own game assets quickly and consistently. The first target is a Godot 4.6 2.5D pixel-art game whose characters are drawn on a custom lit billboard quad.
- G2: Let an LLM do the tedious parts (posing, in-betweens, palette work, image conversion, clean-up) while the human stays in control. Every AI change can be undone.
- G3: Be buildable over many sessions by mixed-cost models. That needs strict types, small modules, tests, and docs written for agents.

### 1.2 Non-goals (v1)
- Painting or illustration. Mesh deformation. Warping is a **later experimental** feature (FR-RIG-40).
- A live skeletal rig in Godot. Frames are always baked.
- Multi-user collaboration or a cloud service.
- Generating new directions or views automatically from one view. Views are authored. Mirroring is derived.
- Running image-generation models locally.

### 1.3 User & platforms
One user, a developer who works with Claude Code. **macOS first** (Apple Silicon). **Windows by M3.** Godot 4.6.x.

---

## 2. Acceptance scenarios

Each one becomes an automated test (harness or e2e) over fixtures in `fixtures/`.

| ID | Scenario | Passes when | M |
|---|---|---|---|
| W1 | **Image → sprite**: convert `fixtures/photo_ball.jpg` to 32 px tall with the PICO-8 palette, producing a 4-variant grid (2 downscale methods × dither on/off) | 4 layers are produced, lint reports 0 off-palette pixels, and the output matches golden images. The same works through MCP `image_to_sprite`. | M1b |
| W2 | **Rig a character**: import `fixtures/hero_parts.aseprite` (layers named `part:<bone>[@variant]`), apply the humanoid-side template, auto-bind | Every part is bound, the pivots are set, and the joint check reports **exactly** the 3 seeded gaps (`unionCount` across `fixtures/joint/gappy_*`) and 0 across `fixtures/joint/clean_*` | M1a |
| W2b | **Split a flat frame**: from a flat pack frame, split regions into parts and paint the hidden overlap | The split parts recomposite to the original frame pixel for pixel, and the joint check passes after the overlap is painted | M1a |
| W3 | **Animate with prompts**: in Claude Code, "6-frame run cycle, side view, 12 fps, with anticipation" | The animation exists, lint is clean, every tool call is one undo step, and a contact sheet was rendered and inspected | M1a (manual poses) / M1b (presets) |
| W4 | **Touch up**: fix 3 px on frame 2 (a part override), then change the torso lean by +5° on all frames | Overrides on parts that **moved but didn't rotate** follow them. Overrides on parts that **rotated** become *stale*. Nothing is silently lost. | M1a (via `pf override import`) / M2 (in the editor) |
| W5 | **Into Godot**: save `player.pxf` under `res://`. The game's lit billboard node plays `run/side` through `PixelForgeDriver`, and marker `hand_r` follows it | It works without a manual export, and the frame timing matches the durations to within 1 ms | M1a |
| W6 | **Hand-drawn animation**: timeline (layers × frames), onion skin with ranges, linked cels, multiple animations, per-frame durations, preview loop, GIF and spritesheet + JSON export | Each listed feature has an e2e test | M2 |
| W7 | **Palette discipline & skins**: a palette-locked document plus a skin `rival` (index remap) | Lint over the *rendered* output reports 0 violations. Godot gets one atlas per skin. | M1b |

---

## 3. Domain model

```
Document
 ├─ meta: id, name, schemaVersion, canvas {w,h}, origin {x,y}, pixelsPerUnit, colorMode (rgba | indexed), paletteLocked
 ├─ palettes[]: Palette { id, name, colors[], ramps[] }       (activePaletteId)
 ├─ skins[]: Skin { id, name, map: {fromIndex → toIndex} | paletteId }
 ├─ layers: LayerTree (Group | PixelLayer | PartLayer | ReferenceLayer), each with { export: bool, opacity, visible }
 ├─ rig?: Rig { bones[], parts[], views[] }
 ├─ animations[]: Animation
 ├─ directionFallback: { [direction]: direction[] }            e.g. up → [up, side]
 └─ markerDefs[], eventDefs[]
```

### 3.1 Entities
| Entity | Definition |
|---|---|
| **Palette** | Ordered RGBA8 colours plus **ramps** (named index lists, e.g. `skin: [3,4,5,6,7]`) |
| **Skin** | A palette mapping applied at render and export time (team kits). Lint checks every skin. |
| **Animation** | `{ id, group, direction?, mirrorOf?, loop: loop\|once\|pingpong, frames: Frame[] }`. **`(group, direction)` is unique.** Example: `group:"run", direction:"side"`. Animations own their frame list. **Layers are shared** across animations. |
| **Frame** | `{ id (stable FrameId), durationMs, markers: {name→{x,y}}, events: string[], rootMotion: {dx,dy} }` |
| **Cel** | Keyed by `(layerId, frameId)`: `{ imageId | linkTo: CelRef, offset {x,y}, opacity }`. A link resolves in one hop (I3), and links may point to frames in **other animations**. |
| **PixelLayer** | An ordinary raster layer with cels |
| **PartLayer** | A layer computed by the rig for one **Part**, plus optional part overrides |
| **Bone** | `{ id, name, parentId?, length }`. The rest pose lives in a view. `_l`/`_r` suffixes pair bones up. |
| **View** | `{ id, direction-set (e.g. ["side"]), rest: {boneId → {x,y,angle}}, partVisibility: {partId→bool}, defaultZ: {partId→int} }`. A character has one skeleton (a shared set of bone names) and **one View per authored direction**. Bones that are unused in a view are hidden there. |
| **Part** | `{ id, boneId, layerId, variants: Variant[] }`. `variants[0]` is the default. |
| **Variant** | `{ id, name, viewId, image, pivot {x,y} (integer, **pixel-centre** convention), drawnAngle?, tags[] }` |
| **Bone key** | Per `(animationId, frameId, boneId)`: `{ angle?, offset? {x,y int}, flipX?, interp? }` |
| **Part key** | Per `(animationId, frameId, partId)`: `{ variant?: variantId \| 'auto', z?, visible? }`. Step interpolation only. |
| **Override** | `{ id, target: {partId} \| 'final', animationId, frameId, set: image, erase: mask, anchor, baseHash }`. A part override's `anchor` is **relative to the part's snapped pivot**. A final override's anchor is relative to the canvas. `baseHash` hashes the **override bbox dilated by 1 px** over the target's pre-override render. |
| **Marker / Event** | Generic per-frame data. Marker names keep the **anatomical side** (`hand_r` always means the right hand, even when the view is mirrored). |

### 3.2 Frame-list operations (defined, tested)
- **Insert a frame** (before or after): gets a new FrameId. Bone keys aren't copied, because interpolation fills them in. Cels and overrides: none.
- **Duplicate a frame**: new FrameId. Cels are linked to the source. Keys, part keys, markers, events and root motion are copied. Overrides are copied as new IDs.
- **Delete a frame**: removes its keys, cels and overrides. Links pointing at its cels are **materialised** (copied) first.
- **Reorder**: FrameIds move. Everything keyed by FrameId comes along.

### 3.3 Invariants (checked by `validate()`, property-tested)
- I1: The bone graph is a forest. Every part, variant, view and key references existing IDs.
- I2: In indexed mode every index is less than the palette length. When the document is palette-locked, **the rendered output under every skin** contains only palette colours (lint, FR-PAL-06).
- I3: Links resolve in one hop and target a non-link cel.
- I4: IDs are unique, stable and deterministic (seeded generator, never `Math.random`).
- I5: Pivots, offsets and origin are integers. Angles are finite.
- I6: `(group, direction)` is unique. `mirrorOf` targets a non-mirrored animation with the same group.
- I7: Animation, group and layer names match `^[a-z0-9_\-]{1,48}$` and are not reserved JavaScript property names (§3.4.14), so they're safe in paths, records and Godot names.

### 3.4 Clarifications from implementing the schema (T1.1, 2026-10-27)
These settle ambiguities found while writing `@pixel-forge/schema`. Its README is the code-level reference.
1. **A mirror with overrides** (FR-RIG-16 allows extra overrides) is written to the render cache as a **normal, fully rendered entry**. Only a mirror *without* overrides is emitted as `mirrorOf` and flipped at runtime.
2. **Cel links** are same-layer only: `linkTo: FrameId`. A link across animations means the same layer in another animation's frame.
3. **An undirected animation** uses the reserved direction key `default` in the render cache and its paths. **The unskinned render** uses the reserved skin name `base`.
4. **`render/index.json` frame `image`** is a path relative to `render/<skin>/`, so frames with equal hashes may share one PNG.
5. **Variants belong to views.** A part's default variant *for a view* is its first variant with that `viewId`. **Views have a `name`**, used by `#<view>` layer naming, and a `directions[]` list. Front and back are **two views**.
6. **PartName** (in ops) is the part layer's name. Animations are addressed by `(group, direction)` or id. There is no separate animation name.
7. **Rig maths conventions:**
   - 0° points along +x, and angles grow clockwise (y down).
   - `BoneKey.angle` is **relative to the bone's rest angle**.
   - A root bone's rest `x, y` is a canvas position. A child's rest position is an offset from its parent's pivot, in the parent's rotated frame.
   - `flipX` flips **only the bone's own parts**, not its subtree.
   - A missing `interp` means linear. A missing `drawnAngle` means the rest angle.
   - An undirected animation uses `views[0]`.
   - A part missing from `partVisibility` is visible, and one missing from `defaultZ` has z 0.

   T3.1 may refine these with an ADR. **[ADR-012](adr/ADR-012.md) (Accepted, T3.1)** reads "in the parent's rotated frame" as: the child's rest offset is a canvas offset measured at rest, and it turns with the parent's rotation away from rest (not with its rest angle), so the rest pose is exactly the authored canvas positions at any quantum. Interpolation is by frame index, and `loop` animations wrap from the last key to the first.
8. **Indexed mode:** transparency is any palette entry with alpha 0. **Erase masks** are always 8-bit masks (0 or 255), whatever the colour mode.
9. **Markers** are stored in canvas pixels. Consumers (Godot) subtract `origin`.
10. **Hashes** (`baseHash`, frame hashes) are lower-case hex SHA-256, using the testkit layout (u32be width, u32be height, RGBA). Manifest timestamps are UTC ISO 8601 with `Z`.
11. **Override order:** within one override, `erase` applies first, then `set`, both at the same anchor.
12. **IDs** look like `lay_7k2m9q`: a kind prefix plus base32. They come from a seeded counter stored in `meta.ids`, so undo and redo replay the same IDs.
13. **Group `export`** is ANDed with the ancestor groups. Reference layers are never exported or cached.
14. **Reserved names:** names and record keys may not be JavaScript `Object.prototype` member names (`__proto__`, `constructor`, `prototype`, `toString`, …). They are rejected, never silently dropped (code review of T1.1). Layer trees nest at most 32 levels (`MAX_LAYER_DEPTH`).

---

## 4. Functional requirements

### 4.1 Document & files (FR-DOC)
- FR-DOC-01 [M1a]: Create, open and save `.pxf` (§7). Saves are **atomic** (temp file + rename).
- FR-DOC-02 [M1a]: **One undo history per document** covering every change. Operations are grouped into labelled transactions. The memory cap (default 512 MB) counts tile bytes.
- FR-DOC-03 [M2]: Autosave and a crash-recovery journal kept in the app cache dir (`~/Library/Caches/pixel-forge` or `%LOCALAPPDATA%`), never next to the file.
- FR-DOC-04 [M1a]: **Import `.aseprite`/`.ase`**:
  - Layers come across with their names. A layer named `part:<bone>[@<variant>][#<view>]` becomes a PartLayer variant.
  - Each **tag maps to an animation** (`group` = tag name). Untagged frames go to an animation called `default`. Frames inside **overlapping tags** become linked cels.
  - The palette and linked cels are imported.
  - **Re-import in place**: when you update a document from an edited `.aseprite`, parts and layers are matched by name. Rig bindings, pivots and keys are kept, and the changed images are replaced.
- FR-DOC-05 [M1a]: Import PNG: a single image, or a grid spritesheet with **cell selection** (cell size, row, column ranges, and the mapping of ranges to animations, e.g. row 4, cells 3–6 → `move_gather`). A matching outline sheet can be imported as a separate layer. [M1b]: GIF.
- FR-DOC-06: Export:
  - [M1a] PNG frame, contact sheet, and spritesheet + JSON (Aseprite-compatible hash format);
  - [M1b] GIF;
  - [M3] `.aseprite`.
  - Integer scale ×1–×16.

### 4.2 Drawing & editing (FR-DRAW) [M2 unless noted]
- FR-DRAW-01: Tools:
  - pencil (with a **pixel-perfect** mode) and eraser;
  - line, rectangle and ellipse;
  - fill (contiguous or global);
  - eyedropper and move;
  - rectangle, lasso and magic-wand selection;
  - **ramp shading** (step a pixel along its ramp);
  - Bayer dither brush.
- FR-DRAW-02: Symmetry drawing (vertical, horizontal, both).
- FR-DRAW-03: Flip, rotate 90/180, **RotSprite rotate** [ops in M1a], integer scale, crop and resize the canvas.
- FR-DRAW-04: Copy, cut and paste, with a floating selection.
- FR-DRAW-05: Brush size 1–8. Primary and secondary colours.
- FR-DRAW-06: In palette-locked documents, colours can only be picked from the palette, and pasted or imported content is remapped (nearest in OKLab) with a preview.

### 4.3 Palette & colour (FR-PAL)
- FR-PAL-01 [M1a]: Presets: PICO-8, NES, Game Boy, Endesga 32, Resurrect 64, AAP-64, Sweetie 16. Each records its source and licence.
- FR-PAL-02 [M1b]: Import and export `.hex`, `.gpl`, `.pal` (JASC) and PNG strips. [M3]: `.ase` swatches.
- FR-PAL-03 [M1b ops / M2 UI]: Palette editing, sorting, and a **ramp generator** (hue shift: shadows toward cool, lights toward warm; parameters adjustable).
- FR-PAL-04 [M1b]: Generate a palette from an image with k-means++ in OKLab or median-cut (N = 2–256). Seeded, so results are deterministic.
- FR-PAL-05 [M1b]: Remap or swap palettes with a mapping table.
- FR-PAL-06 [M1a]: Palette lock: indexed mode, or locked RGBA mode. Lint runs on the **render output**. A layer or cel with opacity below 100 % in a locked document is a lint warning.
- FR-PAL-07 [M1b]: **Skins** (index remaps or alternative palettes) are rendered per skin at export.

### 4.4 Animation (FR-ANIM)
- FR-ANIM-01 [M2]: Timeline UI (rows = layers/parts, columns = frames, cell state glyphs).
- FR-ANIM-02 [M1a ops]: Multiple animations, each with `group`, `direction`, `mirrorOf` and loop mode.
- FR-ANIM-03 [M1a]: Per-frame duration in ms. A hold is a longer duration, never a duplicated frame.
- FR-ANIM-04 [M2]: Onion skin with **range brackets on the timeline**, master opacity and tints.
- FR-ANIM-05 [M2]: Canvas playback and a floating preview (1×/2×/4×).
- FR-ANIM-06 [M1a ops]: Linked cels (link, unlink, "link identical").
- FR-ANIM-07 [M1a ops / M2 UI]: Markers and events per frame.
- FR-ANIM-08 [M1a]: Root motion per frame (integer px).

### 4.5 Rig (FR-RIG)
**Setup**
- FR-RIG-01 [M1a]: Bones: add, delete, reparent, rename, and set length. Rest pose per view.
- FR-RIG-02 [M1a]: Skeleton templates: humanoid (bone names `root, pelvis, torso, neck, head, upper_arm_l/r, lower_arm_l/r, hand_l/r, thigh_l/r, shin_l/r, foot_l/r`) with a side view and a front/back view. [M1b]: quadruped.
- FR-RIG-03 [M1a]: Bind parts to bones automatically by layer name (`part:<bone>…`) or by overlap, and set pivots (pixel-centre).
- FR-RIG-04 [M1a]: Variants per part and view, with an optional `drawnAngle`.
- FR-RIG-05 [M1a]: **Joint coverage check.** For each joint, sweep the child's angle over ±N° (default 30°, step 5°) while the parent stays at rest. Report the pixels, within r (default 4) of the joint pivot, that were covered at rest, are transparent at θ, lie on the outer side of the bend, and are pinched between parent and child along a row, column or diagonal. The exact predicate is in `docs/contracts/JOINT_CHECK.md`. The result is deterministic and pinned by hand-written fixtures in `fixtures/joint/` (W2).
- FR-RIG-06 [M1a]: Default z per part per view. Z can be overridden with a part key.
- FR-RIG-07 [M1a]: **Split to parts** (for flat art):
  - select a region (rectangle, lasso, or a colour-bounded flood) and move it to a new PartLayer, leaving transparency behind;
  - the **overlap helper** shows the hidden area each joint needs (from the joint check) as a mask. The human or the LLM paints it (text grid, FR-AI-13) without changing the visible composite.
  - The split must recomposite to the source pixel for pixel (W2b).

**Posing & animation**
- FR-RIG-10 [M1a ops / M2 UI]: FK posing: bone angle, root and bone offsets (integer px), flip.
- FR-RIG-11 [M1a]: Sparse bone keys and part keys (§3).
- FR-RIG-12 [M1a]: Interpolation of bone keys: step, linear or ease-in-out (cubic), set per key. Results are **quantised**: angles snap to the animation's `angleQuantum` (default 1°) and offsets round half away from zero.
- FR-RIG-13 [M1b]: IK: analytic two-bone and FABRIK. Targets are handles. Committing a key **bakes the result to FK angles**.
- FR-RIG-14 [M1b]: **Variant auto-select** (part key `variant:'auto'`):
  - choose the variant whose `drawnAngle` is nearest to the bone's world angle, and rotate only by the residual;
  - **hysteresis**: keep the previous frame's variant until another variant is closer by more than `hysteresisDeg` (default 5°);
  - an explicit variant key always wins over auto;
  - if the residual is larger than `maxResidualDeg` (default 22.5°), lint warns.
- FR-RIG-15 [M1b]: Motion presets (generators of bone keys): idle-breathe, walk, run, jump (anticipation → rise → apex → fall → land), swing. They're parameterised and work on any skeleton that uses the template bone names.
- FR-RIG-16 [M1a]: **Mirroring is derived**:
  - an animation with `mirrorOf` stores nothing but `mirrorOf` (plus optional extra overrides);
  - its render is the source render flipped around `origin.x`, and its markers are mirrored (`x' = 2·origin.x − x`) but keep their names;
  - Godot applies it at runtime via `flip_h` (FR-GD-03);
  - "Bake mirror" (M3) materialises the mirror as a normal animation, for re-shading with the light direction kept.
- FR-RIG-17 [M1a ops]: Copy and paste poses, including "paste mirrored" (swaps the `_l`/`_r` keys and negates angles).

**Rendering**
- FR-RIG-20 [M1a] **Render order and maths** (deterministic, see NFR-02):
  1. Evaluate keys to quantised local transforms.
  2. **Hierarchical snapping**: start with the root at its integer position. For each child, rotate the rest offset to its parent attach point with fixed-point trig, round it, and add it to the parent's **snapped** pivot. A child pivot is never rounded independently of its parent.
  3. For each part, choose the variant and render it rotated by the residual with RotSprite. Then align it so the variant's pivot pixel lands exactly on the snapped pivot. Results are cached by `(variantId, quantisedAngle)`.
  4. Apply **part overrides**, anchored to the snapped pivot, to each part's own render.
  5. Composite: the parts, in z order (per view default, then the part keys), form **one rig block**. It's drawn at the tree position of the lowest part layer, so pixel layers before it in the tree are below the character and later ones are above.
  6. **Post-passes** (opt-in per animation, for any authored animation, rig or not): orphan removal, outline (cropped to the canvas).
  7. Apply **final overrides** (erase, then set).
  8. Apply the skin last, by colour on the RGBA composite, in both colour modes.

  Steps 1–4 belong to the rig (the `RigRenderer.renderParts` hook). Steps 5–8 belong to core's `renderFrame`. A mirror animation renders its source through steps 1–7, flips about `origin.x`, applies its own final overrides, then the skin. (T2.3 review, 2026-10-27.)
- FR-RIG-21 [M1a]: Rotation algorithm per part: RotSprite (default), nearest, or none. **RotSprite introduces no new colours**, and a test asserts it.
- FR-RIG-22 [M1a] **Overrides**:
  - drawing on a rig frame writes a part override if the stroke falls within one part's area, otherwise a final override;
  - a part override follows its part when the part moves. If the part's rotation or variant changes, the override becomes **stale** (baseHash mismatch), rather than being moved or dropped;
  - stale overrides are listed by lint and shown in the timeline. You can keep, discard, or re-base them (re-base means recapture baseHash under the current render).
- FR-RIG-23 [M1a]: **Bake**: rig animation → a plain pixel animation, as a new animation, or replacing in place with confirmation.
- FR-RIG-24 [M1a]: **`pf override import <doc> <anim> <frame> edited.png`** diffs an externally edited frame against the current render and writes the differences as overrides (part overrides where unambiguous, otherwise final). This is the touch-up path before the editor exists.

**Later**
- FR-RIG-40 [M3, **experimental**, behind a feature flag]: pixel-aware deform for stretchy parts. It gets its own spike and ADR.

### 4.6 Image → sprite converter (FR-CONV) [M1b]
- FR-CONV-01: Input PNG, JPEG or WebP, with an optional crop.
- FR-CONV-02: Background removal: none, colour key (picked, or auto from the corners), edge flood with tolerance, or existing alpha.
- FR-CONV-03: Target size (width or height, aspect kept), or **auto-detect the pixel grid** (dominant cell size and phase from the edge histogram; sample per cell) for upscaled or AI "fake pixel art".
- FR-CONV-04: Downscale: box average, **k-centroid**, nearest-centre, mode.
- FR-CONV-05: Quantise in **OKLab** to the active palette, a preset, or a generated palette.
- FR-CONV-06: Dithering: none, Bayer 2/4/8, Floyd–Steinberg, or a strength-limited mode.
- FR-CONV-07: Clean-up: alpha threshold, orphan removal, optional outline.
- FR-CONV-08: A variant grid with several parameter sets at once. The output goes into a new layer or document.
- FR-CONV-09: Every step is a pure, golden-tested function. The pipeline is described as a JSON **`ConvertRecipe`**.

### 4.7 LLM integration (FR-AI)
- FR-AI-01 [M1a]: Every mutation and query goes through the **Operation API** (§6.3). Each operation carries a zod schema, a description written for LLMs, examples, and a **safety class** (`read`, `mutate`, `destructive`, `io`).
- FR-AI-10 [M1a]: `pf mcp` runs an MCP server over stdio:
  - it reads `~/.pixel-forge/server.json`. If a compatible `pf serve` is running, it **forwards** to it, so edits show live in the UI;
  - otherwise it hosts the documents itself and takes the per-document **lockfiles** (§6.5);
  - streamable HTTP MCP is also exposed by `pf serve` [M2].
- FR-AI-11 [M1a ~15 tools / M1b ~40]: Tools are semantic and coarse-grained (§8).
- FR-AI-12 [M1a]: **Visual feedback**: render tools return MCP image content (an upscaled frame, a labelled contact sheet, or before/after), with the long edge at most 1568 px and an optional bone and pivot overlay. **Lint owns precision** (1 px gaps, off-palette pixels). **Vision owns gesture and readability.** Tool descriptions say so.
- FR-AI-13 [M1a] **Text pixel grids**:
  - a read returns a grid with a **per-call legend** covering the colours present (≤62 symbols `0-9A-Za-z`; an error beyond that), plus optional coordinate rulers;
  - in writes, `.` means transparent and `_` means keep;
  - writes are capped at 32×32 per call, and reads at 64×64.
- FR-AI-14 [M1a]: **MCP edits apply directly.** Each mutating call is one transaction labelled `AI: <tool>` and can be undone. `destructive` tools need `confirm: true`.
- FR-AI-15 [M1a]: Resources: `pf://docs`, `pf://doc/{id}/summary`, `…/palette`, `…/rig`, `…/animations/{group}/{direction}`.
- FR-AI-16 [M1b]: MCP prompts: animate-character, image-to-sprite, rig-character, split-flat-art.
- FR-AI-17 [M1b]: `rig_set_pose` also accepts **end-effector targets** (e.g. `hand_r → (24,30)`) and solves them with IK. LLMs place points more reliably than they chain angles.
- FR-AI-20 [**M3**] In-app AI panel:
  - an agent loop over the same operations, through an `LlmProvider` (Anthropic first, OpenAI-compatible later);
  - the key is stored in the OS keychain;
  - **proposal mode**: the run happens on a **forked document**. Accepting replays the run's operations on the main document as one transaction if its version hasn't changed since the fork; otherwise the user chooses to re-run on the current version or discard;
  - the panel shows the input tokens per request and the running total against a session budget (warning at 80 %).
- FR-AI-30 [M3]: An `ImageProvider` interface for text→image generation (OpenAI, Gemini, Retro Diffusion, PixelLab). The output always goes through the converter into a new layer.

### 4.8 Harness & automation (FR-HARN)
- FR-HARN-01 [M1a]: `pf check --script steps.json --out <dir>` runs operations headlessly and writes `report.json` (results, lint, timings, errors) and the PNGs it was asked for. Exit codes: 0 ok, 1 failure, 2 usage.
- FR-HARN-02 [M2]: The editor exposes a typed `window.__pf` (`ready`, `run(op, input)`, `state()`, `snapshot()`, `undo/redo`, `setTool`, stroke helpers). Changes are additive only, documented in `docs/contracts/AUTOMATION.md`.
- FR-HARN-03 [M2]: A Playwright e2e suite uses `__pf` plus screenshots.

### 4.9 Godot integration (FR-GD)
- FR-GD-01 [M1a]: `addons/pixel_forge` (Godot 4.6) with an `EditorImportPlugin` for `.pxf`. Godot re-imports automatically when the file changes. `_get_resource_type()` is `"Resource"`, and textures are embedded in the `.res`.
- FR-GD-02 [M1a] **Engine-neutral primary output** (`PixelForgeAsset`):
  - `atlas: Texture2D` per skin;
  - `frames: [{region: Rect2i, offset_px: Vector2i, duration_ms}]` (offsets handle trimming);
  - `animations: {group: {direction: {frames: [idx], loop, mirror: bool}}}`;
  - `markers: [frame_idx] → {name → Vector2i}`, `events`, `root_motion`;
  - `origin: Vector2i`, `pixels_per_unit`, `direction_fallback`.
- FR-GD-03 [M1a] **`PixelForgeDriver`** (Node), the single clock:
  - advances by `duration_ms`, emits `event(name)` and `finished`, and exposes `marker(name) → Vector2` in pixels relative to the origin, with a helper to convert to metres (`/ pixels_per_unit`);
  - **direction is an explicit property** set by the game. `auto_direction` (from the camera sector, 4 or 8) is optional;
  - it drives a target through one adapter method `apply(texture, region, offset, flip_h)`. Built-in adapters: `Sprite2D`, `Sprite3D`, and **duck-typed** for any node with `texture/region_rect/offset/flip_h` properties (matches the game's lit billboard node; GAME_NOTES §4, local);
  - mirrored directions set `flip_h` and mirror the markers;
  - **game-driven playback** (from the plan review, P-03): games that time frames from gameplay can use `paused`, `seek_ms(t)`, `set_frame(i)` and `hold_last` (hold the final frame until released), and get a `frame_changed(i)` signal. The exact mapping to the first consumer game (origin ↔ its feet row, the ball marker ↔ its prop anchor, per-frame rise ↔ root motion) is fixed by plan card T6.0 (GAME_NOTES §4, local).
- FR-GD-04 [M1a]: Import options: which animations and skins to include, trim on/off, and padding.
- FR-GD-05 [M1a]: The importer reads only the **render cache** in the `.pxf` (`ZIPReader` + JSON + `Image.load_png_from_buffer`). The rig is never evaluated in Godot.
- FR-GD-06 [M1b]: Convenience output: `SpriteFrames` per direction, plus `PixelForgeSprite2D` and `PixelForgeSprite3D` (billboard, nearest filter, alpha scissor) wrapping the driver.
- FR-GD-07 [M1a]: A demo scene, plus GUT tests run headless (`godot --headless`).
- FR-GD-08 [M3]: Normal maps (auto or from a painted layer). Index texture plus palette LUT export, for skins applied in a shader.

---

## 5. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-01 Performance | Sparse 16×16 tiles. Target document: 256×256, 64 layers, 300 frames, typically under 10 % filled. Draw feedback within 1 frame at 60 Hz [M2]. Rig render for a 64×64 / 16-part character: < 2 ms warm cache, < 10 ms per cold RotSprite of a 32×32 part (Node, Apple M1). Open a 5 MB `.pxf` in < 500 ms. Godot re-import < 1 s for 20 animations. |
| NFR-02 Determinism | Same document + operations ⇒ the **same hash of decoded RGBA** on macOS and Windows. The render path uses integer maths and a **fixed-point sin/cos table** at the angle quantum. No `Math.random` (seeded PRNG only). |
| NFR-03 File stability | Files are **byte-stable on load → save within the same pf version**. Encoding uses a pinned pure-JS deflate (`fflate`), never Node zlib or browser codecs. Sorted JSON keys, a fixed zip entry order and timestamps. A no-op save doesn't change `modified`. Schema migrations run forward only, and old fixture files must keep opening (test). |
| NFR-04 Testability | Core packages ≥ 85 % line coverage. Golden-image tests for raster, rig and convert. Property tests for invariants and frame operations. Every op has a schema test and an example. |
| NFR-05 Type safety | `strict` TS, no `any` in core packages (lint-enforced). TSDoc on public APIs. |
| NFR-06 Security | Bind to `127.0.0.1` only, with a random per-run token for WS and HTTP. MCP file I/O is restricted to configured workspace roots. Secrets live in the OS keychain. No `eval` of user input. |
| NFR-07 Offline | Everything except the LLM and image providers works offline. |
| NFR-08 UX | Every action is reachable by keyboard, and shortcuts can be remapped. UI scales 100–200 % with a crisp canvas. Dark and light themes. [M2] |
| NFR-09 Observability | JSON-lines logs. An operation trace per MCP session (`pf mcp --trace`). |
| NFR-10 Platforms | macOS 14+ on Apple Silicon. Windows 11 by M3. Editor in current Chrome or Edge (Safari best-effort). |
| NFR-11 Licensing | Permissive dependencies only (MIT, BSD, Apache-2.0, ISC, zlib), checked in CI. Palette presets record their sources. |

---

## 6. Architecture

### 6.1 Principles
1. **Headless core.** The UI is one client among several.
2. **One operation API** shared by the CLI, MCP, the UI, the harness and (later) the AI panel.
3. **Pure, deterministic functions at the bottom.** No I/O, no globals.
4. **Single owner per document.** One process hosts a given document (lockfile + discovery). Clients send operations and receive patches or snapshots.
5. **Additive contracts.** The file schema, the op API and `__pf` change additively. A breaking change needs an ADR and a migration.
6. **Code is the source of truth.** Contracts are documented and tested.

### 6.2 Packages (pnpm workspace, TypeScript, ESM)
```
schema   ← color ← raster ← rig ─┐
                         convert ─┼─ core ← lint ─┐
                                  │       io ─────┼─ ops ← server ← cli
                                  └───────────────┘          editor (M2, depends on ops types + core read-model + raster)
```
| Package | Responsibility | Depends on |
|---|---|---|
| `png` | Pure, deterministic PNG encode/decode on fflate (added after the plan review). Used by `testkit` and `io`. | — |
| `schema` | Domain types + zod schemas + ids + constants (angle quantum, tile size). No logic. | — |
| `color` | OKLab/OKLCH, palette ops, ramps, quantisation, palette file formats | schema |
| `raster` | Sparse tiled images, compositing, primitives, transforms, **RotSprite**, dithering, fixed-point trig | schema, color |
| `rig` | FK/IK, key interpolation and quantisation, hierarchical snapping, variant selection, part render, overrides and staleness, joint check, presets, templates | schema, raster |
| `convert` | Image→sprite steps + ConvertRecipe | schema, color, raster |
| `core` | Document store, transactions, patches, history, frame operations (§3.2), `validate()`, **`renderFrame`** | schema, raster, rig |
| `lint` | Findings: palette, orphans, joints, stale overrides, rotation residual, opacity | core, rig |
| `io` | `.pxf` read/write + migrations + render cache, PNG/GIF/JPEG/WebP codecs, spritesheet JSON, `.aseprite` import (+ re-import) | core, convert (for import remaps), png, schema, raster |
| `ops` | Op registry, definitions, handlers, error types, generators (MCP tool JSON, CLI, docs) | core, lint, io, rig, convert |
| `server` | DocumentHost, lockfiles and discovery, WS sync, HTTP, MCP transports, providers, keychain, workspace roots | ops |
| `cli` | `pf` binary: `serve`, `mcp`, `check` (harness), `convert`, `render`, `export`, `lint`, `override import`, `pack/unpack` | server, ops |
| `editor` [M2] | React UI | ops (types), core (read-model), raster |
| `godot/addons/pixel_forge` | GDScript importer, driver, adapters, GUT tests | (reads `.pxf` render cache) |

Enforced by `dependency-cruiser` in CI. `schema`, `color`, `raster`, `rig`, `convert` and `core` use no DOM and no Node built-ins. `io` takes a `FileSystem` port.

### 6.3 Operation API
```ts
export const setPose = defineOp({
  name: 'rig.setPose', safety: 'mutate',
  summary: 'Set bone keys (angle deg clockwise, offset int px) and/or part keys on one frame.',
  input: z.object({ doc: DocId, animation: AnimRef, frame: FrameRef,
                    bones: z.record(BoneName, BoneKeyInput).optional(),
                    parts: z.record(PartName, PartKeyInput).optional() }),
  output: z.object({ changed: z.array(z.string()) }),
  examples: [/* used for docs, tests, MCP descriptions */],
  handler: (ctx, input) => { /* mutate via ctx.tx only */ },
});
```
- The registry generates MCP tool definitions (JSON Schema), CLI subcommands, `__pf.run` typings, and `docs/contracts/OPERATIONS.md` (with a check that the generated docs are current, in CI).
- `ctx` provides the transaction, read-model, renderer, logger and ports. Handlers do no direct I/O.
- Errors are typed (`OpError {code, message, details}`) and serialised the same way over every transport.
- `AnimRef` is `{group, direction}` or an id. `FrameRef` is an index or a FrameId. Indices are resolved to IDs at the boundary.

### 6.4 State, transactions & history
- Immutable JSON structure plus **sparse copy-on-write tile stores**.
- A transaction records patches: structural (JSON-patch style) and tile before/after. Undo applies the inverses. Each document has one linear stack.
- `store.version` is a **runtime** counter, not saved in the document. It increases by 1 on every commit, undo and redo, so it is monotonic and is used for sync gap detection and proposal checks.

### 6.5 Process model, ownership & sync
```
 Claude Code ─stdio─ pf mcp ─┬─(server.json found & compatible)─WS─▶ pf serve ◀─WS/HTTP─ editor (browser)
                             └─(not found)─ in-process DocumentHost (headless)
```
- **Discovery**: `pf serve` writes `~/.pixel-forge/server.json` `{pid, port, token, protocolVersion}`. It's removed on exit, and stale entries are detected by pid.
- **Ownership**: whoever opens a document writes `~/.pixel-forge/locks/<sha1(path)>.lock` `{pid, host}`. A second process that wants the same document **forwards to the owner** if it's a `pf serve`, or refuses with `DOC_LOCKED` (including the owner's pid).
- **Saving**: write to `<file>.tmp-<pid>` then rename, so Godot never sees a partial file.
- **Sync** [M2]: the editor holds a read-model replica. It receives patches in version order, and on connect or any gap it requests a **full snapshot**. There's no merge logic. While a stroke is in progress the editor draws a local preview, then sends the stroke as one operation.

### 6.6 UI technology [M2]
- **React 19 + TypeScript + Vite + Zustand** (UI state and the read-model). The canvas uses Canvas2D with `ImageData` blits at integer zoom, with overlays on separate layers. WebGL is optional later, behind a `CanvasRenderer` interface.
- Delivery: `pf serve --open` opens the editor in the default browser. **A desktop shell is optional and decided in M3**, with Electron as the default candidate because the server is Node.

### 6.7 Render pipeline
`renderFrame(doc, animRef, frameRef, {skin?, includeReference?, layers?}) → RGBA` is pure and cached by an input hash. Pixel layers resolve their links. Part layers use the rig pipeline (FR-RIG-20). Opacity and visibility are applied, and only `export: true` layers go to the render cache.

### 6.8 Ports
`FileSystem`, `Clock`, `Keychain`, `LlmProvider`, `ImageProvider`, `ImageCodec`, `Lock`. Node implementations live in `server`, browser ones in `editor`, and fakes in tests.

---

## 7. File format `.pxf` (v1)
ZIP archive (deflate via `fflate`, fixed entry order):
```
manifest.json            { format:"pxf", schemaVersion:1, app:"pixel-forge x.y.z", created, modified }
document.json            model (§3) without pixel data; images referenced by id; keys sorted
images/<id>.png          RGBA8, or 8-bit grayscale (= palette index) in indexed mode
render/index.json        { schemaVersion, origin, pixelsPerUnit, directionFallback, skins:[…],
                           animations: { <group>: { <direction>: { loop, mirrorOf?, frames:[{ id, hash, durationMs,
                           image, markers, events, rootMotion }] } } } }
render/<skin>/<group>/<direction>/<n>.png   flattened export-layer frames (mirrored animations: no PNGs)
```
- The render cache is updated on save **per frame, by input hash**. You can turn it off for scratch files.
- `pf unpack` / `pf pack` convert to and from the folder form `.pxfd/`, which contains a `.gdignore` so Godot doesn't import its PNGs.
- Lockfiles and the journal are never stored next to the file.

---

## 8. MCP tool catalogue

**M1a (about 22 tools):**

| Area | Tools |
|---|---|
| Documents | `doc_open`, `doc_create`, `doc_save`, `doc_summary`, `undo` / `redo` |
| Pixels | `pixels_read_grid`, `pixels_write_grid` |
| Parts & rig | `part_split`, `rig_apply_template`, `rig_bind_parts`, `rig_edit_bones` (CRUD, length, rest pose per view), `rig_set_pivot`, `rig_set_pose`, `rig_mirror_animation`, `override_list` / `override_resolve` (keep, discard, re-base) |
| Cels & palette | `cel_link` (link, unlink, link identical), `doc_set_color_mode` (indexed, palette lock) |
| Animation | `anim_create` / `anim_update` (frames, durations, markers, events) |
| Checking | `render_frame`, `render_contact_sheet`, `lint`, `rig_joint_check` |
| Import / export | `import_file`, `export` |

**M1b (up to about 40 tools)** adds:

| Area | Tools |
|---|---|
| Layers | `layer_*` |
| Drawing | `draw_shapes`, `selection_transform`, `shade_with_ramp` |
| Palette | `palette_*`, `ramp_create`, `skin_*` |
| Converter | `image_to_sprite`, `convert_apply` |
| Rig | `rig_add_variant`, `rig_set_pivot`, `rig_ik_target`, `rig_apply_preset`, `rig_copy_pose`, `rig_bake` |
| Checking | `render_compare` |

Every tool description states the conventions: origin top-left, y down, angles in degrees clockwise, integer px. It also includes one example. Results are compact JSON, plus images where relevant.

---

## 9. UI specification [M2]

### 9.1 Layout (dockable, saved layouts)
```
┌───────────────────────────────────────────────────────────────────────────┐
│ Menu · Mode: [Draw | Rig | Animate] · Doc tabs                     ⚙     │
├────┬────────────────────────────────────────────────────┬─────────────────┤
│Tool│                 CANVAS                             │ Palette / Ramps │
│bar │  integer zoom · grid · onion skin ·                │ Skins           │
│    │  bone/pivot overlay (Rig/Animate) ·                ├─────────────────┤
│    │  joint-gap & stale-override markers                │ Layers / Bones  │
│    │                                     ┌──────────┐   │ / Views (tree)  │
│    │                                     │ Preview  │   ├─────────────────┤
│    │                                     └──────────┘   │ Properties/Lint │
├────┴────────────────────────────────────────────────────┴─────────────────┤
│ Animation: run ▾  direction: side ▾ │ ▶ ⏸ ⏮ ⏭ │ onion [◀3 ▸2]           │
│ TIMELINE rows = layers/parts (+ bone key rows in Animate) · cols = frames │
│ ● cel ○ empty ⛓ linked ◆ key ✎ override ⚠ stale                          │
└───────────────────────────────────────────────────────────────────────────┘
```
- Modes change the tools and overlays, never the document:
  - **Draw**: pixel tools;
  - **Rig**: bones, pivots, binding, split to parts, joint check;
  - **Animate**: posing, keys, IK handles.
- The converter is a modal workspace: source, parameters, variant grid, and insert as layer.
- MCP edits from Claude Code show up live, with a brief highlight and the `AI:` label in the history panel.

### 9.2 Interaction rules
- Single-key tools: B pencil, E eraser, L line, U shapes, G fill, I eyedropper, M select, V move, R rotate bone, P pose.
- `,` / `.` move between frames. Enter plays and pauses. Tab toggles onion skin. Space pans. The wheel zooms by integer steps.
- Everything can be undone. Only bake-in-place and deleting an animation ask for confirmation.

---

## 10. Milestones

| Milestone | Contents | Exit criterion |
|---|---|---|
| **M1a — Rig to game** | schema, color (presets, lock), raster (+RotSprite), rig (FK, explicit variants, hierarchical snapping, part and final overrides, mirror, bake, joint check, split to parts), core, lint, io (`.pxf`, PNG, `.aseprite` import and re-import, spritesheet export), ops, ~15 MCP tools, `pf` CLI (`mcp`, `check`, `render`, `export`, `lint`, `override import`), **Godot importer + PixelForgeDriver** | **The target move (4 phases, 12 frames, side view, 64×64; GAME_NOTES §5, local) is rebuilt as a rig from the licensed pack frames split into parts, touched up via `pf override import`, and plays in the first consumer game through its lit billboard node** (W2, W2b, W3-manual, W4-CLI, W5). The pack art stays in the game repo (its licence doesn't allow redistribution; GAME_NOTES §2). pixel-forge's own tests use synthetic fixtures only. |
| **M1b — Breadth** | IK + end-effector poses, motion presets, variant auto-select, **converter**, palette generation, ramps, skins, GIF, quadruped template, SpriteFrames and Sprite2D/3D nodes, the rest of the MCP tools | W1, W3-presets, W7 |
| **M2 — Editor** | `pf serve`, sync, React editor (canvas, tools, palette, layers, timeline, onion skin, Rig and Animate modes, overrides UI, converter workspace), `__pf`, Playwright suite | W4-editor, W6 |
| **M3 — Reach** | Windows support + CI, optional desktop shell, AI panel (proposals), image providers, `.aseprite` export, normal maps, LUT skins, bake mirror, **experimental warping** | — |

---

## 11. Risks
| Risk | Mitigation |
|---|---|
| RotSprite quality or speed at 16–64 px | **Spike first** in M1a with the user's real art. Variants are first-class. Algorithm chosen per part. |
| Joint jitter or gaps in rotated limbs | Hierarchical snapping, RotSprite carrying the attach pixel, the joint check, joint caps |
| LLM posing gives stiff motion | Presets as the base (M1b), end-effector targets, contact sheets, lint. A human touch-up path exists from M1a. |
| Splitting flat pack art is laborious | Split tool + overlap helper + LLM painting via text grid. Worst case: redraw parts. |
| Scope creep | M1a is a narrow vertical slice into the game, and every milestone stands alone |
| `.aseprite` edge cases | Implement the documented spec, test with the user's files, fall back to PNG |
| Ownership / lock bugs lose work | Atomic saves, lock tests with two processes, autosave journal (M2) |

## 12. ADRs (`docs/adr/`)
ADR-001 Option D, headless core · ADR-002 package graph (§6.2) · ADR-003 operation API (zod registry) · ADR-004 single owner + snapshot sync ·
ADR-005 `.pxf` zip + render cache · ADR-006 browser-first, desktop shell deferred · ADR-007 sparse tiles + patch history ·
ADR-008 RotSprite + variants + overrides (warping deferred) · ADR-009 Godot: engine-neutral baked output + driver ·
ADR-010 determinism rules (fixed-point trig, fflate, decoded-RGBA hash) · ADR-011 views and mirroring model

## 13. Decisions (resolved 2026-10-26)
1. Name: **pixel-forge**, CLI `pf`.
2. Hosting: **public** GitHub repo `pixel-anvil/pixel-forge` in a new org that isn't tied to the author's name. **MIT** licence. Commits use a pseudonymous, unlinked identity. CI on GitHub Actions (free for public repos): ubuntu and macOS on every push, Windows from M3. Details of the first consumer game stay out of the repo (local `~/pf-work/GAME_NOTES.md`).
3. AI panel: **M3 or later**. Claude Code via MCP covers it until then.
4. M1a exit move: **the target move** (all four phases; GAME_NOTES §5). Assumed source: the licensed pack frames split into parts (this exercises W2b). Switch to newly drawn parts if splitting proves too laborious.
