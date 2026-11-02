# Plan: M1b "Breadth"

Written at gate G2 (rolling wave, `docs/02-plan.md` §4). The execution rules are the same as in M1a: `docs/02-plan.md` §0 and `docs/ai/ORCHESTRATOR.md`. Only extras are listed here.

**Exit scenarios:** W1 (image to sprite), W3-presets, W7 (palette discipline and skins).

## What M1a taught us

- **Model cost.** Per card: Haiku/low 72k tokens, Sonnet/medium 175k, Haiku/medium 181k, Sonnet/high 226k, Opus 280k to 320k. No card escalated a model.
- **Haiku at medium effort saves nothing** against Sonnet/medium, so M1b uses Haiku only at low effort, for cards with an independent oracle.
- **Gate reviews keep finding bugs in code that passed its card.** G1 found 10 and G2 found 10. Keep a gate review, and add one in the middle of M1b (G2b).
- **The tools came before the art quality.** T5.8 and T6.4 showed that the final move needed a local pose search and hand work. Wave B0 fixes that first, because every later dogfood run uses these tools.

## Waves

```
B0  T5.10 → T5.17 ∥ T5.13 ∥ T5.15 → T5.14 ∥ T5.12 → T5.16 ∥ B0.1 → B0.2
B1  E1.1 → E1.2 ∥ E2.1 → E2.2 ∥ E7.1 → E3.1 → E3.2 → E3.3 → G2b
B2  E5.1 ∥ E5.2 → E5.3 ∥ E5.4 → E5.5
B3  E4.0 → E4.1 → E4.2 ∥ E4.3 → E4.4 → E4.5
B4  E6.1 → E6.2 ∥ E8.1 → E8.2
B5  E9.1 ∥ E9.2 → E9.3 → E9.4 → G3
```

Limits stay the same: two agents at a time, at most one on Opus.

## Task board

| Card | Title | Model | Effort | Size | Deps | ☐/☑ |
|---|---|---|---|---|---|---|
| T5.10 | `rig.readPose` read op (MCP-03) | sonnet | medium | S | — | ☐ |
| T5.17 | Pose several frames in one call, one undo step | sonnet | medium | S | T5.10 | ☐ |
| T5.13 | Set a part's default z after creation (RIG-07) | sonnet | medium | S | — | ☑ |
| T5.15 | Compact `rig.jointCheck` output, additive (MCP-05) | haiku | low | S | — | ☐ |
| T5.14 | Paint a part variant's own art (RIG-07) | sonnet | medium | M | T5.13 | ☐ |
| T5.12 | `lint` rules for canvas clipping and holes in rotated parts (LINT-01, LINT-02) | sonnet | medium | M | — | ☐ |
| T5.16 | Fit a template to art from landmarks | sonnet | medium | M | T5.17 | ☐ |
| B0.1 | `rig.fitPose`: search poses against a target image | sonnet | high | M | T5.17 | ☐ |
| B0.2 | Fill colour of `part_paint_overlap` (RIG-08) and tool names in descriptions (MCP-06) | sonnet | medium | S | T5.14 | ☐ |
| E1.1 | IK solvers: analytic two-bone and FABRIK, bake to FK | opus | high | M | — | ☐ |
| E1.2 | End-effector targets in `rig_set_pose`, `rig_ik_target` | sonnet | medium | S | E1.1, T5.17 | ☐ |
| E2.1 | Variant auto-select with hysteresis | sonnet | high | M | — | ☐ |
| E2.2 | Lint rule for a large variant residual | sonnet | medium | S | E2.1 | ☐ |
| E7.1 | Quadruped template | haiku | low | S | — | ☐ |
| E3.1 | Motion preset generator API + walk | opus | high | M | E1.1 | ☐ |
| E3.2 | Presets: idle-breathe, run, jump, swing | sonnet | medium | M | E3.1 | ☐ |
| E3.3 | `rig_apply_preset` + W3-presets scenario | sonnet | medium | S | E3.2 | ☐ |
| G2b | **Mid review:** `code-review` over B0 and B1, MCP smoke run | opus | high | — | B0, B1 | ☐ |
| E5.1 | Palette files: `.hex`, `.gpl`, `.pal`, PNG strip | haiku | low | S | — | ☐ |
| E5.2 | Ramp generator, palette editing and sorting ops | sonnet | medium | M | — | ☐ |
| E5.3 | Palette generation: k-means++ in OKLab, median cut | sonnet | high | M | E5.2 | ☐ |
| E5.4 | Palette remap and swap with a mapping table | sonnet | medium | S | E5.2 | ☐ |
| E5.5 | Skins at export + W7 scenario | sonnet | high | M | E5.4 | ☐ |
| E4.0 | ADR: how images enter the converter (orchestrator) | opus | high | — | — | ☐ |
| E4.1 | Image input, crop, background removal | sonnet | medium | M | E4.0 | ☐ |
| E4.2 | Pixel grid detection, k-centroid and the other downscales | opus | high | M | E4.1 | ☐ |
| E4.3 | Quantise in OKLab, dithering | sonnet | medium | M | E4.1, E5.3 | ☐ |
| E4.4 | Clean-up, `ConvertRecipe`, variant grid | sonnet | high | M | E4.2, E4.3 | ☐ |
| E4.5 | `image_to_sprite`, `convert_apply` + W1 scenario | sonnet | medium | S | E4.4 | ☐ |
| E6.1 | GIF decoder | sonnet | high | M | — | ☐ |
| E6.2 | GIF encoder | sonnet | medium | S | E6.1 | ☐ |
| E8.1 | Godot `SpriteFrames` per direction | sonnet | medium | S | — | ☐ |
| E8.2 | `PixelForgeSprite2D` and `PixelForgeSprite3D` | sonnet | medium | S | E8.1 | ☐ |
| E9.1 | `draw_shapes`, `selection_transform`, `shade_with_ramp` | sonnet | medium | M | E5.2 | ☐ |
| E9.2 | The rest of the §8 tools (audit first) | sonnet | medium | M | E5.5, E4.5 | ☐ |
| E9.3 | MCP prompts (FR-AI-16) | sonnet | medium | S | E9.2 | ☐ |
| E9.4 | Second MCP dogfood | opus | high | M | E9.3 | ☐ |
| G3 | **Gate: M1b exit** + v0.2.0 + M2 breakdown | opus | high | — | all | ☐ |

