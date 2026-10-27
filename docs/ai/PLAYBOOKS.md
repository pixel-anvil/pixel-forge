# Playbooks

Step-by-step recipes for recurring patterns. Each section is filled in by the card that creates the pattern.

## How mutations work
Every change goes through one transaction on a `DocumentStore` (`packages/core/README.md`). An operation is a function that takes the transaction:

```ts
export function setFrameDuration(tx: Transaction, animId: AnimationId, frameId: FrameId, ms: number): void {
  if (!Number.isInteger(ms) || ms < 1) throw new CoreError('BAD_ARGUMENT', 'durationMs must be an integer >= 1');
  tx.update((d) => {
    const anim = d.animations.find((a) => a.id === animId);
    const frame = anim && 'frames' in anim ? anim.frames.find((f) => f.id === frameId) : undefined;
    if (frame) frame.durationMs = ms; // plain JS on a draft; only the touched path is copied
  });
}
store.transact('Set duration', (tx) => { setFrameDuration(tx, animId, frameId, 120); }); // MCP: `AI: <tool>`
```

1. Validate inputs first: any error thrown by a `tx` method aborts the whole transaction.
2. Never `begin` inside an operation; take `tx` and pass it to helpers (transactions do not nest).
3. Edit JSON with `tx.update(draft => …)`. Remove optional fields with `delete d.x` and record entries with `Reflect.deleteProperty(layer.cels, frameId)` (lint forbids `delete rec[key]`); never assign `undefined`; values must be plain JSON.
4. New ids: `tx.newId('frame')` (also inside a recipe). Never invent ids or use randomness.
5. Pixels: `tx.writeImage(id, img => …)`; new images: `const id = tx.createImage(img)`, then reference it; `tx.deleteImage(id)` after removing its references. Inside a `writeImage` callback touch only the image (any other `tx` or store call throws `TX_BUSY` and aborts). Change listeners must not change the store (`TX_BUSY`); schedule follow-ups asynchronously.
6. Never mutate `store.doc` or an image from `store.image()` (frozen / `IMAGE_MUTATED`).
7. Read the working state through `tx.doc`, `tx.image(id)`; pure helpers take a `DocumentView`.
8. Test: commit, check the result, `store.undo()` restores `documentHash(store)`, `redo()` gives it back; a no-op returns `undefined`.

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
