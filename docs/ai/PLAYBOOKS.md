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
An op is one file in `packages/ops/src/ops/` that calls `defineOp`. The registry (`packages/ops/src/registry.ts`) does the rest: it parses the input, resolves `doc`, opens **one transaction = one undo step** labelled `AI: <op name>`, checks the output, refuses changes that make `validate()` report new errors, and turns every thrown error into an `OpError`. The generators turn the op into the MCP tool, the CLI subcommand and `docs/contracts/OPERATIONS.md`. Exemplars: `rig-set-pose.ts` (mutate), `doc-summary.ts` (read), `doc-open.ts` (io). API: `packages/ops/README.md`.

**Steps** (the worked example below is `frame.duplicate`; replace names, keep the shape):

1. **Find the function the op wraps** (core frame ops, `rig-edit.ts`, overrides, lint, io) and read its README section. Most ops are a thin wrapper: they pass `ctx.tx` and the refs straight through. Never re-implement document logic in `ops`.
2. **Choose the safety class**: `read` (changes nothing), `mutate` (changes one document; undoable), `destructive` (like mutate but drastic, e.g. bake: the registry adds `confirm` and refuses without `"confirm": true`; never declare `confirm` yourself), `io` (files through `ctx.host.fs`; may be `async`).
3. **Create** `packages/ops/src/ops/<area>-<verb>.ts` (file name in kebab case; op name `area.verbNoun`, e.g. `frame.duplicate`, `rig.setPivot`). Use the template below:
   - `input`: `z.strictObject({...})`, first field `doc: DocRef` for any op on a document; take references with the shared schemas from `../refs.js` (`AnimRef`, `FrameRef`, `LayerRef`, `BoneRef`, `PartRef`, `ViewRef`, `VariantRef`); `.describe('...')` **every** field (a test enforces it); use `z.record(z.string(), X)` for maps, never schema's `record` helper or `z.custom` (no JSON Schema).
   - `output`: `z.strictObject({...})` of plain JSON (ids, indices, names, counts); describe the fields.
   - `summary`: one imperative line, at most 200 characters, with units (`deg clockwise`, `int px`). `description`: optional, when to use it and what to call next. The whole MCP tool description (summary, description, `confirmText`, safety note, conventions, first example) must stay **at most 800 characters**; `packages/server/test/mcp-tools.test.ts` fails otherwise, so do not repeat what the field `.describe()` texts already say.
   - `examples`: at least one, against the hero fixture (`doc: 'doc_g1ed5q'`, animation `{ group: 'default' }`, frame `0`, bones like `upper_arm_r`, parts like `head`, `lower_arm_r` with variants `default`, `sleeve`). They are checked against the schemas when the module loads, and the first one is shown in the MCP tool description.
