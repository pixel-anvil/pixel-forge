/**
 * Oracle (a): the independent reference of `test/float-reference.ts` (float64 trig for the generic
 * rotations; exact integer arithmetic for offsets, for angles whose operands are multiples of 1/8°
 * and for the rotations whose trig values are exactly known) against `evaluatePose`, on 1000 seeded
 * random rigs, every frame, every bone.
 *
 * Exact .5 ties, `(k + ½)·q` angles included, are compared exactly. Only genuinely float-ambiguous
 * quantities are not: there the reference checks that the implementation picked one of the two legal
 * roundings and continues from it, so a bone below such a quantity is still compared exactly.
 */
import { describe, expect, it } from 'vitest';
import { evaluatePose } from '../src/index.js';
import { expectedBone, newStats, reference } from './float-reference.js';
import { prng, randomCase } from './helpers.js';

describe('oracle (a): independent reference', () => {
  it('agrees exactly with evaluatePose on every bone, ties included (1000 random rigs, every frame)', () => {
    const rand = prng(2026);
    const stats = newStats();
    for (let n = 0; n < 1000; n++) {
      const c = randomCase(rand);
      for (let f = 0; f < c.anim.frames.length; f++) {
        const sk = evaluatePose(c.rig, c.view, c.anim, f);
        const ref = reference(c, f, sk, stats);
        for (const [id, r] of ref) {
          const got = sk.bones.get(id);
          if (!got) throw new Error('missing bone');
          expect({
            pivot: got.pivot,
            key: got.key,
            rotation: got.rotation,
            restAngle: got.restAngle,
            worldAngle: got.worldAngle,
            flipX: got.flipX,
          }).toEqual(expectedBone(r));
        }
      }
    }
    // Pinned (seeded). 42 881 bone evaluations, every one compared exactly: none is skipped, and the
    // descendants of a tie are checked too (before: 11 268 bones excused, 8 820 of them for rest sums).
    // Exact .5 ties, compared exactly: 5 183 key angles ((k + 1/2)·q and interpolated), 1 005 offsets,
    // 3 387 rest sums, 22 rotated rest offsets (e.g. (1, 0) at 30° is exactly (0.866, 0.5) -> (1, 1)).
    // Genuinely float-ambiguous: 4 rest sums with a non-1/8 operand and 25 rotated coordinates within
    // the Q16 table error of .5 (ADR-010). There either legal rounding is accepted (and the bones
    // below carry on from the implementation's); in 1 of the 29 float64 would have rounded the other way.
    expect(stats).toEqual({
      bones: 42881,
      exactTies: { angle: 5183, offset: 1005, rest: 3387, rotation: 22 },
      ambiguous: { angle: 0, rest: 4, rotation: 25 },
      ambiguousDiffering: 1,
    });
  });
});
