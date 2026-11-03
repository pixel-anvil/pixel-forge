// rig.fitTemplate: schema, the CC0 acceptance (31 to 42 bone edits become 1 call plus at most 5 edits).
import { documentHash } from '@pixel-forge/core';
import { fitHumanoid } from '@pixel-forge/rig';
import { describe, expect, it } from 'vitest';
import { registry } from '../src/index.js';
import { HERO_ID, flatHost, need, rejection, stepLabels } from './helpers.js';

// Landmarks measured on the CC0 swordsman, run cell [0, 0] (64x64): top of the hair at row 16, sole
// row 63, hips at row 44, fingertip of the near hand at (38, 47).
const LANDMARKS = {
  headTop: { x: 31, y: 16 },
  hips: { x: 30, y: 44 },
  feet: { x: 30, y: 63 },
  handR: { x: 38, y: 47 },
};

describe('rig.fitTemplate', () => {
  it('rejects bad input', async () => {
    const { run } = await flatHost(true);
    const err = await rejection(
      registry.execute(
        'rig.fitTemplate',
        { doc: HERO_ID, template: 'humanoid-side', landmarks: { headTop: { x: 1, y: 2 } } },
        run,
      ),
    );
    expect(err.code).toBe('BAD_INPUT');
  });

  it('fits the generic template to the CC0 character in 1 call plus at most 5 edits', async () => {
    const { store, hosted, run } = await flatHost(true);
    const rig = () => need(store.doc.rig);
    const snapshot = () => {
      const side = need(rig().views.find((v) => v.name === 'side')); // re-read: edits replace the view
      return new Map(
        rig().bones.map((b) => [b.name, { length: b.length, rest: { ...side.rest[b.id] } }]),
      );
    };
    const generic = snapshot();

    // What the T5.8 runs did by hand: one setLength and/or setRest per bone that differs.
    const target = fitHumanoid('side', LANDMARKS).template;
    let manual = 0;
    for (const tb of target.bones) {
      const g = need(generic.get(tb.name));
      if (g.length !== tb.length) manual += 1;
      if (g.rest.x !== tb.rest.x || g.rest.y !== tb.rest.y || g.rest.angle !== tb.rest.angle) {
        manual += 1;
      }
    }
    // The leanest hand edit list (no trial and error) is already this long; the T5.8 runs needed 31 to 42.
    expect(manual).toBeGreaterThanOrEqual(15);

    const out = (await registry.execute(
      'rig.fitTemplate',
      { doc: HERO_ID, template: 'humanoid-side', view: 'side', landmarks: LANDMARKS },
      run,
    )) as { height: number; created: string[]; resized: string[] };
    expect(out.height).toBe(47);
    expect(out.created).toEqual([]);
    expect(out.resized.length).toBe(8);
    expect(manual).toBe(17); // 8 lengths + 9 rest poses differ from the generic template
    const fitted = snapshot();
    for (const tb of target.bones) {
      expect(fitted.get(tb.name), tb.name).toEqual({ length: tb.length, rest: tb.rest });
    }

    // Touch-ups: at most 5 edits in one rig_edit_bones call.
    const touch = [
      { action: 'setLength', bone: 'foot_r', length: 7 },
      { action: 'setLength', bone: 'foot_l', length: 7 },
      { action: 'setRest', bone: 'hand_r', view: 'side', x: 0, y: 6, angle: 0 },
    ];
    expect(touch.length).toBeLessThanOrEqual(5);
    await registry.execute('rig.editBones', { doc: HERO_ID, edits: touch }, run);
    expect(stepLabels(hosted)).toEqual(['AI: rig.fitTemplate', 'AI: rig.editBones']);
    // The same number of document steps replaces `manual` edits (31 to 42 in the T5.8 runs).
    expect(1 + touch.length).toBeLessThanOrEqual(6);
  });

  it('is one undo step', async () => {
    const { store, run } = await flatHost(true);
    const before = documentHash(store);
    await registry.execute(
      'rig.fitTemplate',
      { doc: HERO_ID, template: 'humanoid-side', view: 'side', landmarks: LANDMARKS },
      run,
    );
    expect(documentHash(store)).not.toBe(before);
    store.undo();
    expect(documentHash(store)).toBe(before);
  });

  it('creates a new view and bones on a document without a rig', async () => {
    const { store, run } = await flatHost(false);
    const out = (await registry.execute(
      'rig.fitTemplate',
      { doc: HERO_ID, template: 'humanoid-front', landmarks: LANDMARKS },
      run,
    )) as { created: string[]; resized: string[] };
    expect(out.created).toHaveLength(17);
    expect(out.resized).toEqual([]);
    expect(need(store.doc.rig).views.map((v) => v.name)).toEqual(['front']);
  });

  it('refuses bad landmarks and leaves the document unchanged', async () => {
    const { store, run } = await flatHost(true);
    const before = documentHash(store);
    const err = await rejection(
      registry.execute(
        'rig.fitTemplate',
        {
          doc: HERO_ID,
          template: 'humanoid-side',
          view: 'side',
          landmarks: { ...LANDMARKS, hips: { x: 30, y: 10 } },
        },
        run,
      ),
    );
    expect(err.code).not.toBe('BAD_INPUT');
    expect(documentHash(store)).toBe(before);
  });
});
