// Oracle for rig.rotationResidual: one bone, one variant drawn at 0 degrees, so the residual of a
// frame is its bone angle (short way round). Expected findings are worked out by hand.
import { MAX_RESIDUAL_DEG_DEFAULT as SCHEMA_DEFAULT } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { lint } from '../src/index.js';
import { MAX_RESIDUAL_DEG_DEFAULT } from '../src/rules.js';
import type { LintFinding } from '../src/index.js';
import { partStore } from './part-fixture.js';
import type { PartSpec } from './part-fixture.js';

const base = { w: 30, h: 30, art: 'RR\nRR', pivot: { x: 1, y: 1 }, at: { x: 15, y: 15 } };
const run = (angles: number[], extra: Partial<PartSpec> = {}): LintFinding[] =>
  lint(partStore({ ...base, angles, ...extra })).filter((f) => f.rule === 'rig.rotationResidual');

describe('rig.rotationResidual', () => {
  it('keeps the default in step with the schema constant', () => {
    expect(MAX_RESIDUAL_DEG_DEFAULT).toBe(SCHEMA_DEFAULT);
  });

  it('is quiet up to 22 degrees (angles snap to whole degrees)', () => {
    expect(run([0, 10, 22, 338, -22])).toEqual([]);
  });

  it('flags 22.5: the angle quantum rounds it away from zero to 23', () => {
    expect(run([22.5])[0]?.data).toMatchObject({ residualDeg: 23 });
  });

  it('reports a part above the default once, at the worst frame', () => {
    const f = run([0, 30, 90, 45]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      severity: 'warning',
      location: { frameIndex: 2, bone: 'b' },
      data: { residualDeg: 90, maxResidualDeg: 22.5, frames: 3 },
    });
  });

  it('uses the short way round (270 is -90) and keeps the sign', () => {
    expect(run([270])[0]?.data).toMatchObject({ residualDeg: -90, frames: 1 });
  });

  it('honours Part.maxResidualDeg', () => {
    expect(run([30, 40], { maxResidualDeg: 45 })).toEqual([]);
    expect(run([30, 50], { maxResidualDeg: 45 })[0]?.data).toMatchObject({
      residualDeg: 50,
      maxResidualDeg: 45,
      frames: 1,
    });
    expect(run([10], { maxResidualDeg: 5 })).toHaveLength(1);
  });

  it('does not report a mirror again', () => {
    expect(run([90], { mirror: true })).toHaveLength(1);
  });
});
