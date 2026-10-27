# @pixel-forge/rig

FK/IK, key interpolation and quantisation, snapping, variant selection, part render, overrides and staleness, joint check, presets and templates.

**Depends on:** `schema`, `raster`

**Status:** T3.1: forward kinematics, key interpolation and quantisation, hierarchical snapping (FR-RIG-10/11/12, FR-RIG-20 steps 1–2). Part rendering (T3.3), joint check (T3.4) and pose clipboard (T3.6) come later.

Pure: no Node built-ins, no clock, no randomness, and **no floating-point trig or accumulation** in any decision. Angles are exact BigInt rationals until they are rounded once; rotations use raster's committed Q16 table (NFR-02, ADR-010). The conventions are recorded in [ADR-012](../../docs/adr/ADR-012.md) (Accepted), which refines spec §3.4.7.

## API

| Export                                             | Purpose                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluatePose(rig, view, animation, frame, opts?)` | FR-RIG-20 steps 1–2: the `SnappedSkeleton` of one frame (`frame` is a `FrameId` or an index, schema `FrameRef`). `opts.angleQuantum` overrides the animation's. `animation` may be a `PreparedAnimation`                                                                                                                                                                                     |
| `prepareAnimation(rig, animation, opts?)`          | Validates every key and indexes the keyed frames of every channel **once**; pass the result to `evaluatePose` / `resolvePose` to evaluate many frames without repeating that work (and the bone order is computed once per call, not twice). It is a snapshot: edit the animation, prepare again. A prepared animation used with another rig or quantum is prepared again, never mis-applied |
| `resolvePose(rig, animation, frame, opts?)`        | Step 1 only: every bone's resolved key (`{angle, offset, flipX}`, quantised) as a `Map` in bone order                                                                                                                                                                                                                                                                                        |
| `snapSkeleton(rig, view, pose, {angleQuantum}?)`   | Step 2 only: snaps any pose (`Map<BoneId, {angle?, offset?, flipX?}>`; missing bones and channels are at rest). For the joint sweep (T3.4), pose paste previews (T3.6) and IK bake previews                                                                                                                                                                                                  |
| `boneOrder(rig)`                                   | Bone ids, parents first: depth-first pre-order, roots and siblings sorted by id (code-unit order, not locale). Checks I1                                                                                                                                                                                                                                                                     |
| `selectView(rig, direction?)`                      | `views[0]` for an undirected animation, else the first view whose `directions` contain the direction (`UNKNOWN_VIEW` otherwise). Fallback chains are document data, applied by the caller                                                                                                                                                                                                    |
| `keySpan(keyed, frame, frameCount, wrap)`          | Where a sparse channel's value comes from (previous key, next key, `i/n`), with the hold / loop-wrap rule below. Exported so part keys (T3.3) can use the same rule                                                                                                                                                                                                                          |
| `interpWeight(interp, i, n)`                       | The exact weight `[N, D]` of `step`, `linear`, `ease-in-out`. `RigError('BAD_VALUE')` for an unknown `interp`, a non-integer position, `n ≤ 0`, `i < 0` or `i > n` (a `KeySpan` with `n === 0` needs no weight)                                                                                                                                                                              |
| `quantizeAngle(deg, q = 1)`, `normalizeAngle(deg)` | Exact half-away-from-zero rounding to a multiple of `q` (odd: `Q(−x) = −Q(x)`), and reduction into `[0, 360)`                                                                                                                                                                                                                                                                                |
| `RigError` (`code`)                                | `UNKNOWN_BONE`, `DUPLICATE_BONE`, `CYCLE`, `UNKNOWN_FRAME`, `UNKNOWN_VIEW`, `BAD_QUANTUM`, `BAD_VALUE`                                                                                                                                                                                                                                                                                       |
| Types                                              | `SnappedSkeleton {angleQuantum, bones: Map<BoneId, SnappedBone>}` (bone order), `SnappedBone`, `WorldTransform`, `ResolvedBoneKey`, `ResolvedPose`, `Pose`, `PoseKey`, `KeySpan`, and the structural input types `BoneGraph`, `RestPose`, `PoseAnimation`, `PoseFrame`, `ViewSet`                                                                                                            |

Inputs are structural and read-only: a schema `Rig`, `View` and `AuthoredAnimation`, or the `DeepReadonly` versions core hands to the rig hook, fit directly. A `MirrorAnimation` does not (it has no frames): evaluate its source; mirrors are flipped in core (FR-RIG-16, T3.6).

`SnappedBone`: `id`, `parentId?`, `inView`, `pivot` (integer canvas pixel), `key` (the resolved local key: `angle` relative to rest and **not** normalised, `offset`, `flipX`), and the `WorldTransform` fields, all degrees in `[0, 360)` and multiples of the quantum:

- `rotation`: rotation away from the rest pose, the sum of the quantised key angles of the bone and its ancestors. It rotates the bone's children's rest offsets, and it is the residual of a part variant drawn at rest (no `drawnAngle`).
- `restAngle`: the bone's world direction at rest (its rest angle plus its ancestors', summed exactly, quantised once).
- `worldAngle`: `restAngle + rotation`, the world direction now (variant auto-select, gizmos, IK).
- `flipX`: mirror the bone's own parts; not inherited.

## Conventions (spec §3.4.7 as refined by ADR-012)

- Angles are degrees, 0° along +x, clockwise on screen (y down). `BoneKey.angle` is relative to the rest angle. Rest angles are relative to the parent (a root's is a world angle).
- **Rest positions are canvas offsets at rest.** A root's rest `(x, y)` is its canvas pivot. A child's rest `(x, y)` is its pivot's canvas offset from the parent's pivot **in the rest pose**; it turns with the parent's rotation away from rest. Rest angles never move a pivot. So with no keys every pivot is exactly where it was authored, whatever the rest angles and the quantum, and parts render at rest exactly as drawn. (The literal §3.4.7 reading, an offset in the parent's frame rotated by its rest angle, cannot reach every canvas pixel and makes the rest pose depend on the quantum; see ADR-012.)
- Offset keys are integer canvas translations, added after the rotation. `flipX` flips only the bone's own parts.
- A missing `interp` is `linear`. An undirected animation uses `views[0]`.
- A bone with no rest entry in the view is unused there (its parts are hidden, schema `View`). It is still evaluated with rest `(0, 0, 0)` and reported with `inView: false`, so it passes its parent's pivot and rotation through to any children. This is not an error.
- `Frame.rootMotion` is engine data (FR-ANIM-08) and never moves the skeleton.

## Step 1: key resolution and interpolation (FR-RIG-11, FR-RIG-12)

Keys are sparse (`Frame.boneKeys`). Each channel (`angle`, `offset`, `flipX`) is resolved on its own, over the frames that key that channel:

- **By frame index, not by time.** `t = i / n`, where `i` counts frames from the previous key and `n` from the previous to the next key. Durations are timing and keys are spacing: a hold is a longer duration (FR-ANIM-03), and lengthening or shortening a frame must not move any pose. Time-based interpolation would re-pose every in-between whenever a frame is retimed.
- **The previous key's `interp`** decides a segment: `step` holds its value; `linear` is `t`; `ease-in-out` is the cubic smoothstep `w = 3t² − 2t³` (zero slope at both keys, symmetric `w(1 − t) = 1 − w(t)`). `flipX` always steps.
- **Before the first / after the last key** the nearest key holds (`once`, `pingpong`; a ping-pong never plays last → first). A **`loop`** animation wraps instead: after the last key the segment runs to the first key one loop later, and before the first key it runs from the last key one loop earlier, so a cycle flows across its seam. A single key holds everywhere. A channel no frame keys is at rest (angle 0, offset (0, 0), flipX false).
- **Angles are raw degrees**: no unwrapping and no shortest path. 0 → 720 spins twice; 350 → 10 goes back through 180.
- **Exact arithmetic.** Each double is converted to its exact value `m / 2^e`; `value = a + (b − a)·N/D` is a BigInt rational; it is rounded **once**, half away from zero, to a multiple of the quantum `q` (`opts.angleQuantum ?? animation.angleQuantum ?? 1`). Offsets are interpolated the same way and rounded half away from zero to integers. Example: float64 gives `0.3 + (0.7 − 0.3)/2 = 0.5`, a tie that would round to 1°; the exact midpoint of the doubles is 0.49999999999999997224, which rounds to 0°.

Every key of the animation is validated up front (`prepareAnimation`), not just the ones the frame uses, so errors never depend on the frame: each key's angle is quantised and must stay below 2^51° (quantisation is monotone, so every interpolation between valid keys is valid too), offsets must be in-range integers, `interp` known, and every keyed bone in the rig. An invalid key at frame 2 makes frames 0 and 1 throw as well.

## Step 2: hierarchical snapping (FR-RIG-20 step 2)

For every bone in `boneOrder` (parents first):

```text
a          = round(key.angle / q) · q                        local, relative to rest; half away from zero
rotation   = parent.rotation + a                             (root: a)
pivot      = root:  rest.(x, y) + key.offset
             child: parent.pivot + rotatePoint(rest.x, rest.y, parent.rotation) + key.offset
