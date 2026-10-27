# Joint coverage check (FR-RIG-05)

**Status:** defined by T3.0. Implemented by T3.4 (`rig`: `jointGaps`, `jointCheck`). Consumed by T3.5
(`rig.overlapMask`, section 7), T4.1 (lint rule `rig.jointGap`) and the `rig_joint_check` MCP tool.
**Oracle:** the hand-written fixtures in [`fixtures/joint/`](../../fixtures/joint/README.md). T3.4's result
must equal every `*.expected.json` exactly (deep equality, including order).

## 1. Summary

For each joint the child bone sweeps from −R to +R in steps of S while the parent stays at rest. At each
angle θ a pixel `q` is a **gap pixel** when all five conditions hold:

1. **near:** `q` is in the window, Chebyshev distance ≤ r from the joint pivot;
2. **open:** `q` is transparent in the composite at θ (neither parent nor child covers it);
3. **was covered:** `q` is opaque in the rest composite;
4. **outer side:** `q` is strictly on the outer side of the bend (the side the child swings away from);
5. **pinched:** along a row, a column or one of the two diagonals through `q`, the pixels on either side are
   pixels that were covered at rest and are now uncovered. One side ends at a parent pixel and the other
   side ends at a child pixel.

Everything is integer maths on alpha masks. Colours, z order and rotation quality do not matter. Section 4 has
the exact definitions; section 5 has the algorithm.

## 2. Conventions

- Canvas coordinates: origin top-left, x right, y down, integer pixels. A pixel `(x, y)` stands for its centre.
  The difference of two pixels is an integer vector, so all geometry below is exact.
- Angles are in degrees, 0° along +x, growing **clockwise** on screen (spec §3.4 clarification 7). θ is the
  child's `BoneKey.angle`, which is **relative to its rest angle**.
- **Opaque** means alpha > 0. **Transparent** means alpha = 0. A pixel outside an image is transparent.
- **Q16 trig:** `[C, S] = trigQ16(deg)` = `(round(cos·65536), round(sin·65536))`. Use the committed integer table
  from T1.6 (`raster`). Until T1.6 lands, the reference is `trigQ16` in `spikes/rotsprite/reference/rot.mjs`. It is
  exact at 0/90/180/270: `0° → (65536, 0)`, `90° → (0, 65536)`, `180° → (−65536, 0)`, `270° → (0, −65536)`.
- `rnd(n, 65536)` = n/65536 rounded half away from zero (`rnd` in the same reference file). Only section 7 uses it.

## 3. Inputs

### 3.1 Core predicate: `jointGaps` (what the fixtures test)

```ts
type Px = readonly [x: number, y: number];
interface JointGapInput {
  parent: RgbaImage;        // the parent's part(s) at rest, canvas space
  childRest: RgbaImage;     // the child's part(s) at θ = 0, canvas space
  frames: readonly { angle: number; child: RgbaImage }[]; // the child at each checked θ ≠ 0, canvas space
  pivot: Px;                // P: the joint pivot = the child bone's snapped pivot at rest, canvas pixel
  childDir: number;         // a0: the child bone's rest WORLD angle in degrees
  radius: number;           // r: integer ≥ 1
}
function jointGaps(input: JointGapInput): JointGapResult; // section 6.1
```

- `RgbaImage` is the RGBA8 `{ width, height, data }` shape used by `raster` and `testkit`. All images have the
  same size: they are layers of one canvas.
- **Rotation is not part of the predicate.** The caller supplies the child already rotated and placed. So the
  definition does not depend on the rotation algorithm, and the fixtures can be checked by hand: each fixture
  gives the rotated child frames directly.
- Errors (typed `JointCheckError` with `code`): `SIZE_MISMATCH` (images differ in size); `BAD_ANGLE` (an angle
  that is 0, not finite, or duplicated); `BAD_RADIUS` (not an integer, or < 1); `BAD_PIVOT` (a non-integer
  coordinate). The pivot may lie anywhere, even off the canvas.
- `frames` may come in any order. The output is sorted by angle.

### 3.2 Rig-level check: `jointCheck` (builds the inputs, then calls `jointGaps`)

T3.4 chooses the exact parameter types, matching what `renderParts` (T3.3) takes. The semantics are fixed here:

