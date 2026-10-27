import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  AngleQuantum,
  Animation,
  BoneKey,
  Cel,
  Document,
  Layer,
  Override,
  Palette,
  PartKey,
  Skin,
  type AuthoredAnimation,
  type GroupLayer,
  type ReferenceLayer,
  type Layer as LayerT,
} from '../src/index.js';
import { ids, minimalDoc } from './fixtures/src/minimal-doc.js';
import { at, failurePaths, jsonCopy, must, sortedJson } from './helpers.js';

const HASH = '0123456789abcdef'.repeat(4);

const doc = (): Document => jsonCopy(minimalDoc);

const authored = (d: Document): AuthoredAnimation => {
  const a = at(d.animations, 0);
  if ('mirrorOf' in a) throw new Error('expected an authored animation');
  return a;
};

const frame0 = (d: Document) => at(authored(d).frames, 0);
const handVariant = (d: Document) => at(at(must(d.rig).parts, 1).variants, 0);

describe('minimal-doc fixture', () => {
  it('round-trips parse -> JSON.stringify -> parse identically', () => {
    const parsed = Document.parse(minimalDoc);
    expect(parsed).toStrictEqual(minimalDoc);
    const json = JSON.stringify(parsed);
    const again = Document.parse(JSON.parse(json));
    expect(again).toStrictEqual(parsed);
    expect(JSON.stringify(again)).toBe(json);
  });

  it('round-trips through sorted-key JSON (the .pxf encoding) without losing order', () => {
    const sorted = sortedJson(minimalDoc);
    const parsed = Document.parse(JSON.parse(sorted));
    expect(parsed).toEqual(minimalDoc);
    expect(sortedJson(parsed)).toBe(sorted);
    expect(parsed.layers.map((l) => l.name)).toEqual(['body', 'ball']);
    expect(authored(parsed).frames.map((f) => f.id)).toEqual([ids.frame0, ids.frame1]);
  });

  it('is JSON-safe: no undefined values, so the copy is strictly equal', () => {
    expect(jsonCopy(minimalDoc)).toStrictEqual(minimalDoc);
  });

  it('stores the generator state after the last fixture id', () => {
    expect(minimalDoc.meta.ids).toEqual({ seed: 42, next: Object.keys(ids).length });
  });
});

describe('names (I7)', () => {
  const badNames = ['Body', 'hand r', '', 'a'.repeat(49), 'ü', 'run/left', 'x.y'];

  it('rejects invalid layer, group, bone, marker and event names', () => {
    for (const bad of badNames) {
      const d1 = doc();
      at(d1.layers, 1).name = bad;
      expect(failurePaths(Document, d1)).toContain('layers.1.name');

      const d2 = doc();
      authored(d2).group = bad;
      expect(failurePaths(Document, d2)).toContain('animations.0.group');

      const d3 = doc();
      at(must(d3.rig).bones, 0).name = bad;
      expect(failurePaths(Document, d3)).toContain('rig.bones.0.name');

      const d4 = doc();
      frame0(d4).events = [bad];
      expect(failurePaths(Document, d4)).toContain('animations.0.frames.0.events.0');
    }
    const d5 = doc();
    frame0(d5).markers = { Hand_R: { x: 0, y: 0 } };
    expect(failurePaths(Document, d5)).toContain('animations.0.frames.0.markers.Hand_R');
  });

  it('accepts names of 1 to 48 characters from [a-z0-9_-]', () => {
    for (const good of ['a', '0', 'hand_r', 'run-fast', 'a'.repeat(48)]) {
      const d = doc();
      at(d.layers, 1).name = good;
      expect(Document.safeParse(d).success).toBe(true);
    }
  });

  it('reserves the direction key "default" and the skin key "base"', () => {
    const d1 = doc();
    authored(d1).direction = 'default';
    expect(failurePaths(Document, d1)).toContain('animations.0.direction');

    const d2 = doc();
    at(d2.skins, 0).name = 'base';
    expect(failurePaths(Document, d2)).toContain('skins.0.name');
  });
});

