import type { BoneId, LayerId } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROPORTIONS,
  HUMANOID_BONES,
  bindByOverlap,
  DEFAULT_VARIANT_NAME,
  evaluatePose,
  humanoidBack,
  humanoidFront,
  humanoidSide,
  parsePartLayerName,
  partLayerName,
  type PartShape,
  type SkeletonTemplate,
} from '../src/index.js';
import { errorCode, makeAnim } from './helpers.js';

const bid = (n: string): BoneId => `bon_${n}` as BoneId;
const lid = (n: string): LayerId => `lay_${n}` as LayerId;

function toRig(t: SkeletonTemplate) {
  const bones = t.bones.map((b) => ({
    id: bid(b.name),
    ...(b.parent === undefined ? {} : { parentId: bid(b.parent) }),
    length: b.length,
  }));
  const rest: Record<BoneId, { x: number; y: number; angle: number }> = {};
  for (const b of t.bones) rest[bid(b.name)] = { ...b.rest };
  return { bones, view: { rest } };
}

const PARENTS: Record<string, string | undefined> = {
  root: undefined,
  pelvis: 'root',
  torso: 'pelvis',
  neck: 'torso',
  head: 'neck',
  upper_arm_l: 'torso',
  lower_arm_l: 'upper_arm_l',
  hand_l: 'lower_arm_l',
  upper_arm_r: 'torso',
  lower_arm_r: 'upper_arm_r',
  hand_r: 'lower_arm_r',
  thigh_l: 'pelvis',
  shin_l: 'thigh_l',
  foot_l: 'shin_l',
  thigh_r: 'pelvis',
  shin_r: 'thigh_r',
  foot_r: 'shin_r',
};

describe.each([
  ['side', humanoidSide],
  ['front', humanoidFront],
  ['back', humanoidBack],
] as const)('humanoid %s', (viewName, make) => {
  const t = make({ height: 48, origin: { x: 20, y: 40 } });

  it('has exactly the spec bone names and parents, parents first', () => {
    expect(t.bones.map((b) => b.name).sort()).toEqual(
      [
        'root',
        'pelvis',
        'torso',
        'neck',
        'head',
        'upper_arm_l',
        'upper_arm_r',
        'lower_arm_l',
        'lower_arm_r',
        'hand_l',
        'hand_r',
        'thigh_l',
        'thigh_r',
        'shin_l',
        'shin_r',
        'foot_l',
        'foot_r',
      ].sort(),
    );
    expect(t.bones.map((b) => b.name)).toEqual([...HUMANOID_BONES]);
    for (const b of t.bones) expect(b.parent).toBe(PARENTS[b.name]);
    const seen = new Set<string>();
    for (const b of t.bones) {
      if (b.parent !== undefined) expect(seen.has(b.parent)).toBe(true);
      seen.add(b.name);
    }
    expect(t.view.name).toBe(viewName);
    expect(t.view.directions).toEqual([viewName]);
  });

  it('uses integer offsets and lengths, and every bone has a z', () => {
    for (const b of t.bones) {
      expect(Number.isInteger(b.length) && b.length >= 0).toBe(true);
      expect(Number.isInteger(b.rest.x) && Number.isInteger(b.rest.y)).toBe(true);
      expect(typeof t.z[b.name]).toBe('number');
    }
  });

  it('evaluates cleanly: the rest pose is the authored pixels at any quantum', () => {
    const rig = toRig(t);
    const anim = makeAnim(1, {});
    for (const q of [1, 5, 45]) {
      const sk = evaluatePose(rig, rig.view, anim, 0, { angleQuantum: q });
      expect(sk.bones.size).toBe(17);
      for (const b of t.bones) {
        const s = sk.bones.get(bid(b.name));
        const p = b.parent === undefined ? undefined : sk.bones.get(bid(b.parent));
        expect(s?.inView).toBe(true);
        expect(s?.pivot).toEqual(
          p === undefined
            ? { x: b.rest.x, y: b.rest.y }
            : { x: p.pivot.x + b.rest.x, y: p.pivot.y + b.rest.y },
        );
      }
    }
  });
});

