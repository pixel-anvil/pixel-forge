# MCP dogfood evaluation, M1a

Card T5.8. `claude -p` on Sonnet drove `pf mcp` through W3-manual on two characters: the synthetic hero (`fixtures/generated/hero.pxf`) and the CC0 Hero Swordsman (`fixtures/cc0/hero_swordsman/`, by tbbk, CC0 1.0).

## Result

**W3 passed on both characters on the final descriptions: the hero in r7, the CC0 character in r6.** One limit applies:

- On the CC0 character the revisions improved the process, not the art. The final CC0 jump is rig-driven and honest, but it is no closer to the source sheet than the baseline, and frame 3's arms are poor. Each character has one finished run on each text, so the call and cost figures show direction only: two CC0 runs on nearly the same text differ by a factor of 2.5 in cost.

On the hero the revisions did improve the result: the baseline lost the support foot in 2 of 6 frames, and both revised runs keep every foot on the canvas.

The most useful finding: **W3's conditions cannot tell a rig animation from pasted art.** Run r5 passed all of them with almost half of two frames pasted from the sheet, and it had the best-looking contact sheet of all the runs. This evaluation added a check for it (see "Pass check").

## Runs

Each run used its own folder, copies of the fixture, a config with `--strict-mcp-config`, `--allowedTools` limited to the `pf` tools and Read, and no `--dangerously-skip-permissions`. The model is `sonnet`.

| Run | Character | Descriptions | Outcome | Counts against the budget |
|---|---|---|---|---|
| r1 | hero | baseline | W3 pass | yes |
| r2 | CC0 | baseline | W3 pass | yes |
| r3 | hero | revision 1 | W3 pass | yes |
| r4 | CC0 | revision 1 | **cut off**: usage limit (HTTP 429) at call 29, nothing saved | no |
| r5 | CC0 | revision 1 | **failed**: not rig-driven | yes |
| r6 | CC0 | revision 2 | W3 pass | yes |
| r7 | hero | revision 2 | W3 pass | yes |

That is all 6 counted runs of the budget. r4 was cut off by the account limit, not by the model or the tools, and is used below only as partial evidence. Revision 2 is the final text. Before r7, `tools/list` from the built bundle was compared with `packages/ops/generated/mcp-tools.json` and the text r6 ran on: all 37 descriptions matched.

The prompts are plain user requests with no tool names. They were the same for every run of a character. The hero prompt carries the W3 text: "6-frame run cycle, side view, 12 fps, with anticipation". The CC0 prompt asks to import the jump frames from the sheet, cut one frame into parts, rig them as a side-view character, and re-animate the jump "driven by bones instead of drawn frames". Both ask for no lint problems and for a contact sheet to be looked at and fixed.

## Pass check

W3 (`docs/01-spec.md` section 2): the animation exists, lint is clean, every tool call is one undo step, and a contact sheet was rendered and inspected. These were checked after each run from the saved `.pxf` (with a fresh `pf`) and the trace, and each final contact sheet was opened and looked at by the evaluator.

**Added after r5:** rig-driven means overrides cover at most 5% of the opaque pixels on every frame. The check discards all overrides on a copy of the file, exports both, and compares them pixel by pixel. The limit was set before r6 ran. It is this evaluation's choice, not a spec rule. A file with no overrides passes at once.

| Check | r1 | r3 | r7 | r2 | r5 | r6 |
|---|---|---|---|---|---|---|
| Animation | `run/side`, 6 frames, 83 ms | `run/side`, 6 frames, 83 ms | `run/side`, 6 frames, 83 ms | `jump/side`, 4 frames, loop | `jump/side`, 4 frames, once | `jump_rig/side`, 4 frames, once |
| Lint findings (own run) | 0 | 0 | 0 | 0 | 0 | 0 |
| Ok edits / undo entries | 9 / 9 | 14 / 14 | 13 / 13 | 47 / 47 | 65 / 64 (a) | 42 / 42 |
| Contact sheets rendered | 2 | 3 | 3 | 6 | 9 | 7 |
| Overrides | 0 | 0 | 0 | 0 | **13** | 0 |
| Largest override share of a frame | 0% | 0% | 0% | 0% | **47%** | 0% |