describe('integers and finite angles (I5)', () => {
  it('rejects a non-integer pivot', () => {
    const d = doc();
    handVariant(d).pivot.x = 1.5;
    expect(failurePaths(Document, d)).toEqual(['rig.parts.1.variants.0.pivot.x']);
  });

  it('rejects non-integer origin, cel offset, key offset and root motion', () => {
    const d1 = doc();
    d1.meta.origin.y = 30.5;
    expect(failurePaths(Document, d1)).toEqual(['meta.origin.y']);

    const d2 = doc();
    const ball = at(d2.layers, 1);
    if (ball.kind !== 'pixel') throw new Error('expected the ball pixel layer');
    ball.cels[ids.frame0] = { imageId: ids.imgBall, offset: { x: 0.5, y: 0 }, opacity: 255 };
    expect(failurePaths(Document, d2)).toContain(`layers.1.cels.${ids.frame0}.offset.x`);

    const d3 = doc();
    frame0(d3).boneKeys[ids.boneRoot] = { offset: { x: 0, y: -0.25 } };
    expect(failurePaths(Document, d3)).toContain(
      `animations.0.frames.0.boneKeys.${ids.boneRoot}.offset.y`,
    );

    const d4 = doc();
    frame0(d4).rootMotion.dx = 2.5;
    expect(failurePaths(Document, d4)).toContain('animations.0.frames.0.rootMotion.dx');
  });

  it('rejects NaN and infinite angles', () => {
    const d1 = doc();
    frame0(d1).boneKeys[ids.boneTorso] = { angle: Number.NaN };
    expect(failurePaths(Document, d1)).toContain(
      `animations.0.frames.0.boneKeys.${ids.boneTorso}.angle`,
    );

    const d2 = doc();
    const rest = must(at(must(d2.rig).views, 0).rest[ids.boneHand]);
    rest.angle = Number.POSITIVE_INFINITY;
    expect(failurePaths(Document, d2)).toContain(`rig.views.0.rest.${ids.boneHand}.angle`);

    const d3 = doc();
    handVariant(d3).drawnAngle = Number.NaN;
    expect(failurePaths(Document, d3)).toEqual(['rig.parts.1.variants.0.drawnAngle']);

    expect(BoneKey.safeParse({ angle: -720.5 }).success).toBe(true);
  });

  it('bounds opacities, durations and colours', () => {
    expect(
      failurePaths(Cel, { imageId: ids.imgBall, offset: { x: 0, y: 0 }, opacity: 256 }),
    ).toEqual(['opacity']);
    const d1 = doc();
    at(d1.layers, 0).opacity = -1;
    expect(failurePaths(Document, d1)).toContain('layers.0.opacity');

    const d2 = doc();
    frame0(d2).durationMs = 0;
    expect(failurePaths(Document, d2)).toContain('animations.0.frames.0.durationMs');

    const p = at(doc().palettes, 0);
    expect(Palette.safeParse({ ...p, colors: [[0, 0, 256, 255]] }).success).toBe(false);
    expect(Palette.safeParse({ ...p, colors: [[0, 0, 0]] }).success).toBe(false);
    const full = Array.from({ length: 257 }, () => [0, 0, 0, 255]);
    expect(Palette.safeParse({ ...p, colors: full }).success).toBe(false);
    expect(Palette.safeParse({ ...p, colors: full.slice(1) }).success).toBe(true);
  });
});

describe('part keys and bone keys (R-15)', () => {
  it("accepts the 'auto' variant and variant ids", () => {
    expect(PartKey.parse({ variant: 'auto' })).toEqual({ variant: 'auto' });
    expect(PartKey.safeParse({ variant: ids.varHandOpen }).success).toBe(true);
    expect(frame0(Document.parse(minimalDoc)).partKeys[ids.partHand]).toEqual({ variant: 'auto' });
  });

  it('rejects other variant strings and ids of another kind', () => {
    for (const bad of ['automatic', 'Auto', ids.partHand, ids.layHand]) {
      expect(PartKey.safeParse({ variant: bad }).success).toBe(false);
    }
  });

  it('rejects empty keys', () => {
    expect(BoneKey.safeParse({}).success).toBe(false);
    expect(BoneKey.safeParse({ interp: 'step' }).success).toBe(false);
    expect(BoneKey.safeParse({ flipX: false }).success).toBe(true);
    expect(PartKey.safeParse({}).success).toBe(false);
    expect(PartKey.safeParse({ z: -3 }).success).toBe(true);
    expect(PartKey.safeParse({ visible: false }).success).toBe(true);
  });

  it('rejects unknown interpolation modes and unknown key fields', () => {
    expect(BoneKey.safeParse({ angle: 1, interp: 'cubic' }).success).toBe(false);
    expect(BoneKey.safeParse({ angle: 1, variant: 'auto' }).success).toBe(false);
  });
});

