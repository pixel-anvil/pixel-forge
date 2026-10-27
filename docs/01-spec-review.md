# Spec review — v0.1 → v0.2

Reviewer: an independent architecture reviewer agent (Opus-class), 2026-10-26. No files were edited during the review.
I checked the claims that mattered against the code. For example, R-03 is confirmed: the game's lit billboard node has
`texture`, `region_rect`, `flip_h`, `offset` and `pixel_size`, and the game's character-art record has a feet-row field (GAME_NOTES §4, local).

| ID | Sev | Finding (short) | Disposition → where in v0.2 |
|---|---|---|---|
| R-01 | Blocker | Multi-view characters can't be modelled (one rig, one direction per animation, `render/<anim>` collides) | **Accepted.** `Animation.group + direction`, unique together. `Rig.views[]` (per-view rest pose and variant set). Direction fallback map. → §3, §7 |
| R-02 | Blocker | Overrides are canvas-space and frame-index keyed. The outline post-pass re-outlines over them. `baseHash` scope undefined | **Accepted.** Overrides are part-relative (following the snapped pivot) or "final". bbox±1 hash. A fixed render order. Stable frame IDs. → FR-RIG-22, §6.7 |
| R-03 | Blocker | Godot output doesn't fit the game's lit billboard node. Two clocks. No origin | **Accepted.** The primary output is engine-neutral: atlas + frame table + `origin`. `PixelForgeDriver.apply(texture, region, offset, flip_h)`. One clock. SpriteFrames becomes optional (M1b). → FR-GD |
| R-04 | Blocker | Several processes can own one `.pxf`. Godot could read half-written zips. `.pxfd/` and the journal sit inside `res://` | **Accepted.** Lockfile + `~/.pixel-forge/server.json` discovery + forwarding. Atomic save. `.gdignore`. Journal in the app cache. → §6.5, §7 |
| R-05 | Major | Package dependency order contradicts itself | **Accepted.** An explicit graph with `schema` at the bottom. `harness` folded into `cli`. → §6.2 |
| R-06 | Major | Per-part independent snapping → joint jitter. No pivot convention. No hysteresis on variant selection | **Accepted.** Hierarchical snapping, pivot = pixel centre, hysteresis, an explicit key beats auto. → FR-RIG-14/20 |
| R-07 | Major | Mirroring contradicts itself (baked `side_mirror` vs `flip_h`). Marker mirroring undefined | **Accepted.** `side_mirror` is a derived view (`mirrorOf`), mirrored at runtime including markers. Markers keep anatomical names. → FR-RIG-16, FR-GD-03 |
| R-08 | Major | No stable frame identity. No tags in the model. Aseprite mapping undefined | **Accepted.** `frameId`, defined insert/delete/duplicate behaviour, explicit tag → animation mapping, layer naming convention for parts. → §3, FR-DOC-04 |
| R-09 | Major | M1 has no human touch-up path | **Accepted.** `pf override import` (diff an edited PNG into overrides). In-place re-import of parts by layer name. → FR-RIG-24, FR-DOC-04 |
| R-10 | Major | First real art is a flat bought pack, but there's no split-to-parts workflow | **Accepted.** New FR-RIG-07 "split to parts" + overlap-painting helper + joint check. → FR-RIG-07 |
| R-11 | Major | Proposals and the 3-way merge are over-engineered. Unclear whether MCP edits are proposals | **Accepted.** MCP edits apply directly (one undo step each). A proposal is a forked doc that's replayed on accept. Snapshot-on-connect sync. **AI panel moved to M3.** → FR-AI-14/22, §6.5, §10 |
| R-12 | Major | Byte-identical determinism can't be verified (codecs, `Math.sin`, `modified` timestamp) | **Accepted.** Determinism = hash of decoded RGBA. Pinned pure-JS deflate (fflate). Fixed-point trig table. A no-op save leaves `modified` alone. → NFR-02/03 |
| R-13 | Major | Palette lock has holes (opacity). Team kits need palette variants | **Accepted.** Lint runs on render output. Opacity warning. `skins[]` baked per skin (M1b). Index texture + LUT export (M3). → FR-PAL-07, FR-GD-08 |
| R-14 | Major | The text grid can't cover 256 indices and has no "keep" symbol | **Accepted.** Per-call legend (≤62 symbols), `_` = keep, `.` = transparent, writes capped at 32×32, rulers. → FR-AI-13 |
| R-15 | Major | Bone and part properties are conflated in pose keys | **Accepted.** Bone keys `{angle, offset, flipX}`. Part keys `{variant\|'auto', z, visible}`. `variants[0]` is the default. → §3 |
| R-16 | Minor | Acceptance criteria aren't testable | **Accepted.** Fixture-based criteria. W6 feature list. → §2 |
| R-17 | Minor | MCP images need limits. Vision vs lint roles. Point targets for poses | **Accepted.** Long edge ≤1568 px, labels and overlays. Lint owns precision. `rig_set_pose` accepts end-effector targets (via IK, M1b). → FR-AI-12 |
| R-18 | Minor | Electron rationale is weak | **Accepted.** `pf serve --open` is the default. A desktop shell is optional and decided in M3. → §6.6 |
| R-19 | Minor | No layer export flag. Cache invalidation coarse. Names used in paths unsanitised | **Accepted.** → §3, §7 |
| R-20 | Minor | The NFR worst case is 19 GB dense | **Accepted.** Sparse tiles. The undo cap counts tile bytes. → NFR-01 |
| R-21 | Minor | You can't estimate cost before an agent loop | **Accepted.** Per-request input tokens + running total against a budget. → FR-AI-23 |
| — | — | M1 is too big; split it | **Accepted.** M1a "rig to game", M1b "breadth". → §10 |

Reviewer's "keep" list (unchanged in v0.2): headless core and a single op registry, RotSprite + variants + overrides, quantised
poses with IK baked to FK, Godot reading only baked output, generic markers and events, ConvertRecipe, golden tests, `pf check`, additive contracts, ports and fakes.

Open decision for the user created by this review: **the AI panel moves to M3** (Claude Code via MCP covers M1–M2).