4. **Write the handler** (synchronous unless `io`):
   - change the document only through `ctx.tx` (pass it to core functions: `duplicateFrame(ctx.tx, ...)`); never call `store.begin`, `commit`, `cancel`, `undo` (except history ops, see below);
   - read through `ctx.doc` / `ctx.view` (they see your own edits so far); render with `ctx.renderFrame(anim, frame, opts)` (it passes the host's renderer, KNOWN_ISSUES CORE-03);
   - resolve names with the resolvers in `../refs.js` (`resolveAuthoredAnimation`, `resolveFrame`, `resolveLayer`, `resolveBone`, `resolvePart`, `resolveView`, `resolveVariant`, `viewForAnimation`, `requireRig`); they throw `NOT_FOUND` / `AMBIGUOUS` / `REFUSED` with the right details;
   - let core, rig and io errors propagate: `toOpError` maps them (core `BAD_ARGUMENT` `unknown-*` -> `NOT_FOUND`, other reasons -> `REFUSED`, KNOWN_ISSUES CORE-02). Throw `new OpError('REFUSED', message, { reason: 'kebab-case' })` only for refusals of your own; `BAD_INPUT` for cross-field input rules zod cannot express;
   - return exactly the output shape (the registry rejects anything else as `INTERNAL`).
5. **Register** it: import and append to `ALL_OPS` in `packages/ops/src/ops/index.ts`, add it to the `export { ... } from './<file>.js'` lines there, and to the `./ops/index.js` export list in `packages/ops/src/index.ts`.
6. **Test** in `packages/ops/test/<area>-<verb>.test.ts` with the helpers in `test/helpers.ts` (`openHero`, `rejection`, `need`, `HERO_ID`): one **schema test** (bad input -> `BAD_INPUT` with the issue path) and one **example test** (run `examples[0]` on the hero; for mutate ops check the history has exactly one entry `AI: <op>` and that `store.undo()` restores `documentHash`). Add a test per refusal you throw yourself.
7. **MCP scenario**: add one entry for the new tool to `SCENARIOS` in `packages/server/test/mcp-scenarios.ts` (how to set up a document, the call, and whether it records one `AI: <op>` undo entry or why not); `mcp-tools.test.ts` fails when a listed tool has none. `pf://` resources need nothing unless the op adds a new kind of document data.
8. `pnpm gen` (rewrites `packages/ops/generated/*.json` and `docs/contracts/OPERATIONS.md`; commit them), `pnpm changeset`, then `pnpm vitest run --project ops`, `pnpm lint`, `pnpm typecheck`, `pnpm gen:check`.

**Worked example** (compiled and tested verbatim during T5.1). `packages/ops/src/ops/frame-duplicate.ts`:

```ts
/**
 * `frame.duplicate`: copy one frame of an animation right after itself.
 * @packageDocumentation
 */
import { duplicateFrame } from '@pixel-forge/core';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { AnimRef, DocRef, FrameRef, resolveAuthoredAnimation, resolveFrame } from '../refs.js';

/** `frame.duplicate` (MCP `frame_duplicate`, CLI `pf frame duplicate`). */
export const frameDuplicate = defineOp({
  name: 'frame.duplicate',
  safety: 'mutate',
  summary: 'Duplicate one frame; the copy goes right after it, with linked cels and copied keys.',
  description:
    'Cels of the copy link to the source frame (edit one, both change). Bone keys, part keys, markers, events, root motion, duration and overrides are copied.',
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef,
  }),
  output: z.strictObject({
    frameId: z.string().describe('Id of the new frame.'),
    frameIndex: z.int().describe('Index of the new frame (source index + 1).'),
    frames: z.int().describe('Frame count of the animation afterwards.'),
  }),
  examples: [
    {
      title: 'Duplicate frame 0 of the hero',
      input: { doc: 'doc_g1ed5q', animation: { group: 'default' }, frame: 0 },
    },
  ],
  handler: (ctx, input) => {
    const frameId = duplicateFrame(ctx.tx, input.animation, input.frame);
    const { animation } = resolveAuthoredAnimation(ctx.doc, input.animation);
    const { index } = resolveFrame(animation, frameId);
    return { frameId, frameIndex: index, frames: animation.frames.length };
  },
});
```

`packages/ops/src/ops/index.ts` (additions):

```ts
import { frameDuplicate } from './frame-duplicate.js';
export { frameDuplicate } from './frame-duplicate.js';
export const ALL_OPS: readonly AnyOp[] = [docOpen, docSummary, frameDuplicate, rigSetPose];
```

`packages/ops/test/frame-duplicate.test.ts`:

```ts
// frame.duplicate: schema test and example test.
import { documentHash } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { frameDuplicate, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

describe('frame.duplicate', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const err = await rejection(
      registry.execute('frame.duplicate', { doc: HERO_ID, animation: { group: 'default' } }, run),
    );
    expect(err.code).toBe('BAD_INPUT');
    expect(err.details.issues).toEqual([{ path: 'frame', message: expect.any(String) as string }]);
  });

  it('runs its example as one undo step', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const out = await registry.execute(
      'frame.duplicate',
      need(frameDuplicate.examples[0]).input,
      run,
    );
    expect(out).toEqual({ frameId: expect.any(String) as string, frameIndex: 1, frames: 2 });
    expect(hero.store.historyInfo().entries.map((e) => e.label)).toEqual(['AI: frame.duplicate']);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('reports an unknown frame', async () => {
    const { run } = await openHero();
    const err = await rejection(
      registry.execute(
        'frame.duplicate',
        { doc: HERO_ID, animation: { group: 'default' }, frame: 5 },
        run,
      ),
    );
    expect(err).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'frame' } });
  });
});
```

**Special cases**

| Case | What to do |
| --- | --- |
| History ops (`doc.undo`, `doc.redo`) | `safety: 'mutate'`, `transaction: false`; the handler calls `ctx.document.store.undo()` / `redo()` (they return `undefined` when there is nothing to do). |
| `destructive` | Nothing extra: the registry adds `confirm` to the schemas and refuses with `CONFIRM_REQUIRED`. Examples omit `confirm` (the docs add it). |
| `io` | `handler: async (ctx, input) => ...`; paths through `ctx.host.resolvePath(input.path)`, bytes through `ctx.host.fs`, time through `ctx.host.clock`; change the document at most once with `ctx.transact((tx) => ...)`, as the last step. |
| Ops without a document (`doc.create`, `doc.list`) | No `doc` field (only `read` and `io` may omit it); use `ctx.host` (`adopt`, `list`, `get`). |
| MCP name from spec 8 differs | `mcp: { name: 'undo' }` (also `redo`, `lint`, `import_file`, `export`); `cli: { command: ['lint'] }` for a CLI name; `hidden: true` to leave a transport out. |
| Image outputs (renders) | Put the PNG in a top-level `image` field shaped `ImageOutput` (`{mimeType: 'image/png', data: <base64>, width, height}`, `pngOutput()` in `src/image-output.ts`), long edge at most 1568; transports turn it into image content (T5.5) or a file. Keep the rest of the JSON compact. See `render-frame.ts`. |

**Gotchas (from T5.2a, 2026-11-01):**
- The worked example `frame.duplicate` now lives in the tree (`packages/ops/src/ops/frame-duplicate.ts`); copy it.
- If an example needs a precondition the hero lacks (e.g. `frame.delete` on a one-frame animation), run the setup op first in the example test.
- Readonly tuples/arrays returned by rig/core must be copied (`[...x]`) before they go into a zod output.
- `pnpm changeset` is interactive; write `.changeset/<name>.md` by hand (frontmatter `'@pixel-forge/<pkg>': minor`, then one line).

**Gotchas (from T5.2b, 2026-11-01):**
- Vitest resolves `@pixel-forge/*` through `dist`: run `pnpm build` after changing another package, or the ops tests see the old code.
- `ops` may not import `png` or `raster` (spec 6.2). Document logic that needs pixels goes into `core` (`paintOverlapTx`, `setColorMode`); a PNG's size is read from its IHDR (`pngSize` in `src/file-io.ts`); `toOpError` recognises `PngError` by name. `ops` has no `TextEncoder`: use `utf8()` from `src/file-io.ts`.
- `io` ops: read and decode first, call `ctx.transact` last (OPS-01), and build the output from its result. Files only through `ctx.host.fs`; `saveAtomic` writes the temp file and renames.
- `destructive` ops may set `confirmText`: it is added to the tool description and to the `CONFIRM_REQUIRED` message. The text cannot depend on the input (`rig.bake` asks for confirmation in mode `new` too).
- Overrides need the host's `PartRenderer`: use `partRenderer(ctx)` (falls back to a private renderer for a plain `RigRenderer`).
- Examples that need a flat layer or another precondition: `flatHost()` in `test/helpers.ts` builds a document with the hero's id (CC0 swordsman cells, layer `body`, optional rig), so the example input runs unchanged. `store.clearHistory()` after setup keeps the undo assertions simple.
- `OverlapJoint.boneId` is the **painted** part's bone, not the joint's child bone; filter joints by `bone` (the child's name).

## Add a lint rule
Rules live in `packages/lint/src/rules.ts`; `lint(view, opts)` runs them in `RULE_IDS` order.
1. Add the id to `RULE_IDS` in `packages/lint/src/types.ts` (`area.name`; the position fixes the report order).
2. In `rules.ts` write `const myRule: LintRule = { id, severity, summary, run(ctx) { ... } }` and add it to `ALL`. `run` returns `LintFinding[]` in document order (animation, frame, skin, then pixel y then x) and must be a pure function of `ctx`.
3. Use the context: `ctx.frames()` / `ctx.skins()` for what to check, `ctx.render(frame, skin)` for the (memoised) render output (it already uses `createRigRenderer`, and a failing render is recorded as `lint.renderError`, so return nothing for `undefined`), `ctx.doc` / `ctx.view` for the document, `ctx.cap(pixels)` to cap pixel lists. Rules on pixels check the render output, never the layers (invariant I2).
4. A finding is `{rule, severity, location, message, data}`: `location` names the layer, animation, frame, pixel or override id; `data` is JSON for machines. Do not hide a different failure inside an existing rule; give it its own id (see `rig.overrideError`).
5. Tests in `packages/lint/test/lint.test.ts`: one fixture that triggers the rule and one that does not (`test/fixtures.ts` builds small documents), plus `enable`/`disable` behaviour if the rule is special.
6. Document the rule and its `data` keys in `packages/lint/README.md`, and add a changeset.

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

## Add or run a W-scenario

`pnpm scenarios` (after `pnpm build`; CI runs it after `pnpm verify` on both OSes) runs W2, W2-joint, W2b, W3-manual and W4-CLI. Each is a `scenarios/<name>.steps.json` in the `pf check` format (`packages/cli/README.md`), run by the real `pf` bundle in a temp folder. `scripts/scenarios.mjs` copies the script and its inputs there, does the non-op setup (for example the 3-px edit of an exported PNG for W4-CLI), runs `pf`, and checks what a step script cannot: counts, the hand-written oracles in `fixtures/joint/`, and the CLI round trip. Nothing is written into the repo. One line per scenario is printed, exit 1 on any failure; the temp folder is kept on failure (or with `PF_SCENARIOS_KEEP=1`) and holds each `report.json` and the rendered PNGs.

To add one: write the steps file, add a function to `scripts/scenarios.mjs` that calls `workspace(...)` and `check(...)`, and register it in `SCENARIOS_RUN`. Prefer an `expect` in the script; put a check in the runner only when it needs a count, a file or a second process. Inputs come from `fixtures/` (synthetic or CC0 only, never pack art). Bases for `pf override import` must come from `pf export` at scale 1 (CLI-05).

## Add a migration
Filled in by card T4.2.

## Add a palette preset
Filled in by card T1.3.

## Dispatch and verify a card (orchestrator)
Filled in by the orchestrator; the procedure is in `docs/02-plan.md` section 0.1 until then.