describe('layer tree', () => {
  it('rejects unknown layer kinds, at the root and inside groups', () => {
    const d1 = doc();
    (at(d1.layers, 1) as { kind: string }).kind = 'mask';
    expect(failurePaths(Document, d1)).toEqual(['layers.1.kind']);

    const d2 = doc();
    const group = at(d2.layers, 0);
    if (group.kind !== 'group') throw new Error('expected the body group');
    (at(group.children, 0) as { kind: string }).kind = 'bone';
    expect(failurePaths(Document, d2)).toEqual(['layers.0.children.0.kind']);

    expect(
      Layer.safeParse({ id: ids.layBall, name: 'x', visible: true, opacity: 255, export: true })
        .success,
    ).toBe(false);
  });

  it('keeps each kind to its own fields', () => {
    const base = { id: ids.layTorso, name: 'torso', visible: true, opacity: 255, export: true };
    expect(Layer.safeParse({ kind: 'part', ...base }).success).toBe(true);
    expect(Layer.safeParse({ kind: 'part', ...base, cels: {} }).success).toBe(false);
    expect(Layer.safeParse({ kind: 'group', ...base }).success).toBe(false);
    expect(Layer.safeParse({ kind: 'reference', ...base, export: false, cels: {} }).success).toBe(
      true,
    );
    expect(
      Layer.safeParse({ kind: 'pixel', ...base, cels: { [ids.layBall]: { linkTo: ids.frame0 } } })
        .success,
    ).toBe(false);
    expect(
      Layer.safeParse({
        kind: 'group',
        ...base,
        children: [{ kind: 'group', ...base, id: ids.layBody, children: [] }],
      }).success,
    ).toBe(true);
  });

  it('never exports a reference layer: export must be false (spec 3.4.13)', () => {
    const ref = {
      kind: 'reference',
      id: ids.layTorso,
      name: 'trace',
      visible: true,
      opacity: 255,
      cels: {},
    };
    expect(Layer.safeParse({ ...ref, export: false }).success).toBe(true);
    expect(failurePaths(Layer, { ...ref, export: true })).toEqual(['export']);
    expect(failurePaths(Layer, { ...ref })).toEqual(['export']);
    // Other kinds still take either value.
    expect(Layer.safeParse({ ...ref, kind: 'pixel', export: true }).success).toBe(true);
    expectTypeOf<z.infer<typeof ReferenceLayer>['export']>().toEqualTypeOf<false>();
  });

  it('matches the hand-written recursive GroupLayer type', () => {
    expectTypeOf<z.infer<typeof GroupLayer>>().toEqualTypeOf<GroupLayer>();
    expectTypeOf<z.infer<typeof Layer>>().toEqualTypeOf<LayerT>();
  });
});

describe('cels', () => {
  it('is either an image cel or a link, never both', () => {
    const image = { imageId: ids.imgBall, offset: { x: 1, y: 2 }, opacity: 128 };
    expect(Cel.safeParse(image).success).toBe(true);
    expect(Cel.safeParse({ linkTo: ids.frame0 }).success).toBe(true);
    expect(Cel.safeParse({ ...image, linkTo: ids.frame0 }).success).toBe(false);
    expect(Cel.safeParse({ linkTo: ids.frame0, opacity: 255 }).success).toBe(false);
    expect(Cel.safeParse({ linkTo: ids.imgBall }).success).toBe(false);
    expect(
      Cel.safeParse({ imageId: ids.layBall, offset: { x: 0, y: 0 }, opacity: 255 }).success,
    ).toBe(false);
  });
});

describe('animations', () => {
  it('keeps mirrors free of frames, loop and post-passes', () => {
    const mirror = at(doc().animations, 1);
    expect(Animation.safeParse(mirror).success).toBe(true);
    expect(Animation.safeParse({ ...mirror, frames: [] }).success).toBe(false);
    expect(Animation.safeParse({ ...mirror, loop: 'once' }).success).toBe(false);
    expect(Animation.safeParse({ ...authored(doc()), mirrorOf: ids.animRunRight }).success).toBe(
      false,
    );
  });

  it('needs at least one frame in an authored animation', () => {
    expect(Animation.safeParse({ ...authored(doc()), frames: [] }).success).toBe(false);
  });

  it('accepts angle quanta that are multiples of 0.25 dividing 360, up to 90', () => {
    for (const q of [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 5, 7.5, 15, 22.5, 45, 90]) {
      expect(AngleQuantum.safeParse(q).success, String(q)).toBe(true);
    }
    for (const q of [0, -1, 0.1, 0.3, 7, 100, 360, Number.NaN]) {
      expect(AngleQuantum.safeParse(q).success, String(q)).toBe(false);
    }
  });

  it('rejects unknown loop modes', () => {
    expect(Animation.safeParse({ ...authored(doc()), loop: 'bounce' }).success).toBe(false);
  });
});

