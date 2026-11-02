# RotSprite spike (T0.4) — report

**Question.** Can we rotate pixel-art limbs (characters 16–64 px tall) to arbitrary angles with acceptable quality
and speed? How big do joint caps need to be?

**Answer.** Yes, with the caveats below. Use RotSprite (Scale2x ×3, integer nearest rotation, one centre sample per
output pixel). It is ~100× faster than the NFR-01 budget, introduces no new colours, and with the conventions below it
lands the pivot pixel exactly at every angle. At these sizes, though, the visible difference from plain nearest is small
on thin limbs. RotSprite pays off on larger parts (head/torso-sized). Small parts with 1-px details (hands) still need
drawn variants.

## Test subjects and method

- Limbs cropped from a licensed 64×64 character sheet (the character is ~44 px tall, so limbs are **2 px wide** and
  4–8 px long): an upper arm (5×4, 11 px, 1 colour), a forearm+hand (4×4, 7 px, 1 colour) and a shin+foot (5×8, 24 px,
  6 colours). Plus a 32×32 crop of head and torso (373 px, 10 colours) used for timing and as a "large part".
- Algorithms: **rotsprite** (below), **rotsprite-mode** (same, but majority colour of the 64 sub-samples), **nearest**,
  **shear3** (Paeth three-shear, integer), and **Aseprite's own RotSprite**. Aseprite's Lua API has no arbitrary-angle
  rotation (`app.command.Rotate` does 90° multiples only), so a small C++ harness linked against a locally built Aseprite's
  `doc` library and called `doc::algorithm::rotsprite_image` the same way the interactive transform does.
- Angles: 5, 15, 30, 45, 60° clockwise for the contact sheets; 0–359 in 1° steps for the metrics.
- Contact sheets (×8, labelled, pivot marked) and all raw numbers are generated locally, outside the repo. They contain
  the licensed art and must never be committed; if they are regenerated here, `out/` is gitignored for that reason.
- Machine: Apple M5, Node 26 (TypeScript-free `.mjs` scripts; spike code kept outside the repo).

## Recommended algorithm and parameters (input for T1.6)

**Conventions**
- **Pivot = a pixel `(px,py)`; the rotation centre is its centre `(px+½, py+½)`** (pixel-centre convention).
- Every rotation result carries `(ox,oy)`, the output pixel the pivot lands on. Placement: `dst = snappedPivot − (ox,oy)`.
- Positive angle = clockwise on screen (y down).
- `C = round(cos θ · 65536)`, `S = round(sin θ · 65536)` (Q16) from a committed integer table at `angleQuantum`,
  exact at 0/90/180/270. All per-pixel maths is integer, which meets NFR-02.

**RotSprite**
1. `big = scale2x³(src)` — EPX/Scale2x with edges replicated, exact RGBA equality, transparent canonicalised to one
   value. It depends only on the source, so **cache it per variant** (256 KiB for a 32×32 part).
2. Fused rotate + downsample. For each output pixel at integer offset `d = (dx,dy)` from the pivot:
   ```
   sx8 = 8·px + 4 + sfloor( C·dx + S·dy, 8192)
   sy8 = 8·py + 4 + sfloor(−S·dx + C·dy, 8192)
   out = big[sy8][sx8]              // transparent if outside
   sfloor(n, q) = n >= 0 ? floor(n / q) : ceil(n / q) − 1
   ```
   **Downsample rule**: this rotates the ×8 image with nearest-neighbour about the pivot block's centre `(8px+4, 8py+4)`,
   then takes one sample per output pixel at that pixel's centre. The centre falls on a corner between ×8 pixels; the
   tie goes to the ×8 pixel on the far side from the pivot. That symmetric tie rule makes
   `rot(mirror(I), −θ) = mirror(rot(I, θ))` exactly. Plain `floor` broke the symmetry at 30°/60°, where sin = ½ puts many
   samples on corners. At 0° the result is the identity.
3. Output bounds: the rotated source corners, `floor(min)−1 … ceil(max)+1`, then trim to the opaque bbox, keeping the
   pivot.