(a) The one edit with no entry is a `pixels_write_grid` with `changed: 0`. A call that changes nothing adds no undo step, as designed. No entry is shared by two calls, and no failed call has an entry.

## Baseline against re-run

Tool calls include 2 Read calls on the CC0 runs. A retry is a call to the same tool right after that tool failed.

| Measure | Hero r1 | Hero r3 | Hero r7 | CC0 r2 | CC0 r5 | CC0 r6 |
|---|---|---|---|---|---|---|
| Tool calls | 17 | 24 | 23 | 84 | 134 | 77 |
| Failed calls by code | 0 | 0 | 0 | 1 `REFUSED` | 1 `REFUSED` | 1 `BAD_INPUT` |
| Retries | 0 | 0 | 0 | 0 | 0 | 1 |
| Largest text output, chars | 5,812 `rig_joint_check` | 4,205 `doc_summary` | 4,206 `doc_summary` | 5,425 `pixels_read_grid` | 4,761 `pixels_read_grid` | 4,282 `lint` |
| All text output, chars | 15,819 | 11,835 | 11,378 | 53,228 | 87,350 | 36,024 |
| Duration, min | 0.8 | 1.4 | 1.0 | 7.8 | 11.9 | 4.3 |
| Cost, USD | 0.31 | 0.39 | 0.22 | 1.50 | 2.45 | 0.97 |
| W3 | pass | pass | pass | pass | **fail** | pass |

The hero's extra calls in r3 and r7 are repair: the model found and fixed framing problems on its first sheet.

The largest image was a contact sheet in every run, at most about 44 KB of base64. Images were not a problem.

Friction counts on the CC0 runs:

| Friction | r2 | r5 | r6 |
|---|---|---|---|
| `rig_set_pose` calls | 27 | 11 | 11 |
| Calls with an explicit zero offset | 11 | 4 | 6 |
| Calls that key z | 5 | 4 | 0 |
| `rig_edit_bones` calls before the first correct rest angles | 3 | 1 | 1 |
| `anim_create` with `loop: "once"` | no | yes | yes |
| `rig_joint_check` calls | 3 | 1 | 0 |
| `lint` calls | 2 | 16 | 7 |
| `undo` calls | 0 | 6 | 12 |

The last two rows moved the wrong way. `lint` replaced `rig_joint_check`, as its new text suggests, and it became cheap enough to use in a trial-and-error loop. In r6 the undo chain includes 7 calls to go back and redo the cuts, because a part's art cannot be painted after it is cut (RIG-07).

**Distance from the source sheet** (pixels that differ on the 64x64 frame, the shipped render against the sheet cell):

| Frame | r2 | r5, shipped | r5, bones only | r6 |
|---|---|---|---|---|
| 0 | 3 | 7 | 7 | 51 |
| 1 | 505 | 533 | 533 | 551 |
| 2 | 626 | 174 | 634 | 617 |
| 3 | 447 | 108 | 512 | 561 |

A rig jump is not expected to equal the sheet, so these figures are for comparison only. r6 is further from the sheet than r2 on 3 of 4 frames. The model said frame 0 of r6 "matches the sheet"; it differs in 51 pixels, because it patched the flat art before cutting and its thigh fill covers most of the green shorts, which it reported separately.

## Look at the sheets

- **r1 (hero):** reads as a run. In frames 1 and 4 the support foot is cut off at the bottom of the canvas. Lint reported nothing, and the model did not mention it.
- **r3 (hero):** reads as a run, with a clear crouch on frame 0. All feet are on the canvas. Frame 5 is the weakest pose.
- **r7 (hero):** reads as a run, with a clear crouch on frame 0, and all feet are on the canvas. The model raised the head-clipping problem itself on its first sheet. The hair touches the top row in frames 2 and 4 but loses nothing: the top two rows hold 7 and 9 px, the same as the frames with headroom. In r1 the top hair row was lost in frames 2 and 5. Not reported by the model: in frames 2 and 4 the swinging foot lies against the planted leg as a vertical strip and reads poorly.
- **r2 (CC0):** frame 0 is clean. Frames 1 to 3 have 1 px speckle in the arms and thighs, and rotated limbs lose their outline. The model listed most of this.
- **r5 (CC0):** the shipped sheet looks closest to the art. With overrides removed, frames 2 and 3 are ragged, with detached outline pieces and no joined arms.
- **r6 (CC0):** frames 0 to 2 are usable. In frame 3 the arms are scrambled around the hands, with broken outline fragments near the head. Speckle remains. The model called this pose a rough silhouette.

