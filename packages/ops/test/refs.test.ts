// Reference resolution: id first, then name; NOT_FOUND lists what exists; AMBIGUOUS lists ids.
import { describe, expect, it } from 'vitest';
import {
  OpError,
  animationLabel,
  partName,
  requireRig,
  resolveAnimation,
  resolveAuthoredAnimation,
  resolveBone,
  resolveFrame,
  resolveLayer,
  resolvePart,
  resolveVariant,
  resolveView,
  viewForAnimation,
  walkLayers,
} from '../src/index.js';
import type { ReadonlyDocument } from '../src/index.js';
import { need, openHero } from './helpers.js';

const fails = (fn: () => unknown): OpError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof OpError) return e;
    throw e;
  }
  throw new Error('expected an OpError');
};

async function heroDoc(): Promise<ReadonlyDocument> {
  const { hero } = await openHero();
  hero.store.transact('Setup', (tx) => {
    const a = tx.newId('layer');
    const g = tx.newId('layer');
    const b = tx.newId('layer');
    const base = { visible: true, opacity: 255, export: true } as const;
    tx.update((d) => {
      d.layers.push(
        { kind: 'pixel', id: a, name: 'shadow', ...base, cels: {} },
        {
          kind: 'group',
          id: g,
          name: 'fx',
          ...base,
          children: [{ kind: 'pixel', id: b, name: 'shadow', ...base, cels: {} }],
        },
      );
    });
  });
  return hero.store.doc;
}

describe('refs', () => {
  it('resolves animations and frames', async () => {
    const doc = await heroDoc();
    const anim = need(doc.animations[0]);
    expect(resolveAnimation(doc, { group: 'default' }).index).toBe(0);
    expect(resolveAnimation(doc, { id: anim.id }).animation).toBe(anim);
    expect(animationLabel({ group: 'run', direction: 'side' })).toBe('run/side');
    const authored = resolveAuthoredAnimation(doc, { group: 'default' }).animation;
    const frame = need(authored.frames[0]);
    expect(resolveFrame(authored, 0).frame).toBe(frame);
    expect(resolveFrame(authored, frame.id).index).toBe(0);
    expect(fails(() => resolveFrame(authored, 'frm_none' as never)).details).toMatchObject({
      kind: 'frame',
      count: 1,
    });
    expect(fails(() => resolveAnimation(doc, { id: 'anm_none' as never })).message).toMatch(
      /available: default/,
    );
  });

  it('resolves layers by id, name or path, and reports ambiguity', async () => {
    const doc = await heroDoc();
    const all = walkLayers(doc);
    expect(all.map((l) => l.path)).toContain('fx/shadow');
    const nested = need(all.find((l) => l.path === 'fx/shadow'));
    expect(resolveLayer(doc, 'fx/shadow')).toEqual(nested);
    expect(resolveLayer(doc, nested.layer.id)).toEqual(nested);
    expect(resolveLayer(doc, 'head').layer.kind).toBe('part');
    const amb = fails(() => resolveLayer(doc, 'shadow'));
    expect(amb.code).toBe('AMBIGUOUS');
    expect(amb.details.candidates).toHaveLength(2);
    const nf = fails(() => resolveLayer(doc, 'cape'));
    expect(nf).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'layer', ref: 'cape' } });
  });

  it('resolves bones, parts, views and variants', async () => {
    const doc = await heroDoc();
    const rig = requireRig(doc);
    const bone = resolveBone(doc, 'upper_arm_r');
    expect(resolveBone(doc, bone.id)).toBe(bone);
    const head = resolvePart(doc, 'head');
    expect(head.name).toBe('head');
    expect(resolvePart(doc, head.part.id).part).toBe(head.part);
    expect(resolvePart(doc, head.part.layerId).part).toBe(head.part);
    expect(partName(doc, head.part)).toBe('head');
    const view = resolveView(doc, 'side');
    expect(resolveView(doc, view.id)).toBe(view);
    expect(viewForAnimation(doc, {})).toBe(view);
    expect(viewForAnimation(doc, { direction: 'side' })).toBe(view);
    expect(fails(() => viewForAnimation(doc, { direction: 'up' }))).toMatchObject({
      code: 'NOT_FOUND',
      message: 'no rig view draws direction "up"',
      details: { kind: 'view', available: ['side (side)'] },
    });
    const forearm = resolvePart(doc, 'lower_arm_r').part;
    const sleeve = resolveVariant(forearm, 'sleeve', view.id);
    expect(resolveVariant(forearm, sleeve.id)).toBe(sleeve);
    expect(resolveVariant(forearm, 'sleeve')).toBe(sleeve);
    expect(rig.parts.length).toBeGreaterThan(10);
    expect(fails(() => resolveView(doc, 'front')).details.available).toEqual(['side']);
  });

  it('prefers the animation view for variant names shared across views', () => {
    const part = {
      id: 'prt_a',
      boneId: 'bon_a',
      layerId: 'lay_a',
      variants: [
        {
          id: 'var_1',
          name: 'default',
          viewId: 'viw_side',
          imageId: 'img_1',
          pivot: { x: 0, y: 0 },
          tags: [],
        },
        {
          id: 'var_2',
          name: 'default',
          viewId: 'viw_front',
          imageId: 'img_2',
          pivot: { x: 0, y: 0 },
          tags: [],
        },
      ],
    } as never;
    expect(resolveVariant(part, 'default', 'viw_front').id).toBe('var_2');
    expect(fails(() => resolveVariant(part, 'default')).code).toBe('AMBIGUOUS');
  });

  it('never falls back to the variants of another view', () => {
    const variant = (id: string, name: string, viewId: string) => ({
      id,
      name,
      viewId,
      imageId: 'img_1',
      pivot: { x: 0, y: 0 },
      tags: [],
    });
    const part = {
      id: 'prt_a',
      boneId: 'bon_a',
      layerId: 'lay_a',
      variants: [
        variant('var_1', 'default', 'viw_side'),
        variant('var_2', 'default', 'viw_front'),
        variant('var_3', 'sleeve', 'viw_front'),
      ],
    } as never;
    expect(resolveVariant(part, 'sleeve', 'viw_front').id).toBe('var_3');
    expect(resolveVariant(part, 'var_3', 'viw_side').id).toBe('var_3'); // an id is global
    expect(fails(() => resolveVariant(part, 'sleeve', 'viw_side'))).toMatchObject({
      code: 'NOT_FOUND',
      details: { kind: 'variant', ref: 'sleeve', available: ['default'] },
    });
  });

  it('refuses rig refs on a document without a rig', async () => {
    const { hero } = await openHero();
    hero.store.transact('Drop rig', (tx) => {
      tx.update((d) => {
        delete d.rig;
      });
    });
    const doc = hero.store.doc;
    for (const fn of [
      () => resolveBone(doc, 'x'),
      () => resolvePart(doc, 'x'),
      () => resolveView(doc, 'x'),
      () => viewForAnimation(doc, {}),
    ]) {
      expect(fails(fn).details.reason).toBe('no-rig');
    }
  });

  it('reports a rig without views', async () => {
    const { hero } = await openHero();
    hero.store.transact('No views', (tx) => {
      tx.update((d) => {
        if (d.rig !== undefined) d.rig.views = [];
      });
    });
    expect(fails(() => viewForAnimation(hero.store.doc, {})).message).toBe('the rig has no views');
  });
});
