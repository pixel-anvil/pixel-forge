# Playbooks

Step-by-step recipes for recurring patterns. Each section is filled in by the card that creates the pattern.

## How mutations work
Filled in by card T2.1.

## Add an op
Filled in by card T5.1.

## Add a lint rule
Filled in by card T4.1.

## Add a golden / ASCII test
Prefer a hand-written ASCII expectation; use a golden only when the image is too big to write by hand.

```ts
import { asciiToImage, expectAscii, expectGolden } from '@pixel-forge/testkit';
const legend = { R: [255, 0, 0, 255], B: [0, 0, 255, 255] } as const; // '.' = transparent

it('draws a diagonal', () => {
  const img = drawDiagonal(3); // code under test -> { width, height, data }
  expectAscii(img, `
    R..
    .R.
    ..R
  `, legend); // failure prints expected | actual side by side + first differing coords
});

it('renders the scene', () => {
  expectGolden('scene-basic', renderScene(), { testFile: import.meta.url });
});
```

1. Add `@pixel-forge/testkit` as a devDependency of the package (workspace protocol); tests import it, `src/` never does.
2. First run of a golden: `UPDATE_GOLDEN=1 pnpm --filter <pkg> test` creates `test/__golden__/scene-basic.png`.
3. Look at it: `pnpm golden:sheet scene-basic` and open `.golden-diff/sheet-scene-basic.png`. Write "golden reviewed" on the card.
4. On failure see `.golden-diff/<name>.{actual,expected,diff}.png` (magenta = differs, cyan = alpha only). Update only with `UPDATE_GOLDEN=1` plus a card note.
5. Commit the `__golden__` PNG with the test. Never hand-edit a golden.

## Add a migration
Filled in by card T4.2.

## Add a palette preset
Filled in by card T1.3.

## Dispatch and verify a card (orchestrator)
Filled in by the orchestrator; the procedure is in `docs/02-plan.md` section 0.1 until then.