## Friction

| # | Friction | Kind | Evidence | Outcome |
|---|---|---|---|---|
| 1 | Unkeyed channels do not return to rest. They interpolate from keys on other frames and wrap in a loop. The description did not say so. | unclear description | r2: an x offset keyed on frame 3 shifted frames 0 to 2; 11 of 27 pose calls then carried zero offsets | Revised. r5 and r6 key each frame in full, with 11 pose calls |
| 2 | Rest angle is relative to the parent, but the template's pelvis is -90, so a thigh pointing down is 180, not 90. | unclear description | r2 #11 set 90, #13 corrected to 180 | Revised, with a new first example. Right first time in r4, r5 and r6 |
| 3 | Art leaving the canvas is cut off with no finding. | missing check | r1 frames 1 and 4 | Revised: "check the tile edges". r3 and r7 both found framing problems on their first sheet and fixed them; r3 named lint's gap. LINT-01 |
| 4 | Lint and the joint check do not see 1 px holes in rotated parts, or poses beyond the sweep. | missing check | r2: 0 findings with speckle on 3 of 4 frames; 11 render and grid calls after posing began | Revised. LINT-02 |
| 5 | A clean rig check reports every joint and angle. | oversized output | r1: 5,812 chars with 0 gaps; r2: three calls were 20% of all text | Revised: points to `lint`. `rig_joint_check` calls fell to 1, then 0. MCP-05 |
| 6 | A part's default z cannot change after creation, and it was not said that part keys hold. | missing tool, unclear description | r2 #47 to #51: one call per frame | Revised. r6 planned z up front, with 0 z keys. RIG-07 |
| 7 | No tool paints a part's own art. | missing tool | r2 #52 refused (`part-layer`) and the seam fix dropped; r6 undid 7 calls to re-cut | RIG-07, card below |
| 8 | No tool shows a frame's keys. | missing tool | Friction 1; `doc_summary` shows no angles. `render_frame` with `bones` covers rest fitting | MCP-03, card below |
| 9 | Overrides can replace the rig with no report. | missing check, partly caused by revision 1 | r5: 45 to 47% of two frames; 17 grid writes for 7 distinct grids, re-pasted after each re-pose | Revised in revision 2; r6 used none. MCP-07 |
| 10 | Nudging pivots to clear gaps moves the art. | unclear description | r5 #55 to #60, then 4 undos; 9 `rig_set_pivot` calls | Revised. r6: 1 call |
| 11 | A second cut into one part is refused (`duplicate-variant`). | unclear description | r5 #24, then undo and re-cut | Revised. r6 hit no refusal |
| 12 | `part_paint_overlap`'s default colour can be the outline. | unclear description | r6 #48: black patches, then undo and repaint with `color` | Found on the last run, so not revised. RIG-08 |
| 13 | Bare `undo` was called once without the client's prefix. | round trip | r4 #15: `No such tool available`. Not in the trace | MCP-06 |
| 14 | Every pose is one call, one frame. | round trips | 11 to 27 pose calls per run | By design (one call, one undo step). Card below |
| 15 | The template's proportions need a full refit for chibi art. | round trips | 31 to 42 bone edits per CC0 run | Revised to say so. Card below |

**Absolute paths (the T5.7 question): no cost.** Prompts said "this folder", and the model used absolute paths in every finished run. There was no path `BAD_INPUT`. r6's one `BAD_INPUT` was a malformed grid (rows of unequal length), which cost one retry.