describe('humanoid geometry (48 px, origin (20, 40))', () => {
  const pivots = (t: SkeletonTemplate) => {
    const rig = toRig(t);
    const sk = evaluatePose(rig, rig.view, makeAnim(1, {}), 0);
    const out: Record<string, [number, number]> = {};
    for (const [id, b] of sk.bones) out[id.slice(4)] = [b.pivot.x, b.pivot.y];
    return out;
  };
  const side = pivots(humanoidSide({ origin: { x: 20, y: 40 } }));
  const front = pivots(humanoidFront({ origin: { x: 20, y: 40 } }));
  const back = pivots(humanoidBack({ origin: { x: 20, y: 40 } }));

  it('puts the feet on the origin row and the head top at the height', () => {
    expect(side.root).toEqual([20, 40]);
    expect(side.foot_l).toEqual([20, 38]); // ankle 2 px up
    expect(side.thigh_r).toEqual([20, 18]); // hip 22 px up
    const t = humanoidSide({ origin: { x: 20, y: 40 } });
    const head = t.bones.find((b) => b.name === 'head');
    expect(side.head?.[1] ?? 0).toBe(40 - 39); // head base 39 px up
    expect((head?.length ?? 0) + 39).toBe(48);
  });

  it('is symmetric in front, and mirrored in back', () => {
    expect(front.upper_arm_l?.[0]).toBe(26);
    expect(front.upper_arm_r?.[0]).toBe(14);
    expect(front.thigh_l?.[0]).toBe(22);
    expect(front.thigh_r?.[0]).toBe(18);
    expect(back.upper_arm_l?.[0]).toBe(14);
    expect(back.upper_arm_r?.[0]).toBe(26);
    expect(side.upper_arm_l?.[0]).toBe(20);
    expect(side.upper_arm_r?.[0]).toBe(20);
  });

  it('points limbs down (90) and the side foot forward (0) in the world', () => {
    const t = humanoidSide({ origin: { x: 20, y: 40 } });
    const rig = toRig(t);
    const sk = evaluatePose(rig, rig.view, makeAnim(1, {}), 0);
    expect(sk.bones.get(bid('thigh_l'))?.restAngle).toBe(90);
    expect(sk.bones.get(bid('foot_l'))?.restAngle).toBe(0);
    expect(sk.bones.get(bid('upper_arm_r'))?.restAngle).toBe(90);
    expect(sk.bones.get(bid('head'))?.restAngle).toBe(270);
  });

  it('scales with height and proportions, and rejects bad input', () => {
    const big = humanoidSide({ height: 96 });
    const small = humanoidSide({ height: 24 });
    const total = (t: SkeletonTemplate) => {
      const get = (n: string) => t.bones.find((b) => b.name === n);
      return (
        -(get('pelvis')?.rest.y ?? 0) -
        (get('torso')?.rest.y ?? 0) -
        (get('neck')?.rest.y ?? 0) -
        (get('head')?.rest.y ?? 0) +
        (get('head')?.length ?? 0)
      );
    };
    expect(total(big)).toBeGreaterThan(total(small));
    expect(DEFAULT_PROPORTIONS.ankle).toBe(0.04);
    const wide = humanoidFront({ proportions: { shoulderHalfWidth: 0.25 } });
    expect(wide.bones.find((b) => b.name === 'upper_arm_l')?.rest.x).toBe(12);
    expect(errorCode(() => humanoidSide({ height: 4 }))).toBe('BAD_VALUE');
    expect(errorCode(() => humanoidSide({ height: 20.5 }))).toBe('BAD_VALUE');
    expect(errorCode(() => humanoidSide({ origin: { x: 0.5, y: 0 } }))).toBe('BAD_VALUE');
    expect(errorCode(() => humanoidSide({ proportions: { head: -1 } }))).toBe('BAD_VALUE');
  });
});