describe('overrides', () => {
  const base = {
    id: ids.ovrPart,
    frameId: ids.frame0,
    target: { partId: ids.partHand },
    anchor: { x: 0, y: 0 },
    baseHash: HASH,
  };

  it('needs set or erase', () => {
    expect(Override.safeParse(base).success).toBe(false);
    expect(Override.safeParse({ ...base, set: ids.imgPartFix }).success).toBe(true);
    expect(Override.safeParse({ ...base, erase: ids.imgPartFix }).success).toBe(true);
  });

  it("targets a part or 'final'", () => {
    expect(Override.safeParse({ ...base, set: ids.imgPartFix, target: 'final' }).success).toBe(
      true,
    );
    expect(Override.safeParse({ ...base, set: ids.imgPartFix, target: 'Final' }).success).toBe(
      false,
    );
    expect(
      Override.safeParse({ ...base, set: ids.imgPartFix, target: { partId: ids.boneHand } })
        .success,
    ).toBe(false);
  });

  it('requires baseHash to be exactly 64 lower-case hex digits (SHA-256)', () => {
    const parse = (baseHash: string) =>
      Override.safeParse({ ...base, set: ids.imgPartFix, baseHash }).success;
    expect(parse(HASH)).toBe(true);
    expect(parse('XYZ12345'.repeat(8))).toBe(false);
    expect(parse(HASH.toUpperCase())).toBe(false);
    expect(parse('0123456789abcdef')).toBe(false);
    expect(parse(HASH.slice(1))).toBe(false);
    expect(parse(HASH + '0')).toBe(false);
    expect(parse('')).toBe(false);
  });
});

describe('skins', () => {
  const remap = { id: ids.skinRival, name: 'rival' };

  it('accepts a sorted remap or a palette', () => {
    expect(Skin.safeParse({ ...remap, remap: [] }).success).toBe(true);
    expect(
      Skin.safeParse({
        ...remap,
        remap: [
          [5, 7],
          [6, 8],
        ],
      }).success,
    ).toBe(true);
    expect(Skin.safeParse({ ...remap, paletteId: ids.palRival }).success).toBe(true);
  });

  it('rejects unsorted or duplicate sources, out-of-range indices and mixed forms', () => {
    expect(
      Skin.safeParse({
        ...remap,
        remap: [
          [6, 8],
          [5, 7],
        ],
      }).success,
    ).toBe(false);
    expect(
      Skin.safeParse({
        ...remap,
        remap: [
          [5, 7],
          [5, 8],
        ],
      }).success,
    ).toBe(false);
    expect(Skin.safeParse({ ...remap, remap: [[5, 256]] }).success).toBe(false);
    expect(Skin.safeParse({ ...remap, remap: [[5, -1]] }).success).toBe(false);
    expect(Skin.safeParse({ ...remap, remap: [], paletteId: ids.palRival }).success).toBe(false);
  });
});

describe('skin remap canonical form', () => {
  const remap = { id: ids.skinRival, name: 'rival' };

  it('rejects identity pairs [n, n], alone or among real pairs', () => {
    expect(Skin.safeParse({ ...remap, remap: [[5, 5]] }).success).toBe(false);
    expect(
      Skin.safeParse({
        ...remap,
        remap: [
          [3, 4],
          [5, 5],
          [7, 8],
        ],
      }).success,
    ).toBe(false);
    expect(
      Skin.safeParse({
        ...remap,
        remap: [
          [0, 0],
          [255, 255],
        ],
      }).success,
    ).toBe(false);
    expect(failurePaths(Skin, { ...remap, remap: [[5, 5]] })).toContain('remap');
  });

  it('accepts a pair that changes the index, including to a lower one', () => {
    expect(Skin.safeParse({ ...remap, remap: [[5, 4]] }).success).toBe(true);
  });
});

describe('document strictness', () => {
  it('rejects unknown fields at every level', () => {
    expect(failurePaths(Document, { ...doc(), extra: 1 })).toEqual(['']);
    const d = doc();
    (d.meta as Record<string, unknown>).modified = '2026-01-01T00:00:00Z';
    expect(failurePaths(Document, d)).toEqual(['meta']);
  });

  it('rejects explicit undefined for optional fields', () => {
    expect(Document.safeParse({ ...doc(), activePaletteId: undefined }).success).toBe(false);
    expect(Document.safeParse({ ...doc(), rig: undefined }).success).toBe(false);
  });

  it('accepts a document without rig or active palette', () => {
    const d = doc();
    delete d.rig;
    delete d.activePaletteId;
    d.animations = [authored(d)];
    expect(Document.safeParse(d).success).toBe(true);
  });

  it('rejects other schema versions and ids of the wrong kind', () => {
    expect(failurePaths(Document, { ...doc(), meta: { ...doc().meta, schemaVersion: 2 } })).toEqual(
      ['meta.schemaVersion'],
    );
    const d = doc();
    handVariant(d).imageId = ids.layHand as unknown as typeof ids.imgHandOpen;
    expect(failurePaths(Document, d)).toEqual(['rig.parts.1.variants.0.imageId']);
  });

  it('rejects a part without variants and a view without directions', () => {
    const d1 = doc();
    at(must(d1.rig).parts, 0).variants = [];
    expect(failurePaths(Document, d1)).toEqual(['rig.parts.0.variants']);
    const d2 = doc();
    at(must(d2.rig).views, 0).directions = [];
    expect(failurePaths(Document, d2)).toEqual(['rig.views.0.directions']);
  });
});