**SCN-01, RIG-06:** not reached. The runs use sheets and `.pxf`, not `.aseprite`, and they cut parts with `part_split`. **SCN-03:** r5 hit its shape: an overlap patch covered the strap until the child was drawn below its parent. **MCP-04:** the 800-character cap and the 80,000-byte `tools/list` test both bound; the revisions were paid for by shorter shared phrases.

## Revisions

There were two rounds. Revision 1 came from r1 and r2. Revision 2 came from r5 and changed 4 descriptions: `pixels_write_grid`, `rig_set_pivot`, `part_split`, `rig_set_pose`. Round 2 corrects a mistake of round 1: telling the model how to reach pixels on a rig, with no limit on when, is the likely cause of r5 (one sample each way, so likely, not proven).

Rules, each produced by the evidence:

- **R1 Names:** name other tools by the name a client calls. r2 #35 followed `part_split`'s "(rig_set_pose)" directly, while op-style names such as `rig.setPose` and `lint.run` cannot be called.
- **R2 Returns:** say what a result holds or leaves out. In r2 the model followed each `rig_edit_bones` with a `render_frame`, because the call returns no geometry.
- **R3 Next step:** end with the next check. r1 ran `rig_joint_check` right after posing because `rig_set_pose` said so.
- **R4 Limits:** say what a check does not catch (friction 3, 4).
- **R5 Reach:** say how far an effect goes, across frames and animations (friction 1, 6, 9).
- **R6 Budget:** shorten shared phrases to pay for the additions. Applied to every tool: the conventions line, the safety notes and the `doc` field text. `tools/list` went from 79,873 to 79,871 bytes.

"Called" says whether a finished run used the tool. Where it says no, the revision comes from a rule alone, with no evidence of that tool's own.

| Tool | Called | What changed | Evidence or rule |
|---|---|---|---|
| `anim_create` | yes | Use `loop: "once"` for a one-shot; keys wrap in a loop | r2 #37, then friction 1; R5 |
| `anim_update` | no | Loop mode changes interpolation at the ends | Rule R5 |
| `cel_link` | no | Pixel layers only: part layers have no cels | Rule R4 |
| `doc_create` | yes | Canvas at the cell size for a sheet; nothing on disk until `doc_save` | r2 #2, #83; R3 |
| `doc_open` | yes | Returns the id only; `doc_summary` next | r1 #0, #1; R2, R3 |
| `redo` | no | Safety note no longer claims an undo step; tool names | Rule R1, and the note was wrong |
| `doc_save` | yes | Doc alone saves in place; a new document needs a path | r1 #16, r2 #83; R2 |
| `doc_set_color_mode` | no | Run `lint` next | Rule R3 |
| `doc_summary` | yes | Shows no angles or keys; use `render_frame` with `bones` | r1 #3, r2 #7; R2 |
| `undo` | yes (r5, r6) | Safety note no longer claims an undo step; tool names | Rule R1, and the note was wrong |
| `frame_add` | no | Tool names, not op names | Rule R1 |
| `frame_delete` | no | Later frames move down one index | Rule R2 |
| `frame_duplicate` | no | The copy starts from the same pose; change it with `rig_set_pose` | Rule R3 |
| `frame_set_meta` | no | Changes this one frame only | Rule R5 |
| `export` | no | Use `render_contact_sheet` to look; base for `override_import` | Rule R3 |
| `import_file` | yes | Keep the sheet as a reference; apply the template before `.aseprite` | r2 #15, SCN-01; R3 |
| `layer_update` | no | Tool names; hide a part per frame with `rig_set_pose` | Rules R1, R5 |
| `lint` | yes | Count 0 is not a visual pass; what it does not see | r1 frames 1, 4; r2 sheet; R4 |
| `override_import` | no | `newlyStale` and what to do with it | Rule R2 |
| `override_list` | yes (r5) | Removes a repeated line; next step kept | Rule R6 |
| `override_resolve` | yes (r5) | Check the frame after a discard | Rule R3 |
| `part_paint_overlap` | yes | Summary states the SCN-03 condition; flat colour shows at big bends | SCN-03, r2 sheet; R4 |
| `part_split` | yes | Fit bones first; parts draw in every animation; `duplicate-variant`; z set once | r2 #16 to #27, r5 #24; R5 |
| `pixels_read_grid` | yes | Size of the output; tool names | r2 #5 (5,425 chars); R1, R2 |
| `pixels_write_grid` | yes | Overrides are for touch-ups; say what the rig cannot show; a part layer is refused | r2 #52, r5; R4 |
| `pxf_pack` | no | Works on files, not open documents | Rule R5, CLI-07 |
| `pxf_unpack` | no | Works on the file: `doc_save` first | Rule R5, CLI-07 |
| `render_contact_sheet` | yes | Check the tile edges; art past the canvas is cut off | r1 frames 1, 4, then r3 #18; R4 |
| `render_frame` | yes | `output.bones` is how to read a posed skeleton | r1 #3, r2 #7; R2 |
| `rig_apply_template` | yes | States rest angles; proportions are generic; refit before cutting | r2 #9 to #14; R2, R3 |
| `rig_bake` | no | Tightened wording | Rule R6 |
| `rig_bind_parts` | no | Fit bones first; z set once | r2 evidence from `part_split`, applied by rule R5 |
| `rig_edit_bones` | yes | Rest rule with a worked thigh; new first example; returns no geometry | r2 #11, #13; R2 |
| `rig_joint_check` | yes | Long output, use `lint` for pass or fail; sweep limit | r1 #10, r2 #29; R4 |
| `rig_mirror_animation` | no | Pose the source, not the mirror | Rule R5 |
| `rig_set_pivot` | yes (r5, r6) | Do not nudge to clear gaps; binding already places it | r5 #55 to #60; R4 |
| `rig_set_pose` | yes | Interpolation and wrap; part keys hold both ways; canvas clipping | r2 #61, #68 to #71, #47 to #51; R5 |