describe('parsePartLayerName (FR-DOC-04)', () => {
  const cases: [string, ReturnType<typeof parsePartLayerName>][] = [
    ['part:hand_r', { bone: 'hand_r' }],
    ['part:hand_r@open', { bone: 'hand_r', variant: 'open' }],
    ['part:hand_r#side', { bone: 'hand_r', view: 'side' }],
    ['part:upper_arm_r.sleeve', { bone: 'upper_arm_r', part: 'sleeve' }],
    [
      'part:upper_arm_r.sleeve@open#side',
      { bone: 'upper_arm_r', part: 'sleeve', variant: 'open', view: 'side' },
    ],
    ['part:hand_r.', null],
    ['part:hand_r.a.b', null],
    ['part:hand_r.Bad', null],
    ['part:hand_r@open.sleeve', null],
    ['part:.sleeve', null],
    ['part:hand_r@open#side', { bone: 'hand_r', variant: 'open', view: 'side' }],
    ['part:upper-arm_l@a-1#front', { bone: 'upper-arm_l', variant: 'a-1', view: 'front' }],
    ['hand_r', null],
    ['', null],
    ['part:', null],
    ['part:@open', null],
    ['part:hand_r@', null],
    ['part:hand_r#', null],
    ['part:hand_r#side@open', null],
    ['part:hand_r@a@b', null],
    ['part:hand_r#a#b', null],
    ['part:Hand_R', null],
    ['part:hand r', null],
    ['Part:hand_r', null],
    ['part: hand_r', null],
    ['part:hand_r@Open', null],
    ['part:__proto__', null],
    ['part:hand_r@constructor', null],
    [`part:${'a'.repeat(49)}`, null],
  ];
  it.each(cases)('%j', (name, expected) => {
    expect(parsePartLayerName(name)).toEqual(expected);
  });
  it('maps to the document layer name (the bone name)', () => {
    expect(partLayerName({ bone: 'hand_r', variant: 'open' })).toBe('hand_r');
    expect(partLayerName({ bone: 'hand_r', part: 'glove' })).toBe('hand_r_glove');
    expect(DEFAULT_VARIANT_NAME).toBe('default');
  });
});