restAngle  = round((Σ rest.angle over the bone and its ancestors) / q) · q
worldAngle = restAngle + rotation                            (rotation, restAngle, worldAngle in [0, 360))
```

`rotatePoint` is raster's fixed-point rotation: `[C·dx − S·dy, S·dx + C·dy]` with the Q16 table values `C = cosQ16(θ)`, `S = sinQ16(θ)`, each coordinate rounded half away from zero. That rounding is the **only** rounding of a child pivot, and its result is added to the parent's **snapped** integer pivot. A child pivot is never rounded independently of its parent, so:

- the vector parent → child (minus the child's own offset key) is a function of the parent's rotation alone: a translation anywhere up the chain moves the whole subtree by exactly the same integers, and a constant parent rotation keeps the joint exactly still;
- between two frames that vector changes by at most `ceil(L·Δθ)` per axis (`L = |rest offset|`, `Δθ` the change of the parent's rotation in radians), up to an exact .5 tie; the card's bound `ceil(L·Δθ) + 1` holds with room to spare.

Rest angles are summed exactly and quantised once, so a chain of rest angles that are not multiples of `q` does not accumulate rounding (rest angles 0.4°, 0.4°, 0.4° give rest directions 0°, 1°, 1°, not 0°, 0°, 0°). When every rest angle is a multiple of `q`, `worldAngle = parent.worldAngle + rest.angle + a`.

### Worked example

Shoulder (root) rest `(10, 4)` at 90°, elbow rest `(0, 6)`, wrist rest `(1, 5)`, `q = 1`. Keys: shoulder 30°, elbow 15.3°.

| Bone     | `a` | `rotation` | `restAngle` / `worldAngle` | pivot                                                                                   |
| -------- | --- | ---------- | -------------------------- | --------------------------------------------------------------------------------------- |
| shoulder | 30  | 30         | 90 / 120                   | `(10, 4)`                                                                               |
| elbow    | 15  | 45         | 90 / 135                   | `rotatePoint(0, 6, 30°)`: `C = 56756, S = 32768` → `(−3, 5.196)` → `(−3, 5)` → `(7, 9)` |
| wrist    | 0   | 45         | 90 / 135                   | `rotatePoint(1, 5, 45°)`: `C = S = 46341` → `(−2.828, 4.243)` → `(−3, 4)` → `(4, 13)`   |

With no keys the same rig gives `(10, 4)`, `(10, 10)`, `(11, 15)`: the authored rest pose, at any quantum and any rest angles.

**The fixture, frame 0** (`test/arm-swing.test.ts`; shoulder `(16, 8)`, elbow rest `(2, 9)`, wrist rest `(−1, 8)`; shoulder key −30°, elbow key 50°): the elbow is `(16, 8) + rotatePoint(2, 9, 330°)` = `(16, 8) + round(6.232, 6.794)` = `(22, 15)`; its rotation is 330 + 50 = 20°; the wrist is `(22, 15) + rotatePoint(−1, 8, 20°)` = `(22, 15) + round(−3.676, 7.176)` = `(18, 22)`. Rounding the float chain per bone instead (the jitter bug) gives `round(18.556, 21.970)` = `(19, 22)`: the forearm vector becomes `(−3, 7)` on this frame and `(−4, 7)` on the next, although the forearm does not rotate between them. **Frame 3**: shoulder ease −30 → 30 at `t = 1/2` gives 0°, elbow ease 50 → −10 gives 20°, so the elbow is `(18, 17)` and the wrist `(14, 24)`.

## Rounding: half away from zero

Both quantisation and `rotatePoint` round half away from zero (FR-RIG-12, ADR-010). It is odd-symmetric, so **negating every key angle negates every resolved angle exactly**, and mirroring a rig (rest `x → −x`, angles and offset `x` negated) mirrors every pivot exactly: what "paste mirrored" (FR-RIG-17, T3.6) relies on. Both are property-tested. The price: it does not commute with translation at an exact tie. An interpolated offset of exactly `k + ½` can shift by one pixel more than a translated copy (offsets 0 → 1 give 1 at the midpoint, −1 → 0 give −1). Rest positions and keyed offsets are always translation-exact.

## Validation

`rig` never assumes core's `validate()` ran. `RigError` codes: `DUPLICATE_BONE`, `UNKNOWN_BONE` (a parent, rest entry, bone key or pose entry for a bone the rig lacks), `CYCLE` (I1, self-parent included), `UNKNOWN_FRAME`, `UNKNOWN_VIEW`, `BAD_QUANTUM` (not a valid schema `AngleQuantum`: a multiple of 0.25 in `(0, 90]` dividing 360; the rule is `isValidAngleQuantum` / `angleQuantumSteps` from `@pixel-forge/schema`, the same one the document schema uses), `BAD_VALUE` (a non-finite angle; a rest position or offset that is not an integer of magnitude ≤ 2^31, raster's `MAX_ROTATE_COORD`; an unknown `interp`, also in `interpWeight`, whose position must satisfy `0 ≤ i ≤ n`, `n ≥ 1`; a quantised key angle of 2^51° or more). A `Record` entry whose value is `undefined` (a bone key, or a view's rest entry) is skipped, never an error. Record lookups read own properties only.

## Evidence (tests)

- **(a) Independent reference** (`test/float-reference.ts`, `test/reference.test.ts`): an independent implementation of the whole chain, run on 1000 seeded random forests (up to 9 bones, 16 frames, all quanta, ties seeded on purpose). Offsets, angles with 1/8° operands (every `(k + ½)·q` tie of the tested quanta) and rest sums are computed in exact integer arithmetic; rotations use `Math.cos`/`Math.sin` except where the trig value is exactly known (multiples of 90° and 30°, where float64 `sin 30°` is `0.49999999999999994`). All **42 881** bone evaluations match `evaluatePose` exactly, **exact ties included**: 5 183 key angles, 1 005 offsets, 3 387 rest sums and 22 rotated rest offsets are compared as ties (e.g. `(1, 0)` at 30° is exactly `(0.866, 0.5)` in Q16 → `(1, 1)`). Only genuinely float-ambiguous quantities are not compared exactly: 4 rest sums with a non-1/8 operand and 25 rotated coordinates within the Q16 table error `(|dx| + |dy|) / 131072` of .5 (ADR-010). There the reference accepts either neighbouring rounding, checks that the implementation chose one of them, and continues from that choice, so no bone is skipped and descendants of a tie are compared exactly (in 1 of the 29 float64 would have rounded the other way). The counts are pinned.
- **(b) Translation**: moving a root's rest position by `k`, or adding a constant root offset key `k`, moves every pivot of its tree by exactly `k` (200 random rigs each). The tie exception above is a pinned test too.
- **(c) Per-frame bound**: (rotations and offset keys from the reference, not from the code under test) over 11 188 consecutive frame pairs (loop seams included) of 400 random rigs, the parent → child vector changes by ≤ `ceil(L·Δθ) + 1` per axis; it never needs the `+ 1` (≤ `ceil(L·Δθ)` everywhere), and it is unchanged on all 5 133 pairs where the parent's rotation is unchanged.
- **(d) Hand-written tables** (`test/interp.test.ts`): step, linear and ease, the previous key's interp, hold before and after (once, pingpong), loop wrap (linear and eased), single keys, quanta 5 and 0.25, ties, multi-turn angles, offsets, flipX, independent channels.
- **(e) Arm swing** (`test/arm-swing.test.ts`): 12 frames, shoulder ±30° eased, elbow counter-rotating on the forward swing so the forearm keeps a 20° rotation, then lagging. The 12-frame pivot table is an independently derived golden (from the reference above, "golden reviewed: derived from independent reference, 2026-10-27"; the committed SHA is a secondary pin), and Δθ comes from the reference's own accumulation of the input keys. Every joint stays within `ceil(L·Δθ)` per frame, and the forearm vector is exactly constant over frames 0–6. The deliberately wrong method (each pivot rounded from the float chain) breaks the tight bound on 0→1 and 5→6, where the forearm does not rotate but the wrist jumps 1 px against the elbow. Note: the wrong method **cannot** break `ceil(L·Δθ) + 1`: per axis it moves the vector by less than `|Δv| + 2`, i.e. at most `ceil(|Δv|) + 1`. The test asserts that too, so the tight bound and the rigidity property are the ones that catch the bug.
- **(f) Determinism**: a committed SHA-256 of the fixture's canonical pose table; repeated evaluation is identical; and with `Math.sin/cos/tan/atan/atan2/asin/acos/sinh/cosh/tanh` stubbed to throw, the fixture and 100 random rigs evaluate unchanged.

Coverage: 100 % of lines, 95 % of branches.

## Notes for consumers

- **T3.2 (templates, rest poses, pivots):** author rest positions as canvas offsets at rest (child pivot − parent pivot, both as drawn); no inverse rotation is needed and every pixel is reachable. Rest angles are parent-relative bone directions and do not move pivots. Use `boneOrder` for outliners and anything that walks the tree.
- **T3.3 (part render):** call `evaluatePose` with the frame's view (`selectView`). A part's residual is `bone.rotation` when its variant has no `drawnAngle`, so a part at rest is never resampled; with a `drawnAngle` it is `worldAngle − drawnAngle`, which T3.3 must quantise (`quantizeAngle`) because `drawnAngle` is an arbitrary float. Hide the parts of bones with `inView: false`. Cache by `(variantId, residual)`. `keySpan` gives part keys the same hold / loop-wrap rule if T3.3 wants it (part keys are step-only; what holds before a part's first key is T3.3's decision).
- **T3.4 (joint check):** the sweep is `snapSkeleton(rig, view, new Map([[B, {angle: θ}]]))`. `pivot` = B's rest pivot (B's own rotation never moves it), `childDir` = B's `restAngle` at the quantum used (0.25 gives the finest table direction).
- **T3.6 (pose clipboard):** key angles are relative to rest, so "paste mirrored" negates `angle` (and swaps `_l`/`_r`). Quantisation is odd, so the pasted pose evaluates to exactly the negated rotations. Whether to negate offset `x` is T3.6's call.