Field text also changed for `zByBone` on `part_split` and `rig_bind_parts`, `z` on `rig_set_pose`, and rest `x`, `y`, `angle` on `rig_edit_bones`. No op, input or output changed.

## Proposed cards

For the orchestrator to add to the plan. IDs are the next free ones.

| ID | Title | Why | Evidence | Model / size |
|---|---|---|---|---|
| T5.10 | `rig.readPose` read op, moved up from M1b | A client cannot see a frame's keys, so it zeroes them blind | MCP-03; r2: 11 of 27 pose calls | sonnet / S |
| T5.11 | `lint` rule for overrides that replace the rig | W3 passes on pasted art, and no tool reports it | MCP-07; r5: 47% of a frame | sonnet / S |
| T5.12 | `lint` rules for canvas clipping and holes in rotated parts | Clean lint with a missing foot and visible speckle | LINT-01, LINT-02; r1, r2 | sonnet / M |
| T5.13 | Set a part's default z after creation | One call per frame today | RIG-07; r2 #47 to #51 | sonnet / S |
| T5.14 | Paint a part variant's own art | Fixing a cut means undoing back past it | RIG-07; r2 #52, r6's 7-undo chain | sonnet / M |
| T5.15 | Compact `rig.jointCheck` output (additive) | 5.8 KB for a clean rig | MCP-05; r1 #10 | haiku / S |
| T5.16 | Fit a template to art from landmarks | 31 to 42 bone edits per flat character | r2, r5, r6 `rig_edit_bones` | sonnet / M |
| T5.17 | Pose several frames in one call (one undo step) | 11 to 27 pose calls per run | All runs | sonnet / S |

T5.11 should come before T6.4: its rig rebuild is the same work, and its touch-ups use the same override path.

## Limits of this evaluation

- One finished run per character on each text. Model runs vary widely.
- The 5% limit and the sheet distances are this evaluation's measures. They are not in the spec.
- Descriptions were tuned on these two characters and these two prompts, and the re-runs reuse them, so the results may not carry over to new art.
- Traces and run folders stayed outside the repo. Only the excerpts above are kept.