- **Joints:** every bone B that has a parent bone A, where both A and B have at least one part visible in the
  view. Bones without visible parts are skipped. Their children are not re-attached to a farther ancestor.
- **Parent image:** the union of the visible parts bound to A, rendered at rest (no keys).
- **Child images:** the union of the visible parts bound to B, rendered with only B's bone key set to θ (relative
  to rest). Everything else stays at rest. Use FR-RIG-20 steps 1–3: snapping, the rest variant of the view, the
  part's own rotation algorithm (RotSprite by default, FR-RIG-21), and pivot alignment. Leave out overrides,
  post-passes, skins, pixel layers and every other bone's parts, including B's own children. Rotating B never
  moves B's pivot, so P is the same at every θ.
- `childDir` = B's rest world angle in the view (from `evaluatePose` at rest, T3.1). `pivot` = B's snapped rest pivot.
- **Sweep:** `rangeDeg` R (default `JOINT_SWEEP_DEG_DEFAULT` = 30) and `stepDeg` S (default
  `JOINT_STEP_DEG_DEFAULT` = 5), both from `schema`. The angles are θ = k·S for every integer k ≠ 0 with
  |k·S| ≤ R, in ascending order. The defaults give −30, −25, …, −5, 5, …, 30 (12 angles). R and S must be > 0.
- **Radius:** `radius` r defaults to `JOINT_RADIUS_DEFAULT = 4`, a new `rig` constant. That covers limbs up to
  about 8 px wide. Pass a larger r for wider limbs (see section 8).
- **Canvas:** the document canvas. Content clipped by the canvas edge is transparent.

## 4. Definitions

Let `P = (px, py)` be the pivot and `q = (x, y)` a canvas pixel. Let `d = (dx, dy) = (x − px, y − py)`.

- **parent(q):** `parent` is opaque at q. **child_θ(q):** the frame for θ is opaque at q. **child_0(q):** `childRest` is opaque at q.
- **Composite at θ:** `comp_θ(q) = parent(q) ∨ child_θ(q)`. This is a union of masks, so draw order does not matter.
- **Rest composite:** `rest(q) = parent(q) ∨ child_0(q)`.
- **Window:** `win(q) ⇔ max(|dx|, |dy|) ≤ r`. This uses Chebyshev distance and is inclusive. Only pixels inside the
  canvas are candidates. Pixels outside the canvas are transparent at rest, so they fail condition 3 anyway.
- **Outer side.** Let `[C0, S0] = trigQ16(childDir)`. Let `s(q) = dy·C0 − dx·S0`, an integer. Geometrically, s is
  65536 × the signed distance of q's centre from the line through P along the child's rest direction. It is
  positive on the clockwise side, the side the child's tip swings toward when θ > 0. The outer side is the other side:
  - θ > 0: `outer(q) ⇔ s(q) < 0`;
  - θ < 0: `outer(q) ⇔ s(q) > 0`;
  - **tie:** `s(q) = 0` (on the line) is **never** outer.
  - Examples: childDir 0 (child points +x) and θ > 0 means outer = dy < 0, above. childDir 90 (child points down) and
    θ > 0 means outer = dx > 0, right. childDir 180 and θ > 0 means outer = dy > 0, below.
  - Why the child's rest direction: this is pure kinematics. It works whatever the parent's direction, so it also
    holds for joints that are already bent at rest.
- **Vacated:** `vac_θ(t) ⇔ win(t) ∧ ¬comp_θ(t) ∧ rest(t)`. The pixel was covered at rest and is uncovered now.
- **Ray** from q in direction `u ∈ {(1,0), (−1,0), (0,1), (0,−1), (1,1), (−1,−1), (1,−1), (−1,1)}`. Step
  t = q + k·u for k = 1, 2, …:
  - if `¬win(t)`, the ray returns **none**;
  - else if `comp_θ(t)`, the ray returns the label `{ p: parent(t), c: child_θ(t) }`. A pixel covered by both has
    both flags;
  - else if `¬rest(t)` (the pixel was already open at rest), the ray returns **none**;
  - else (t is vacated) the ray continues.
- **Pinched:** for at least one of the 4 lines `{(1,0), (0,1), (1,1), (1,−1)}`, let a = ray(q, u) and
  b = ray(q, −u). Both are labels, and `(a.p ∧ b.c) ∨ (a.c ∧ b.p)`.