describe('bindByOverlap', () => {
  const origin = { x: 16, y: 47 };
  const front = humanoidFront({ origin });
  const rig = toRig(front);
  const segment = (name: string) => {
    const sk = evaluatePose(rig, rig.view, makeAnim(1, {}), 0);
    const b = sk.bones.get(bid(name));
    const len = front.bones.find((x) => x.name === name)?.length ?? 0;
    return { x: b?.pivot.x ?? 0, y: b?.pivot.y ?? 0, len, up: b?.restAngle === 270 };
  };
  /** A 3 px wide bar along the bone, as a part. */
  const bar = (name: string): PartShape => {
    const s = segment(name);
    const h = Math.max(1, s.len);
    return {
      layerId: lid(name),
      x: s.x - 1,
      y: s.up ? s.y - h + 1 : s.y,
      w: 3,
      h,
    };
  };

  it('binds every part of a synthetic character (front view)', () => {
    const names = HUMANOID_BONES.filter((n) => n !== 'root');
    const r = bindByOverlap(names.map(bar), rig);
    expect(r.ambiguous).toEqual([]);
    expect(r.unmatched).toEqual([]);
    const got = Object.fromEntries(r.assignments.map((a) => [a.layerId, a.boneId]));
    for (const n of names) expect(got[lid(n)]).toBe(bid(n));
    for (const a of r.assignments) expect(a.share).toBeGreaterThanOrEqual(0.5);
  });

  it('binds hand-written ASCII art with transparent holes (alpha)', () => {
    // right (screen-left) forearm, 3 wide, with a hole; box origin at the elbow pivot minus 1.
    const s = segment('lower_arm_r');
    const art = ['XX.', '.XX', 'XXX', 'XX.', 'XXX', 'XX.'];
    const alpha = art.flatMap((row) => row.split('').map((c) => (c === 'X' ? 255 : 0)));
    const r = bindByOverlap([{ layerId: lid('arm'), x: s.x - 1, y: s.y, w: 3, h: 6, alpha }], rig);
    expect(r.assignments).toEqual([
      { layerId: lid('arm'), boneId: bid('lower_arm_r'), share: expect.any(Number) as number },
    ]);
  });

  it('returns candidates and never guesses on a tie (side view, both arms coincide)', () => {
    const side = humanoidSide({ origin });
    const sideRig = toRig(side);
    const sk = evaluatePose(sideRig, sideRig.view, makeAnim(1, {}), 0);
    const e = sk.bones.get(bid('upper_arm_r'));
    const r = bindByOverlap(
      [{ layerId: lid('arm'), x: (e?.pivot.x ?? 0) - 1, y: e?.pivot.y ?? 0, w: 3, h: 6 }],
      sideRig,
    );
    expect(r.assignments).toEqual([]);
    expect(r.unmatched).toEqual([]);
    expect(r.ambiguous).toHaveLength(1);
    const c = r.ambiguous[0]?.candidates ?? [];
    expect(c).toContain(bid('upper_arm_l'));
    expect(c).toContain(bid('upper_arm_r'));
    // the two coincident arms tie exactly: l before r (id order), never one alone
    expect(c.indexOf(bid('upper_arm_l'))).toBe(c.indexOf(bid('upper_arm_r')) - 1);
  });

  it('returns candidates when a part straddles two bones', () => {
    const t = segment('thigh_l');
    const k = segment('shin_l');
    // half on the thigh, half on the shin
    const r = bindByOverlap(
      [{ layerId: lid('leg'), x: t.x - 1, y: t.y + t.len - 4, w: 3, h: 8 }],
      rig,
    );
    expect(k.y).toBe(t.y + t.len);
    expect(r.assignments).toEqual([]);
    expect([...(r.ambiguous[0]?.candidates ?? [])].sort()).toEqual([bid('shin_l'), bid('thigh_l')]);
  });

  it('does not bind weak overlap (far from every bone) or empty parts', () => {
    const r = bindByOverlap(
      [
        { layerId: lid('far'), x: 40, y: 0, w: 4, h: 4 },
        { layerId: lid('empty'), x: 15, y: 20, w: 2, h: 2, alpha: [0, 0, 0, 0] },
        { layerId: lid('zero'), x: 15, y: 20, w: 0, h: 0 },
      ],
      rig,
    );
    expect(r.assignments).toEqual([]);
    expect(r.ambiguous).toEqual([]);
    expect(r.unmatched).toEqual([lid('far'), lid('empty'), lid('zero')]);
  });

  it('treats a mostly-far part as ambiguous, not assigned (min share)', () => {
    const t = segment('torso');
    // one wide row, mostly in empty space: whatever the torso gets is far below half.
    const r = bindByOverlap([{ layerId: lid('p'), x: t.x - 20, y: t.y - 6, w: 40, h: 1 }], rig);
    expect(r.assignments).toEqual([]);
    expect(r.ambiguous.length + r.unmatched.length).toBe(1);
  });

  it('honours thresholds, skips bones without a rest entry, and validates input', () => {
    const part = bar('torso');
    expect(bindByOverlap([part], rig, { minShare: 1, margin: 0 }).assignments.length).toBe(0);
    expect(bindByOverlap([part], rig, { reach: 0 }).assignments.length).toBe(0);
    const partial = {
      bones: rig.bones,
      view: {
        rest: {
          [bid('torso')]: rig.view.rest[bid('torso')] ?? { x: 0, y: 0, angle: 0 },
          [bid('root')]: rig.view.rest[bid('root')] ?? { x: 0, y: 0, angle: 0 },
          [bid('pelvis')]: rig.view.rest[bid('pelvis')] ?? { x: 0, y: 0, angle: 0 },
        },
      },
    };
    expect(bindByOverlap([part], partial).assignments[0]?.boneId).toBe(bid('torso'));
    expect(errorCode(() => bindByOverlap([part], rig, { reach: -1 }))).toBe('BAD_VALUE');
    expect(errorCode(() => bindByOverlap([part], rig, { minShare: 0 }))).toBe('BAD_VALUE');
    expect(errorCode(() => bindByOverlap([part], rig, { candidateShare: 0 }))).toBe('BAD_VALUE');
    expect(errorCode(() => bindByOverlap([{ ...part, w: 1.5 }], rig))).toBe('BAD_VALUE');
    expect(errorCode(() => bindByOverlap([{ ...part, alpha: [1] }], rig))).toBe('BAD_VALUE');
    const bad = { ...rig, bones: rig.bones.map((b) => ({ ...b, length: -1 })) };
    expect(errorCode(() => bindByOverlap([part], bad))).toBe('BAD_VALUE');
  });
});