4. `d = (0,0)` always samples inside the pivot pixel's own ×8 block, so **the pivot lands exactly by construction**.
   Add an explicit pivot pin anyway (`out[ox,oy] = src[px,py]`), as a cheap invariant for FR-RIG-20 step 3.

Not recommended:
- the majority ("mode") downsample: it erodes thin limbs (−14…−29 % area on the 7-px forearm) and is ~150× slower;
- Aseprite's downsampler: see the comparison below;
- shear3 as a product option: it is an exact pixel permutation, but it leaves the most stray pixels on large parts.

## Results

**Colours (FR-RIG-21).** Over 4 subjects × 360 angles × 5 algorithms: **0 new colours** and 0 semi-transparent pixels.
For RotSprite this holds by construction: Scale2x only copies colours, and the downsample copies one sample. So
**"RotSprite introduces no new colours" holds**. The test should assert output colours ⊆ input colours ∪ {transparent},
and that no semi-alpha is produced.

**Pivot sentinel.** The pivot pixel was recoloured to a unique colour and rotated through 0–359 in 1° steps.
rotsprite, nearest and shear3 put it exactly on `(ox,oy)` at **360/360** angles on every subject. A stress test used
every opaque pixel of every subject as the pivot (149,400 RotSprite runs): **0 failures**.

**Area change.** Ours stays within ±1 pixel of the input: ±9–14 % on the 7–11 px limbs, where one pixel is 9–14 %, and
within ±1.3 % on the 32×32 part. Mean absolute change over 360°: 0.7 % (32×32), 2.5 % (shin), 6.9 % (upper arm).

**Mirror symmetry.** The mask IoU of `mirror(rot(I,θ))` vs `rot(mirror(I),−θ)` is **1.000 at every angle** for
rotsprite, nearest and shear3.

**Stray pixels and fragmentation** (means over 360°; the input has 1 component):

| | nearest | shear3 | **rotsprite** | Aseprite |
|---|---|---|---|---|
| 32×32 part: connected components | 2.44 | 2.86 | **1.29** | 1.37 |
| 32×32 part: single-pixel colour orphans (3 at rest) | 5.44 | 6.46 | **2.93** | 3.31 |
| shin+foot: colour orphans (2 at rest) | 2.90 | 3.22 | **1.49** | 2.34 |
| forearm+hand: components | 1.22 | 1.12 | 1.39 | 1.34 |

On 2-px limbs all algorithms produce nearly identical pixels. On larger parts RotSprite halves the stray pixels and keeps
thin strands attached. The forearm+hand has a 1-px "hook", which detaches under every algorithm from ~15–30°.

**Aseprite's RotSprite** (same Scale2x×3 front end, a different back end):
- it is not the identity at 0° (−9 % area on the upper arm);
- it loses 20–40 % of a thin limb's pixels (its downsample steps by `(8w−1)/(w−1)`, so the sample phase drifts);
- it has no pivot tracking: the pivot sentinel landed on the expected pixel at only 10–53 of 360 angles, and was lost
  entirely at about half of them;
- mean mirror IoU is 0.15–0.78.

Its shapes are close to ours once shifted (shift-tolerant IoU 0.77–0.96), so the gap is mostly in placement and thin-pixel
loss. That matters for a rig, not for one-off art rotation.

## Performance vs NFR-01

32×32 input, 30°, median of 100 runs (after warm-up), Apple M5, Node 26:

| | median | NFR-01 target (M1) |
|---|---|---|
| RotSprite, cache-cold (Scale2x×3 + rotate) | **0.090 ms** | < 10 ms |
| RotSprite, first call in a fresh process (JIT-cold) | 0.9–2.2 ms | < 10 ms |
| RotSprite, warm (×8 cached) | **0.011 ms** | — |
| 16 parts of 16×16, all warm | **0.044 ms** | < 2 ms for the whole rig render |
| 16 parts of 16×16, all cache-cold | 0.35 ms | — |
| nearest / shear3 | 0.013 / 0.007 ms | — |
| Aseprite `rotsprite_image` (C++, for reference) | 0.153 ms | — |