- **Gap pixel at θ:** `win(q) ∧ ¬comp_θ(q) ∧ rest(q) ∧ outer(q, θ) ∧ pinched(q, θ)`.

These conditions have no ties beyond the `s = 0` rule. Every test is an integer comparison on pixel centres.

## 5. Algorithm (reference, O(angles · (2r+1)² · r))

```
for θ in sorted(frames.angle):
  gaps = []
  for y in max(0,py−r) .. min(H−1,py+r):          // row-major, so output is sorted by y then x
    for x in max(0,px−r) .. min(W−1,px+r):
      if comp_θ(x,y) or not rest(x,y) or not outer((x,y),θ): continue
      if pinched((x,y),θ): gaps.push([x,y])
  angles.push({ angle: θ, gaps })
```

## 6. Output

### 6.1 Per joint: `JointGapResult` (also the exact shape of each fixture's `*.expected.json`)

```json
{
  "pivot": [7, 5],
  "angles": [
    { "angle": -30, "gaps": [[7, 6]] },
    { "angle": 30, "gaps": [[7, 4]] }
  ],
  "gapCount": 2,
  "union": [[7, 4], [7, 6]]
}
```

- `angles`: every checked angle, ascending, **including those with no gaps** (`"gaps": []`).
- `gaps` and `union`: `[x, y]` canvas pixels sorted by y, then x. `union` holds the distinct gap pixels over all angles.
- `gapCount` = Σ `angles[i].gaps.length`. It counts (pixel, angle) pairs.
- Key order is as shown (`pivot`, `angles`, `gapCount`, `union`), so `JSON.stringify` output is stable.

### 6.2 Whole rig: `JointCheckReport` (`jointCheck`, `rig_joint_check`, `pf check`)

```json
{
  "view": "side",
  "params": { "rangeDeg": 30, "stepDeg": 5, "radius": 4 },
  "joints": [
    { "bone": "lower_arm_l", "parent": "upper_arm_l", "pivot": [20, 18], "angles": [], "gapCount": 0, "union": [] }
  ],
  "summary": { "joints": 1, "jointsWithGaps": 0, "gapCount": 0, "unionCount": 0 }
}
```

- `joints`: one entry per joint (section 3.2), sorted by `bone` name in code-unit order. Each entry is
  `{ bone, parent, ...JointGapResult }`, using bone names (not ids). The `angles` array in the example is shortened.
- `summary.gapCount` = Σ joint `gapCount`. `summary.unionCount` = Σ joint `union.length`.
  `summary.jointsWithGaps` = the number of joints with `gapCount > 0`.
- A rig passes the check when `summary.gapCount === 0`. For W2, "exactly the 3 seeded gaps" means
  `summary.unionCount === 3`. The seeded fixtures should also keep `gapCount === unionCount`, by seeding each gap at
  one angle only, so both readings agree. The `fixtures/joint` set does this: 3 gaps, each at exactly one angle.

## 7. Overlap mask (T3.5, `rig.overlapMask`; the FR-RIG-07 helper)

The fix is to paint hidden overlap on whichever of the two parts is drawn **lower**, under the upper part, so the
rest composite does not change. Note that every gap pixel q was covered at rest by the child and is never covered
by the parent: the parent is static, so `rest(q) ∧ ¬comp_θ(q)` implies `child_0(q) ∧ ¬parent(q)`.

`overlapMask` takes the `JointGapResult` plus the rendering context for the joint. It returns
`{ part, mask: Px[], local: Px[], uncovered: Px[] }`. `mask` is in rest canvas coordinates and `local` is the same
pixels in the painted part's image coordinates (both sorted by y, then x). `local` may fall outside the current
image bounds, and the paint op then grows the image. The cases:

