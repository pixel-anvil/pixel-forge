# fixtures/joint: joint-gap fixtures (T3.0)

Hand-written oracles for the joint coverage check, [`docs/contracts/JOINT_CHECK.md`](../../docs/contracts/JOINT_CHECK.md).
These are **not** generator outputs, and `pnpm fixtures:check` does not touch them. The `*.expected.json` files
were written by hand from the drawings. Do not regenerate them with the code under test. T3.4's test must load
each `<name>.txt`, run `jointGaps`, and deep-equal the result against `<name>.expected.json`.

## File format (`<name>.txt`)

- Lines starting with `#` are comments. Blank lines end a frame.
- Header lines, each exactly once, before the first frame:
  - `pivot <x> <y>`: the joint pivot P in canvas pixels;
  - `childDir <deg>`: the child bone's rest world angle (0 = +x, clockwise);
  - `radius <r>`: the window radius.
- `frame <θ>` followed by the grid rows (one character per pixel) starts a frame. `frame 0` (rest) is required.
  The other frames are the angles to check. They need not cover the whole ±30/5 sweep, and their order does not matter.
- All grids have the same size (≤ 16×16). The parent mask (`P` or `B`) is identical in every frame, because only the child moves.

### Legend

| char | parent | child | meaning                                  |
| ---- | ------ | ----- | ---------------------------------------- |
| `.`  | –      | –     | transparent                              |
| `P`  | ✓      | –     | parent only                              |
| `C`  | –      | ✓     | child only                               |
| `B`  | ✓      | ✓     | both (child pixel hidden under the parent) |

Load each frame with testkit's `asciiToImage` twice, using two legends (colours are arbitrary, only alpha matters):

```ts
const PARENT_LEGEND = { P: [255, 0, 0, 255], B: [255, 0, 0, 255], C: [0, 0, 0, 0] };
const CHILD_LEGEND = { C: [0, 0, 255, 255], B: [0, 0, 255, 255], P: [0, 0, 0, 0] };
// frame 0 → parent = asciiToImage(grid, PARENT_LEGEND), childRest = asciiToImage(grid, CHILD_LEGEND)
// frame θ → { angle: θ, child: asciiToImage(grid, CHILD_LEGEND) }
```

The frames are inputs, so the check does not depend on the rotation algorithm. The child frames came from the
spike's reference RotSprite (`spikes/rotsprite/reference/rot.mjs`), except the frame marked SYNTHETIC. They are
plain inputs and can be checked by eye. Coordinates below are `(x, y)`, with row 0 as the first grid row.

## Fixtures and expected results

**Total: exactly 3 gap pixels** over the `gappy_*` set. Each is at a single angle, so `gapCount` = `union` size = 3.
Every `clean_*` fixture expects 0.

| fixture | expected | what it shows |
| --- | --- | --- |
| `gappy_elbow` | 2: (7,6) at −30, (7,4) at +30 | A 4-px horizontal limb with no cap; the pivot (7,5) is the upper centre row. At −30 the child's bottom-left corner swings right, leaving (7,6) pinched between parent (6,6) and child (8,6). At +30 the same happens at the top, (7,4). Near misses: (7,7) at −30 is the open mouth of the notch (no line has a parent end and a child end), and (9..11,4) at +30 are just the child's edge moving away. |
| `gappy_knee` | 1: (9,5) at +10 | A 5-px vertical limb (childDir 90, so for θ > 0 the outer side is the right). Scale2x rounds the child's top-right corner, so (9,5) opens between parent (9,4) above and child (9,6) below. `radius 2` puts (9,5) exactly on the window edge: this pins `≤` and the Chebyshev metric. With a Euclidean window the parent end (9,4) at distance √5 falls outside. (9,9) is vacated but open below. |
| `clean_capped_elbow` | 0 | `gappy_elbow` with a 1-px hidden overlap: the child also holds the parent's end column x = 6 (`B` at rest). Both gaps are filled at ±30. This is the remedy the overlap helper proposes. |
| `clean_inner_corner` | 0 | An elbow bent 90° at rest, with a capped column x = 6. **Inner-corner trap:** at −30 the crease pixels (7,5), (7,4), … are pinched between parent and child, but they are on the inner side and were open at rest. At +20 the crease (7,5) is on the outer side and pinched diagonally (6,4)/(8,6). It is rejected only because it was open at rest. **Run-rule trap:** at +20 the rotated child's step (9,6) is vacated and outer. Its NW diagonal crosses the open crease to the parent (6,3), so it would count if rays could cross pixels that were open at rest. |
| `clean_staircase` | 0 | **Art's own step:** the parent's top edge steps down at its end, so (6,4) is already open at rest. At +10 it is outer and pinched between parent (5,4) and child (7,4), and it is rejected only because it was open at rest. **Rotated staircase:** (10,4), (11,4) at +10 and (9..11,7) at −20 are the child's own edge steps (vacated, outer, but not pinched). |
| `clean_pockets` | 0 | `clean_capped_elbow` mirrored (childDir 180, child pointing left, so for θ > 0 the outer side is below). SYNTHETIC +20 frame with two pixels removed by hand. (6,4) is an inner-side pocket between child and parent: everything holds except the outer side. If childDir is ignored, it is reported. (4,6) is an outer-side pocket between two child pixels: it is rejected only because neither line has a parent end. |

## Which condition each trap pins

Each row is a defect the fixtures catch (checked with a throwaway mutated implementation):

| implementation defect | fixture that fails |
| --- | --- |
| no "covered at rest" filter | `clean_inner_corner` (7,5)@+20, `clean_staircase` (6,4)@+10 |
| no outer-side filter | `clean_pockets` (6,4)@+20 |
| outer side ignores `childDir` | `clean_pockets`, `gappy_knee` |
| rays may cross pixels that were open at rest | `clean_inner_corner` (9,6)@+20 |
| any two opaque ends count (not parent + child) | `clean_pockets` (4,6)@+20 |
| Euclidean window, or `<` instead of `≤` | `gappy_knee` |

Not pinned here (T3.4 should add its own unit cases): rays that ignore the window, and a radius argument that is
ignored in favour of the default.