An M1 is ~1.5–2× slower single-threaded. The headroom is still ~50×. No WASM or worker is needed.

## Joint caps

Setup: the upper arm stays at rest, and the forearm+hand rotates about the elbow pivot from −30° to +30° in 5° steps.
Draw order: cap, then child, then parent.
- An **overlap of K px**: the child also holds the parent's pixels within Chebyshev distance K of the joint, drawn under
  the parent. This is invisible at rest.
- A **disc cap of radius R** in the limb colour sits under the joint.
- **Gap pixel** (spike definition, for T3.0 to formalise): a transparent pixel near the joint, sandwiched between parent
  and child pixels along N–S, E–W or a diagonal, on the outer side of the bend, and not already present at rest.
  Inner-corner concavities are not counted.

| limb width | config | gap px over 13 angles (RotSprite) | changes the rest silhouette | extra visible px at ±30° |
|---|---|---|---|---|
| 2 px (real art) | none | **0** | no | 0 |
| | overlap 1 / 2 | 0 / 0 | no | 2 / 3 |
| | disc R=1 / R=2 | 0 / 0 | **yes, 2 / 7 px** | 2 / 7 |
| 4 px (art ×2, synthetic) | none | 4 (1 px at −15…−30°) | no | 0 |
| | **overlap 1** | **0** | no | 2 |
| | overlap 2 / 3 / 4 | 3 / 2 / 0 (new notches where the overlap pokes out) | no | 3 / 5 / 9 |
| | disc R=1 / 2 / 3 | 3 / 0 / 0 | **yes, 1 / 4 / 12 px** | 2 / 5 / 13 |

With nearest or shear3, overlap 1 left 3 gap pixels at 4-px width. RotSprite's Scale2x rounds the overlap into the
corner and closes them. The joint itself (parent connected to the child's base) never broke in any configuration.

## Recommendations

1. **Algorithm**: RotSprite as specified above, as the FR-RIG-21 default. Keep `nearest` and `none` as the other options.
2. **Pivot**: the pixel-centre convention and pivot tracking via `(ox,oy)` as above, plus the pivot pin and a sentinel test.
   For even-width limbs the joint pixel is one of the two centre pixels. Pick the one on the parent side; the ½-px bias
   is inherent.
3. **`maxResidualDeg`: keep the default of 22.5°** (variants every 45°). Plain 2-px strokes survive any angle, but parts
   with 1-px details degrade from ~15°. Allow a per-part override and suggest 15° for such parts.
4. **Variants (pre-drawn angles) will be needed** for:
   - hands and forearm+hand pieces (every 45°, plus open/closed);
   - feet beyond about ±30°: the silhouette survives, but the colour layout scrambles;
   - heads and faces (inferred from the 1-px-detail result; not tested directly).
   Plain upper arms, thighs and shins can be rotated.
5. **Joint cap: 1 px of hidden overlap by default.** The child carries the parent's pixels within Chebyshev 1 of the
   joint, drawn under the parent. This is what the overlap helper (FR-RIG-07) should propose. For limbs ≥ 6 px wide use
   `max(1, ceil(w/4))` px. Larger overlaps start to show past the parent's outline at ±20–30°. Don't use disc caps unless
   the disc fits inside the limb at rest (R ≤ (w−1)/2); on 2–4 px limbs they visibly change the rest pose.
6. **Performance**: about two orders of magnitude inside NFR-01, so no optimisation work is needed for M1. Cache `big`
   per variant and the result per `(variantId, quantisedAngle)` as FR-RIG-20 already says.
7. The FR-RIG-05 joint check needs the outer-side and "not present at rest" filters described above. Without them, the
   inner-corner concavities of every bend and the art's own staircase steps get reported as gaps.

## Caveats

- The test set is one character style at one scale. The 4-px joint case is a synthetic ×2 upscale, not drawn art.
- Only one joint (the elbow) was swept. The gap definition is provisional (T3.0 formalises it).
- Aseprite was exercised through its library, not its UI. The UI uses a fast non-RotSprite path at exact 90° multiples.