**Not scheduled:** T5.11 (a lint rule for overrides that replace the rig). The user chose on 2026-11-01 to keep it unscheduled.

**Mix:** 35 agent cards. Opus 4, Sonnet/high 6, Sonnet/medium 22, Haiku/low 3. At M1a's averages that is about 6.6M tokens for the cards, before gates, reviews and fix passes.

## Task cards

Every card: standard context pack, definition of done and oracles (`docs/02-plan.md` §0.3, §0.4, §0.6).

### Wave B0: tool quality

- **T5.10 `rig.readPose`.** Read one frame's bone and part keys, and say which are real keys and which are interpolated. **Acceptance:** an MCP client can read a frame and write it back with no change to the render.
- **T5.17 Multi-frame pose.** `rig_set_pose` takes several frames in one call, as one undo step. Additive to the input schema. **Trap from T6.4:** keys on some bones only make the others interpolate. The op must state which bones it keys, and offer "key every bone". **Acceptance:** 12 frames posed in one call, one undo restores all of them.
- **T5.13 Part default z.** An op that changes a part's default z after creation. **Acceptance:** one call replaces the per-frame z keys, and `rig.jointCheck` and `part.paintOverlap` see the new order.
- **T5.15 Compact jointCheck.** A summary form as an option. The full form stays the default until G3. **Acceptance:** under 500 bytes on the clean 15-joint hero.
- **T5.14 Paint a variant.** Write pixels into a part variant's own image. This must mark overrides stale by the existing hash rule and change the part render version only as the contract says. **Acceptance:** fixing a cut needs no undo chain, and one call is one undo step.
- **T5.12 Lint rules.** LINT-01: art cut off at the canvas edge. LINT-02: 1 px holes inside rotated parts. **Oracle:** the T5.8 frames with the missing foot and the speckle, rebuilt as synthetic fixtures with hand-written expectations. **Acceptance:** both are found, and all W-scenarios stay clean (no false findings).
- **T5.16 Fit a template.** Given landmark points (head top, hips, feet, hands), fit bone lengths and rest pose in one call. **Acceptance:** 31 to 42 bone edits (T5.8) drop to 1 call plus at most 5 edits on the CC0 character.
- **B0.1 `rig.fitPose`.** Search bone angles, and only bones and variants, so that the render matches a target image. T6.4 did this with a local script over the real renderer. Write it fresh for the public repo, with a seeded and deterministic search. No game names and no game art: tests use the CC0 character and synthetic art. **Acceptance:** on a synthetic rig posed by a known pose, the search reaches an exact match in a bounded number of renders, and the same seed gives the same result on macOS and Linux.
- **B0.2 Small fixes.** RIG-08: the fill colour must not be the outline colour on small parts. MCP-06: descriptions must say that clients prefix tool names. Note that description length is limited by a test (MCP-04).

### Wave B1: rig