- **Child drawn under the parent** (the usual case, and the spike's set-up). Paint on the child. For each angle
  entry θ and each gap q with d = q − P, take `[C, S] = trigQ16(θ)` and the nearest-sample source
  `src(q) = P + (rnd(C·dx + S·dy, 65536), rnd(−S·dx + C·dy, 65536))`. This is the same inverse mapping as the
  spike's `rotNearest`. Then:
  `hidden(t) ⇔ parent(t) ∧ ¬child_0(t)` (rest canvas), and
  `mask = ⋃_q { t ∈ 3×3 block around src(q) : hidden(t) }`.
  The 3×3 dilation matters: RotSprite's Scale2x rounds convex corners, so the exact source pixel can already be
  opaque (see the `gappy_knee` example). `local = mask − P + Pc`, where Pc is the child variant's pivot.
- **Child drawn over the parent.** Paint on the parent, directly at the gap pixels, which never move. Every gap q is
  child-covered at rest, so painting it is hidden: `mask = union`. `local = mask − Pp + Ppc`, where Pp is the
  parent's snapped pivot and Ppc its variant pivot.
- `uncovered`: the gaps q (from any angle, deduplicated, sorted) that no mask pixel can serve. In the child-under
  case, that means no hidden pixel in the 3×3 block around src(q). These need a visible art change.
- Preconditions (`JointCheckError`): exactly one visible part on each of the two bones (`AMBIGUOUS_PARTS`), and the
  painted part rendered at rest without a residual rotation, so drawnAngle = rest world angle (`ROTATED_REST`).
  Draw order is the final `renderParts` order at rest.
- T3.5's acceptance follows from the definition. The mask is hidden by construction, so painting it leaves the rest
  composite unchanged.
- **Worked examples** (child under parent, computed by hand; T3.5 should test them):
  - `gappy_elbow`: (7,6) at −30 gives C = 56756, S = −32768, d = (0,1), so src = (7 − 1, 5 + 1) = (6,6). (7,4) at +30
    gives src = (6,4). Hidden = parent x 0..6, y 4..7. Mask = the 3×3 blocks ∩ hidden =
    `[[5,4],[6,4],[5,5],[6,5],[5,6],[6,6],[5,7],[6,7]]`. `uncovered = []`. Painting just the end column x = 6 is
    `clean_capped_elbow`, which has 0 gaps.
  - `gappy_knee`: (9,5) at +10 gives C = 64540, S = 11380, d = (2,0), so src = (9,5). That pixel is the child's own
    rest corner and is not hidden, so the dilation finds the mask `[[8,4],[9,4]]`. Painting those two pixels
    removes the gap at +10…+25 under the spike's RotSprite.
- The spike's default cap ("1 px hidden overlap") should be read as **the parent's end column across the full limb
  width**, not "Chebyshev 1 of the pivot". On the 4-px elbow the pivot is off-centre (row 5 of rows 4..7). A
  Chebyshev-1 cap leaves `gappy_elbow`'s far edge uncovered, with a gap at (7,7) at −20. The full column
  (`clean_capped_elbow`) is clean at every angle from −30 to +30.

## 8. Non-goals and known limits

- **Rotation quality:** holes inside the child, stray pixels, and pockets between two child pixels are not counted
  (condition 5 needs one parent end). Neither are pockets on the inner side of the bend, where the child moves into
  the parent and its pixels sample its own body. Lint's orphan and hole rules cover these.
- **Far gaps:** anything farther than r from the pivot. Limbs wider than about 2r need a larger `radius`.
- **Gaps that merge with an opening already present at rest.** A ray stops at a pixel that was transparent at rest.
  So a joint opening that only widens an existing art notch is not reported. This is the price of rejecting the
  art's own steps and the crease (section 9).
- **Gaps between the child and anything other than its parent:** siblings, grandchildren, pixel layers.
- Joints across part-less bones; overrides, skins, post-passes; IK; variant auto-select (M1b); bend directions not
  produced by rotating one bone.
- The check never changes the document.

## 9. Rationale and history

- The spike (`spikes/rotsprite/REPORT.md`, "Joint caps", recommendation 7) found that a naive rule ("transparent
  near the joint, opaque on two sides") reports the inner crease of every bend and the art's own staircase steps.
  Conditions 3 (was covered) and 4 (outer side) remove those. Condition 5's run rule removes the rotated child's own
  edge staircase, whose diagonal can look across the open crease to the parent (`clean_inner_corner` at +20).
- The plan card's "inside the 8-connected closure of (parent ∪ child)" is made concrete as condition 5: an
  8-direction (4-line) pinch test, limited to vacated pixels and to the window. Hole filling cannot work, because
  gaps open onto the outside. Morphological closing fills every inner corner and step, and it is hard to check by hand.
- Each fixture trap fails exactly one condition, so a missing condition fails at least one fixture. The table is in
  the fixtures README.
