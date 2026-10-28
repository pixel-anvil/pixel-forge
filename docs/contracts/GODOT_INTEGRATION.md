# Godot integration contract (FR-GD-02, FR-GD-03)

**Status:** defined by T6.0. Implemented by T6.1 (`PixelForgeAsset`, importer) and T6.2 (`PixelForgeDriver`,
adapters). Checked on the first consumer game by D1 (flat frames) and T6.5 (rigged frames).
**Inputs:** the `.pxf` render cache only (`render/index.json` plus `render/<skin>/…png`, spec §7, FR-GD-05).
The rig is never evaluated in Godot. The code-level reference for the cache is `packages/io/README.md`
("Render cache") and `packages/schema/src/render.ts`.

The first consumer game's own names, file paths and line references for every row below are kept in a
private appendix (GAME_NOTES, local). This document uses generic descriptions only.

## 1. Conventions

- **Canvas pixels:** origin top-left, x right, y down, integer pixels. A pixel `(x, y)` covers the square
  `[x, x+1) × [y, y+1)`; its centre is `(x + 0.5, y + 0.5)`.
- **Origin pixel** `O = (ox, oy)`: `render/index.json` `origin` (the document's `meta.origin`), the same for
  every frame, skin and animation.
- **Origin point** `A = (ox + 0.5, oy + 1)`: the bottom-centre of the origin pixel, in continuous canvas
  coordinates. This is the point that sits on the game node's origin (its feet / ground contact). Reasons:
  - mirroring (FR-RIG-16, `x' = 2·ox − x` on pixel indices) reflects about the vertical line through the
    centre of the origin pixel, `x = ox + 0.5`, so a runtime `flip_h` about `A.x` equals pixel-forge's
    mirrored render exactly;
  - feet drawn on row `oy` stand on the ground line at the bottom edge of that row;
  - the importer default origin `(floor(w/2), h−1)` (io README, "Origin default") puts the ground line on
    the canvas's bottom edge.
- **Pixel offsets in this contract are relative to `A`.** Engine-side vectors say whether they are y-down
  (canvas, 2D) or y-up (3D, the game's billboard).
- **Metres:** `metres = pixels / pixels_per_unit` (`pixelsPerUnit` in the index is pixels per metre for a 3D
  game). Metres are always y-up.
- **Time:** frame durations are integer milliseconds (`durationMs`, FR-ANIM-03). The driver keeps its play
  position as a float in milliseconds.
- **Names** (groups, directions, markers, events, skins) follow spec I7, `^[a-z0-9_\-]{1,48}$`, and arrive in
  Godot as `StringName`.

## 2. `PixelForgeAsset` (T6.1)

A `Resource` produced by the import plugin. FR-GD-02 lists the fields; this section fixes their meaning.

| Field | Type | Source in the `.pxf` | Meaning |
|---|---|---|---|
| `atlases` | `Dictionary[StringName, Texture2D]` | `render/<skin>/…png`, packed | One atlas per imported skin (`base` always). **Every atlas uses the same layout**, so a frame's `region` is valid in all of them. |
| `frames` | `Array[Dictionary]` | one entry per frame of every authored animation entry, in sorted group, direction, index order | `{region: Rect2i, offset_px: Vector2i, duration_ms: int}`. One entry per **authored frame**, never deduplicated by hash (markers and events differ per frame); equal images may share a `region`. |
| `frames[i].region` | `Rect2i` | atlas packing | Pixels of the frame in the atlas (trimmed when the trim option is on). |
| `frames[i].offset_px` | `Vector2i` | trim | Canvas position of the region's top-left pixel. `(0, 0)` and region size = canvas size when untrimmed. |
| `frames[i].duration_ms` | `int` | `durationMs` | Display time of the frame. |
| `animations` | `Dictionary` | `animations[group][direction]` | `{group: {direction: {frames: PackedInt32Array, loop: StringName, mirror: bool}}}`. `loop` is `loop`, `once` or `pingpong`. An undirected animation uses direction `default` (spec §3.4.3). |
| `animations[g][d].mirror` | `bool` | entry has `mirrorOf` | `true`: `frames` are the indices of the same group's `mirrorOf` direction and the driver flips them at runtime. A mirror **with** overrides is a normal entry with its own frames and `mirror: false` (spec §3.4.1). |
| `markers` | `Array[Dictionary]`, by frame index | `frames[].markers` | `{name: Vector2i}` in **canvas pixels**, as stored (spec §3.4.9). A name missing from a frame means the marker is absent in that frame. Already mirrored for a mirror-with-overrides entry. |
| `events` | `Array[PackedStringArray]`, by frame index | `frames[].events` | Event names in authored order. |
| `root_motion` | `Array[Vector2i]`, by frame index | `frames[].rootMotion` | `(dx, dy)` in canvas pixels, y down (section 7). |
| `origin` | `Vector2i` | `origin` | The origin pixel `O`. |
| `pixels_per_unit` | `float` | `pixelsPerUnit` | Pixels per metre. |
| `direction_fallback` | `Dictionary[StringName, PackedStringArray]` | `directionFallback` | Directions to try, in order, per requested direction. |
| `canvas_size` | `Vector2i` | size of any frame PNG (all are canvas-sized) | **Addition** to FR-GD-02 (section 10). |
| `skins` | `PackedStringArray` | `skins`, filtered by the import option | Imported skin keys, `base` first. |

**Helper methods** (pure functions over the fields; T6.1 implements them and GUT-tests them):

- `resolve(group: StringName, direction: StringName) -> Dictionary`: the entry the driver would play.
  Tries `direction_fallback[direction]` in order (or `[direction]` when it has no entry), then `default`.
  Returns `{group, direction, frames, loop, mirror}` with `direction` the key actually found, or `{}` when the
  group has none of them.
- `has_animation(group: StringName, direction: StringName = &"") -> bool`: `resolve(...)` is not empty. With
  an empty `direction`, true when the group has any entry.
- `frame_count(group, direction) -> int` and `duration_ms(group, direction) -> int` (sum of `duration_ms`
  over one pass) of the resolved entry, `0` when unresolved.
- `marker_px(frame_index: int, name: StringName, mirror: bool) -> Vector2` and
  `marker_metres(frame_index, name, mirror) -> Vector2`: section 6 maths for any frame, so a game can ask
  about animations that are not playing. Callers check `has_marker(frame_index, name)` first; an absent
  marker returns `Vector2.ZERO` and pushes no error.

### 2.1 Importer details (T6.1)

Decisions the sections above leave open; the code is `godot/addons/pixel_forge/` and `godot/README.md`.

- **Entry points:** `PixelForgePxfReader` (`open`, `read_png`), `PixelForgeAsset.build(reader, options, report)` (returns
  null and fills `report.errors` on failure; `report.warnings` lists names the options mention that the file lacks) and
  `PixelForgeAsset.shelf_pack(sizes)`. The `EditorImportPlugin` is a thin shell over `PixelForgeImport.run()`.
- **Options:** `animations` and `skins` are comma-separated strings (empty means all; `base` is always imported);
  `animations` takes `group` or `group/direction`, and selecting a mirror also imports its source direction (the
  source alone does not import the mirror). `trim` (default on) and `padding` (default 1, clamped to 0..64).
- **Trim:** a frame's box is the union of the opaque pixels (alpha > 0) over the imported skins, so one layout serves every
  skin. A fully transparent frame is a 1x1 region at `offset_px (0, 0)`; a `render/` PNG that is not canvas-sized is an error.
- **Packing:** unique PNG paths are packed once (frames sharing a PNG share a `region`); tallest first, then widest, then input
  order; width is a power of two (at most 4096 unless one region is wider), height is what the shelves use. `region` excludes
  the padding; the padding pixels are transparent.
- **`resolve` edge cases:** an empty `direction` resolves like `default`; a direction that has a `direction_fallback` entry
  tries only that list, then `default`.
- **Index checks:** the reader rejects an index with `schemaVersion` newer than 1, a missing `base` skin, a mirror whose source
  is not an authored direction of the same group, or frames with a missing image, a non-positive duration or malformed markers.

## 3. `PixelForgeDriver` (T6.2)

A `Node`. It is the only clock: nothing else picks frames. It drives one target node through an adapter
(section 8).

### 3.1 Properties

| Property | Type | Default | Semantics |
|---|---|---|---|
| `asset` | `PixelForgeAsset` | `null` | The imported asset. Setting it stops playback until `play()`. |
| `target` | `Node` | `null` | The node the adapter drives. |
| `skin` | `StringName` | `&"base"` | Atlas to use. Changing it re-applies the frame. |
| `direction` | `StringName` | `&"default"` | Set by the game (FR-GD-03). Changing it re-resolves the current group (section 3.4). |
| `auto_direction` | `int` | `0` | `0` off; `4` or `8` derives `direction` from the camera sector (M1a optional). |
| `mirror` | `bool` | `false` | **Addition.** A game-requested horizontal mirror (for example "facing left" on art that faces right). The flip actually applied is `mirror XOR resolved.mirror`. Markers and root motion follow the applied flip. |
| `paused` | `bool` | `false` | `true` stops the clock. The frame stays on screen and is still re-applied when `skin`, `direction` or `mirror` change. `seek_ms` and `set_frame` work while paused. |
| `hold_last` | `bool` | `false` | `true`: playback stops on the last frame of the first forward pass, whatever the loop mode, and stays there until cleared (section 3.3). |
| `clock_mode` | `int` enum | `IDLE` | **Addition.** `IDLE` advances in `_process`, `PHYSICS` in `_physics_process`, `MANUAL` only through `advance()` (tests, games with their own tick). |

Read-only: `group: StringName`, `frame: int` (index within the resolved animation, `0..n−1`),
`frame_index: int` (index into `asset.frames`), `position_ms: float`, `is_flipped() -> bool` (the applied
flip), `is_finished() -> bool`.

### 3.2 Methods

| Method | Semantics |
|---|---|
| `play(group: StringName, direction: StringName = direction, restart := false) -> bool` | Sets `direction`, resolves `(group, direction)`. When the resolved entry (group, found direction) is the one already playing and `restart` is false, nothing changes and playback continues. Otherwise the position goes to `0`, frame 0 is applied and its events fire (section 4). Returns `false`, pushes an error and keeps the current animation when nothing resolves. |
| `seek_ms(t: float, emit_events := true)` | Sets `position_ms = max(t, 0)` on the current animation's timeline (section 3.3) and applies the frame. |
| `set_frame(i: int, emit_events := true)` | `i` is clamped to `0..n−1`. Sets `position_ms` to the start of frame `i` (its first occurrence for `pingpong`) and applies it. |
| `advance(delta_s: float)` | Adds `delta_s * 1000` to `position_ms` unless `paused`. Called by the driver itself in `IDLE` / `PHYSICS` mode. |
| `frame_progress() -> float` | `(t − start_i) / d_i` in `[0, 1)` within the displayed frame; `1.0` while held on the last frame by `hold_last` or at the end of a `once` animation. |
| `has_marker(name: StringName) -> bool` | The displayed frame has the marker. |
| `marker(name: StringName) -> Vector2` | Section 6, pixels, y down, relative to `A`, flipped when `is_flipped()`. `Vector2.ZERO` when absent. |
| `marker_metres(name: StringName) -> Vector2` | Section 6, metres, y up, relative to `A` (the node origin), flipped. `Vector2.ZERO` when absent. |
| `frame_events() -> PackedStringArray` | The displayed frame's event names (the event-as-flag query, section 4.3). |
| `root_motion() -> Vector2i` | The displayed frame's `root_motion`, with `dx` negated when flipped. |

### 3.3 Timeline

For the resolved animation with frame durations `d_0 … d_{n−1}`, `T = Σ d_i`, `start_i = Σ_{j<i} d_j`:

- **`once`:** the frame at `t` is the `i` with `start_i ≤ t < start_i + d_i`; for `t ≥ T` it is `n−1` and the
  animation is finished.
- **`loop`:** as `once` at `t mod T`.
- **`pingpong`:** the frame sequence `0, 1, …, n−1, n−2, …, 1` repeats (each entry with its own duration),
  so the cycle is `T + Σ_{i=1}^{n−2} d_i`. With `n = 1` it is `loop`.
- **`hold_last`:** while true, `position_ms` never passes `T` (the end of frame `n−1` on the first forward
  pass) and the displayed frame at `T` is `n−1`, for every loop mode. When it is cleared, `once` stays
  finished, and `loop` / `pingpong` continue from `T` (the next frame is `0`, respectively `n−2`).
- **`finished`** is emitted once per `play()` when the position reaches `T` on a `once` animation, or when
  `hold_last` stops the position at `T` on any animation. It is not emitted by looping animations.
- **`frame_changed(i)`** is emitted whenever the displayed frame changes (by the clock, `play`, `seek_ms`,
  `set_frame` or a direction change), with `i` the index within the animation, after the adapter has applied
  the frame. Re-applying the same frame (skin or mirror change) does not emit it.
- Durations come from the asset as integers, so frame boundaries are exact; `position_ms` is a float so
  `_process` deltas do not drift.

### 3.4 Direction and mirroring

- `direction` is explicit (FR-GD-03). On a change the driver re-resolves the current group with the same
  `position_ms` (wrapped or clamped by the new entry's timeline). If the displayed frame changes,
  `frame_changed` is emitted but **no events fire** (directions of one group share their event timing).
- The applied flip is `mirror XOR resolved.mirror`. It sets the adapter's `flip_h`, negates the x of the
  adapter offset (section 8), of every marker (section 6) and of root motion.
- A game whose art faces one way and mirrors for the other keeps a single authored direction (for example
  `side`) and sets `mirror`. A game that authors explicit mirror directions (`left` with `mirrorOf: right`)
  leaves `mirror` false. Both are valid; the first consumer game uses `mirror`.

## 4. Events

### 4.1 Names

- Events are the per-frame `events` of the render cache, declared in the document's `eventDefs`. They carry no
  payload. Consumers ignore names they do not know.
- Names keep the anatomical side (`hand_r` style) like markers; mirroring never renames them.
- Names used with the first consumer game (T6.4 adds them to the rigged move; D1 sets them on the flat one):

| Name | Kind | Frames | Meaning |
|---|---|---|---|
| `release` | event | the first frame after the prop leaves the hand | Informational: the game decides the release from gameplay and may ignore it. |
| `ball_drawn` | flag (section 4.3) | every frame whose pixels draw the prop itself | The game hides its own prop sprite while held in these frames. |

### 4.2 Delivery rules

1. An event fires when its frame **starts** being displayed (schema: "fired when the frame starts"), as
   `event(name)`, in authored order, right after that frame's `frame_changed`.
2. `play()` that starts an animation fires frame 0's events.
3. The clock never drops events: when one `advance()` crosses several frames, every crossed frame's events
   fire in timeline order (including frame 0 on each loop wrap and every frame entered by `pingpong`, in both
   directions). `frame_changed` fires once, for the frame finally displayed.
4. `seek_ms` and `set_frame` are jumps: they fire the target frame's events when the displayed frame changes
   and `emit_events` is true, and never the events of frames jumped over. Seeking to the frame already shown
   fires nothing.
5. A frame held by `hold_last`, a paused driver, or a re-apply (skin, mirror) fires nothing more.
6. A direction change fires no events (section 3.4).
7. Signals are emitted synchronously from the call that caused them (`advance`, `play`, `seek_ms`,
   `set_frame`, a property setter). A handler that calls `play()` or `seek_ms()` takes effect at once; the
   remaining events of the interrupted step are dropped.

### 4.3 Events as per-frame flags

A per-frame boolean (for example "the art draws the prop in this frame") is written as an event name present
on every frame where it is true. The game reads it as state with `frame_events().has(name)` (or
`asset.events[i]`), not through the signal. This needs no schema change; the signal for such a name is
harmless noise that consumers ignore.

## 5. Origin ↔ the game's feet row

- The game's **feet row** is "the row (px from the top of the frame) just below the feet", measured on the
  standing frame. pixel-forge's origin pixel is the **lowest row of the feet**:
  `origin.y = feet_row − 1`, so the ground line `A.y = origin.y + 1 = feet_row`.
- `origin.x = floor(canvas_w / 2)` (the io default) for art the game centred horizontally in its frame. The
  game mirrored about the frame centre `canvas_w / 2`; pixel-forge mirrors about `origin.x + 0.5`. For an
  even canvas width the picture therefore sits half a pixel left of where the game drew it (unmirrored) and
  half a pixel right (mirrored). Prop positions computed from markers do not move (section 6.2).
- The game no longer computes its own "lift the frame so the feet sit on the node" offset: the driver's
  adapter offset includes the origin (section 8).

## 6. Markers and the prop anchor

### 6.1 Maths

For a marker at canvas pixel `m = (mx, my)` in the displayed frame, with flip sign `s = −1` when flipped
and `+1` otherwise:

- `marker(name) = Vector2(s · (mx − ox), my − oy − 0.5)`: from `A` to the marker pixel's centre, pixels,
  y down.
- `marker_metres(name) = Vector2(s · (mx − ox), oy + 0.5 − my) / pixels_per_unit`: the same, y up, metres.

`(mx + 0.5) − (ox + 0.5) = mx − ox`, so x is always an integer and a mirror flip is exact (FR-RIG-16:
`x' = 2·ox − mx` gives `−(mx − ox)`). Absent markers: `has_marker` is false and both return zero.

### 6.2 The game's prop-anchor inputs

The game turns a marked prop point into a world offset from the character's feet. Its inputs map as follows
(row ids are referenced by the private appendix):

| Id | Prop-anchor input (generic) | Source |
|---|---|---|
| P1 | prop point in frame pixels, y down (per frame, from the sprite-sheet record) | marker `ball` of the frame: `asset.markers[i]["ball"]`. Already includes any lift (section 7), so the game no longer subtracts it. |
| P2 | frame size (to centre the point horizontally) | not needed: `marker*()` are relative to `A`, which replaces "point.x − frame_w / 2". (`canvas_size` if wanted.) |
| P3 | feet row (to measure the height above the ground) | not needed: `marker*()` are relative to `A`, which replaces "feet_row − point.y". |
| P4 | metres per pixel | `1 / pixels_per_unit` (applied inside `marker_metres`). |
| P5 | facing right (mirror the point) | `is_flipped()`, applied inside `marker*()`; for frames not playing, `asset.marker_metres(i, name, mirror)`. |
| P6 | minimum height above the floor | game-side (gameplay tuning). |
| P7 | depth toward the camera | game-side (3D placement). |

Result: `prop_offset = Vector3(v.x, max(v.y, min_height), depth)` with `v = driver.marker_metres(&"ball")`.

Numerically, `x` equals the game's current maths exactly when `origin.x = canvas_w / 2`; `y` is
`0.5 px / pixels_per_unit` lower, because the game measured from the top edge of the marked pixel and the
contract measures from its centre. D1 must check any game test that pins a prop height with a tolerance
tighter than half a pixel.

## 7. Per-frame rise and root motion

The game's per-frame **rise** ("rows the figure is lifted (+) or lowered (−) in this frame") moved the
picture and the prop point together, every frame, without accumulating. It is a drawing offset, not motion.

- **Decision:** a rise is **baked into the render**. The figure is drawn at its final place on the canvas
  (a flat import moves each frame's cel by `(0, −rise)`; a rig poses the root bone there), and markers are
  placed where the prop actually is. The game applies no rise. Make the canvas tall enough for positive
  rises; trimming (FR-GD-04) removes the empty rows from the atlas when the target allows trimming
  (section 8.3 for the lit billboard).
- **No per-frame `offset` channel** is added: every use of the rise in the game (picture offset, prop point)
  is covered by the baked pixels and markers, and FR-GD-05 keeps the rendered frame the single truth.
- **Root motion** (`rootMotion`, FR-ANIM-08) keeps its own meaning: the displacement of the character's root
  during the frame, in canvas pixels, y down. It **never moves the picture** in the render or in the driver
  (the render is already placed relative to the origin). The game reads `root_motion()` and decides whether
  to move its node; the first consumer game ignores it in M1a because its jump physics move the node.

## 8. Adapters

### 8.1 `apply(texture, region, offset, flip_h)`

The driver calls the adapter after every frame change and every re-apply:

- `texture: Texture2D`: `asset.atlases[skin]`.
- `region: Rect2i`: `asset.frames[frame_index].region`.
- `offset: Vector2`: **the centre of the region relative to `A`, in pixels, y down, already flipped**:
  `c = Vector2(s · (rx + rw/2 − ox − 0.5), ry + rh/2 − oy − 1)` with `(rx, ry) = offset_px` and
  `(rw, rh) = region.size`.
- `flip_h: bool`: `is_flipped()`.

Adapters convert `offset` to their node's convention and must **not** mirror it again: Godot's
`Sprite2D` / `Sprite3D` and the game's billboard flip only the texture inside the same rectangle. T6.2 GUT
tests a trimmed, asymmetric frame, mirrored, against the pixel-forge mirrored render for each adapter.

### 8.2 Built-in adapters

| Node | Settings | `offset` assignment |
|---|---|---|
| `Sprite2D` | `region_enabled = true`, `centered = true` | `offset = c` (y down). |
| `Sprite3D` | `region_enabled = true`, `centered = true`, `pixel_size = 1 / pixels_per_unit` | `offset = Vector2(c.x, −c.y)` (y up). |
| duck-typed | any node with `texture`, `region_rect`, `offset`, `flip_h` | `offset = Vector2(c.x, −c.y)` when `offset_y_up` (default `true`), else `c`. Sets `pixel_size = 1 / pixels_per_unit` when the node has that property and `apply_pixel_size` (default `true`). |

The picture's position is half-pixel exact. A 2D game that wants texel-aligned output places its node on a
half-pixel x when needed; the adapter never rounds (rounding would break mirror exactness).

### 8.3 The game's lit billboard

The first consumer game draws characters with a custom lit billboard node: a quad centred on the node that
offers `texture`, `region_rect` (empty = whole texture), `flip_h`, `pixel_size` (metres per pixel) and
`offset` (pixels, **+y moves the picture up**). Its shader flips the texture coordinates for `flip_h` and
shades with a normal tilted across the quad's width.

- Use the **duck-typed adapter** with `offset_y_up = true`: `offset = Vector2(c.x, −c.y)`,
  `region_rect = Rect2(region)`, `texture = atlas`, `flip_h`, `pixel_size = 1 / pixels_per_unit`.
- **Import with trim off** for this node. Its shading depends on the quad's width (the normal tilt runs across
  the whole quad), so a trimmed region would shade differently per frame. Untrimmed frames also match the
  game's current quad size.
- Each property setter of that node rebuilds the quad, so the adapter **assigns only properties that
  changed**, in the order `texture`, `region_rect`, `offset`, `flip_h`.
- Worked example: canvas 64×64, origin `(32, 55)`, untrimmed frame: `c = (−0.5, −24)`, billboard
  `offset = (−0.5, 24)`, mirrored `(0.5, 24)`. The game's previous offset was `(0, feet_row − 32) = (0, 24)`.
  A trimmed 20×30 region at `offset_px (22, 26)`: `c = (−0.5, −15)`.

## 9. Mapping from the game's art records to the asset

Every field and method of the game's character-art record (one per character) and sprite-sheet record (one
per animation) that its shot controller uses, with its source. Concrete names and line references: private
appendix, by row id. "Driver" means `PixelForgeDriver`; "asset" means `PixelForgeAsset`.

### 9.1 Character-art record

| Id | Game field / method (generic) | Source |
|---|---|---|
| A1 | default art id (which character art to load) | which `.pxf` the game loads (one `PixelForgeAsset` per character); recolours of one character are `skins` (driver `skin`). |
| A2 | load art by id | `load("res://…/<character>.pxf") as PixelForgeAsset`. |
| A3 | metres per pixel, from the art's pixel density (or a standing-height fallback) | `1.0 / asset.pixels_per_unit`. The fallback is not needed: `pixelsPerUnit` is required. |
| A4 | feet row (px from top, the row just below the feet, measured on the standing frame) | `asset.origin.y + 1` (section 5). The driver's adapter offset already uses it. |
| A5 | animation by name, with the game's fallback chain | game name → `(group, direction)` (section 9.3), then the game's cross-move fallback table (game-side), then `asset.resolve(group, direction)`, which applies `direction_fallback`. |
| A6 | has-animation by name | `asset.has_animation(group, direction)`. |
| A7 | own-name rule (an undrawn move variant uses a sibling move's art) | game-side naming logic over `asset.has_animation`. |
| A8 | "every view mirrors" flag (three-quarter art) | game-side policy that sets the driver's `mirror`; views without art fall back by `direction_fallback` (`down: [down, side]`, `up: [up, side]`). |
| A9 | the art's own prop texture (for the prop in flight) | not part of the character asset: a separate `.pxf` (one undirected animation) or a plain texture, game-side. |

### 9.2 Sprite-sheet record (per animation)

| Id | Game field / method (generic) | Source |
|---|---|---|
| S1 | texture | `asset.atlases[skin]`, applied by the driver. |
| S2 | frame size | `asset.canvas_size` (addition). The game no longer needs it with the driver (P2, section 8). |
| S3 | frame count | `asset.frame_count(group, direction)`. |
| S4 | columns, frame rect of frame `i` | `asset.frames[frame_index].region` (+ `offset_px`), applied by the driver. Out-of-range indices: `set_frame` clamps. |
| S5 | fps | `duration_ms` per frame: `round(1000 · hold_i / fps)` at import. |
| S6 | per-frame holds (multiples of `1/fps`) | folded into `duration_ms` with S5 (FR-ANIM-03: a hold is a longer duration). |
| S7 | loop flag (`false`: play once, hold the last frame) | `animations[g][d].loop`: `true` → `loop`, `false` → `once`. |
| S8 | frame at time `t` (by loop flag) | driver clock (section 3.3); `driver.frame`. |
| S9 | frame at time `t` played once, holding the last frame whatever the loop flag | driver with `hold_last = true` (section 3.3). |
| S10 | duration (one pass) | `asset.duration_ms(group, direction) / 1000.0`. |
| S11 | has prop points | `driver.has_marker(&"ball")`; for a frame not playing, `asset.markers[i].has("ball")`. One point serving every frame becomes the marker on every frame. |
| S12 | prop point of frame `i` (frame pixels, y down) | marker `ball`: `driver.marker()` / `marker_metres()` (section 6). |
| S13 | prop point between frames at time `t` (glide for a looping dribble) | game-side lerp from marker `ball` of frame `i` to frame `(i+1) mod n` by `driver.frame_progress()`. |
| S14 | rise of frame `i` (rows lifted, + up) | baked into pixels and markers (section 7); always 0 for the game. |
| S15 | art draws the prop in frame `i` | flag event `ball_drawn`: `driver.frame_events().has(&"ball_drawn")` (section 4.3). |
| S16 | jump height set by the art (metres, 0 = game decides) | game-side per-move table (no asset source in M1a); see section 10. |
| S17 | record identity and time since it started (restart when the animation changes) | `driver.play(group, direction)`: restarts only when the resolved entry changes; `driver.position_ms`. |

### 9.3 Names

The game names animations `<move>[_<phase>][_<view>]` with views `side` (no suffix), `down`, `up`. The
asset uses `group = <move>[_<phase>]` and `direction = side | down | up`. The game keeps its cross-move
fallback table; the "view without art falls back to the side view of the same move" rule becomes
`direction_fallback`.

### 9.4 Billboard properties written by the shot controller

| Id | Billboard property | Source |
|---|---|---|
| L1 | `texture` | adapter, `asset.atlases[skin]`. |
| L2 | `region_rect` | adapter, `Rect2(frames[i].region)`. |
| L3 | `offset` (feet-row lift + per-frame rise, +y up) | adapter, `Vector2(c.x, −c.y)` (section 8); the rise is baked. |
| L4 | `flip_h` (side view facing left, or every view for three-quarter art) | adapter, `is_flipped()`; the game sets `driver.mirror`. |
| L5 | `pixel_size` | adapter, `1 / pixels_per_unit` (A3). |

## 10. Required additions

None needs a change to `document.json` or `render/index.json`.

| Addition | Where | Owner |
|---|---|---|
| `canvas_size: Vector2i` (from the frame PNG size) | `PixelForgeAsset` (FR-GD-02) | T6.1 |
| one shared atlas layout for all skins; frames per authored frame (no hash dedup of entries) | importer | T6.1 |
| helpers `resolve`, `has_animation`, `frame_count`, `duration_ms`, `has_marker`, `marker_px`, `marker_metres` | `PixelForgeAsset` | T6.1 |
| `mirror`, `clock_mode`, `advance()`, `play()`, `frame_progress()`, `has_marker()`, `frame_events()`, `root_motion()`, `is_flipped()`; the timeline, event and offset rules above | `PixelForgeDriver` (FR-GD-03) | T6.2 |
| duck-typed adapter options `offset_y_up`, `apply_pixel_size`; assign-only-changed | adapters | T6.2 |
| D1 flat build: per-frame cel offset `(0, −rise)`, marker `ball`, flag event `ball_drawn`, `release`, origin from the feet row, durations from fps × holds, trim off | D1 script | D1 |

Deferred (not needed by the contract): per-animation user metadata (would carry S16). File a card if a game
needs art-owned per-animation numbers.

## 11. Test obligations

- **T6.1:** every atlas region, cropped, equals its `render/<skin>/*.png` frame pixel for pixel (trim on and
  off); `offset_px` + `region` reconstruct the canvas-sized frame; `resolve` follows `direction_fallback`
  and `mirrorOf`; markers, events and root motion survive unchanged.
- **T6.2 (GUT, `MANUAL` clock):** the timeline of section 3.3 for each loop mode with uneven durations;
  `hold_last` on `loop` and `pingpong`; `seek_ms` / `set_frame` event rules (section 4.2, rules 3 and 4);
  no lost events on a large `advance`; `mirror XOR mirrorOf`; marker maths of section 6.1 (including the
  half-pixel `y`); the adapter offset of section 8.1 on a trimmed asymmetric frame, mirrored, for
  `Sprite2D`, `Sprite3D` and the duck-typed adapter on a fake node with the billboard's properties.
- **D1:** the game's own test runner passes; a capture next to the current art. Expected differences: the
  half-pixel horizontal shift (section 5), prop heights half a pixel lower (section 6.2), and frame
  boundaries within 0.5 ms of the game's `hold / fps` timing (S5). Anything else goes to KNOWN_ISSUES.