- **E1.1 IK.** Pure functions in `rig`: analytic two-bone and FABRIK. Solve in the fixed-point maths of ADR-010, and bake to FK angles at the angle quantum (FR-RIG-13). Name the paper or reference in TSDoc. **Oracle:** properties (the end effector reaches a reachable target within 1 px, unreachable targets stretch toward it, bone lengths never change), plus hash tests in the determinism suite. **Review:** `code-review` high on the staged diff.
- **E1.2 End-effector targets.** FR-AI-17, additive to `rig_set_pose`. **Acceptance:** `hand_r → (24,30)` lands within 1 px, and the key stored is plain FK.
- **E2.1 Variant auto-select.** FR-RIG-14: nearest `drawnAngle`, residual rotation only, hysteresis, an explicit key wins. The schema already has `AUTO_VARIANT` and the hysteresis default. Hysteresis depends on the previous frame, so the result must be defined from the start of the animation and never from playback order. Update the render cache key if the render inputs change. **Oracle:** hand-written tables of angles and expected variants.
- **E2.2 Residual lint.** A warning above `maxResidualDeg`.
- **E7.1 Quadruped template.** Data only, same form as the humanoid template. **Oracle:** the existing template tests, parameterised.
- **E3.1 Preset API + walk.** A generator from parameters to bone keys that works on any skeleton with the template bone names. **Oracle:** properties (the loop closes, the support foot does not slide beyond 1 px, phases match). **Review:** `code-review` high. A contact sheet goes to the user.
- **E3.2 Other presets.** idle-breathe, run, jump (anticipation, rise, apex, fall, land), swing. Each gets a contact sheet.
- **E3.3 `rig_apply_preset`.** One call, one undo step. **Acceptance:** W3-presets runs in `pnpm scenarios`.
- **G2b Mid review.** `code-review` high over B0 and B1. Run an MCP smoke test: a Sonnet client animates the CC0 character with presets. Fix before B2.

### Wave B2: palette and skins

- **E5.1 Palette files.** Parsers and writers in `io`. **Oracle:** sample files written by hand from the format docs, and Aseprite reading the written files.
- **E5.2 Ramps and palette ops.** FR-PAL-03: editing, sorting, ramp generator with hue shift (shadows cool, lights warm).
- **E5.3 Palette generation.** FR-PAL-04: seeded, N from 2 to 256, integer or fixed-point where hashes depend on it. **Oracle:** seed stability on macOS and Linux, and hand-made images with a known answer.
- **E5.4 Remap.** FR-PAL-05.
- **E5.5 Skins.** FR-PAL-07. The schema and the Godot importer already know skins, so start by listing what is missing. **Acceptance:** W7 in `pnpm scenarios`, and a GUT test shows one atlas per skin.

### Wave B3: converter

- **E4.0 ADR.** Decide how JPEG and WebP enter the system before any code. `convert` is a pure package, so decoding belongs in `io`. Dependencies must be permissive (NFR-11), and decoded pixels must not differ between platforms (NFR-02). If a decoder cannot give that, the hash suite must start from a decoded PNG. The user approves any new dependency.
- **E4.1 Input and background.** FR-CONV-01, FR-CONV-02.
- **E4.2 Grid detection and downscale.** FR-CONV-03, FR-CONV-04. Clean-room code from papers only. **Oracle:** synthetic upscaled art with a known cell size and phase. **Review:** `code-review` high.
- **E4.3 Quantise and dither.** FR-CONV-05, FR-CONV-06. Dither matrices come from published sources, named in TSDoc.
- **E4.4 Pipeline.** FR-CONV-07, FR-CONV-08, FR-CONV-09. Every step is pure and golden-tested. Goldens need a reviewed sheet.
- **E4.5 Ops and W1.** The W1 fixture `fixtures/photo_ball.jpg` must be CC0 or made by us, with its licence file. **Acceptance:** W1 in `pnpm scenarios`.

### Wave B4: GIF and Godot nodes

- **E6.1 GIF decoder.** FR-DOC-05. **Oracle:** GIFs written by Aseprite and other tools; hostile files must be refused with a bounded output (see the G2 finding on PNG inflate).
- **E6.2 GIF encoder.** FR-DOC-06. **Oracle:** read back with Aseprite and macOS `sips`.
- **E8.1 SpriteFrames.** FR-GD-06. **Oracle:** GUT in Godot 4.6.1.
- **E8.2 Sprite nodes.** FR-GD-06: billboard, nearest filter, alpha scissor, wrapping the driver.

### Wave B5: MCP

- **E9.1 Drawing tools.** `draw_shapes`, `selection_transform`, `shade_with_ramp`.
- **E9.2 The rest of §8.** Audit the §8 table against `packages/ops` first. `layer_update`, `rig_set_pivot` and `rig_bake` exist already, and others have changed names. Keep the tool count near 40.
- **E9.3 Prompts.** FR-AI-16.
- **E9.4 Second dogfood.** Same method as T5.8. It adds an art-quality check, because the T5.8 revisions improved the process and not the art. Measure the T5.8 numbers again (pose calls, bone edits, overrides).
- **G3 Gate.** `code-review` over M1b, all W-scenarios, bench and determinism, docs, v0.2.0, M2 cards, user sign-off.
