/**
 * The `idle-breathe` motion preset (FR-RIG-15): a looping idle with a slow breath, as plain FK keys.
 *
 * **Model.** One breath per cycle. `b(t) = (1 − cos 2π t) / 2` is the breath (0 at rest, 1 at the top
 * of the inhale), read from raster's Q16 table (no floating-point trig, ADR-010, ADR-012). The torso
 * bone rises by `amplitude` px (an `offset` key on the torso only: it carries the head and the arms
 * with it) and leans back by `chestTilt` degrees at the top. The head counter-rotates forward by
 * `headTilt` degrees, an eighth of a cycle late (it follows the chest). The arms hang and sway by
 * `armSway` degrees, a quarter cycle late (they trail the shoulders), the elbows bending a little.
 *
 * **Legs.** The pelvis and every leg bone get no key: the legs stay at their rest pose, so a foot
 * never moves (no slide, no IK needed).
 *
 * **Loop.** Frame `n` would be frame 0: every channel is periodic in the frame index, so the last frame
 * is one step before frame 0 and no frame is duplicated. `phase` shifts the whole cycle.
 * @packageDocumentation
 */
import type { BoneId, BoneKey } from '@pixel-forge/schema';
import {
  CYCLE_UNITS,
  type Preset,
  type PresetFrame,
  type PresetParamSpecs,
  type PresetParams,
  type PresetResult,
  type PresetRig,
  commonParams,
  divRound,
  param,
  presetContext,
  resolveParams,
  scaleAngle,
  scaleInt,
  turnCos,
} from './preset.js';

/** Parameters of {@link idleBreathe}. */
export const IDLE_BREATHE_PARAMS: PresetParamSpecs = {
  ...commonParams(8),
  amplitude: {
    kind: 'int',
    min: 0,
    max: 6,
    default: 1,
    description: 'Px the chest (torso, head and arms) rises at the top of the inhale',
  },
  chestTilt: {
    kind: 'number',
    min: 0,
    max: 10,
    default: 2,
    description: 'Degrees the torso leans back at the top of the inhale',
  },
  headTilt: {
    kind: 'number',
    min: 0,
    max: 10,
    default: 2,
    description: 'Degrees the head tips forward against the chest (an eighth of a cycle late)',
  },
  armSway: {
    kind: 'number',
    min: 0,
    max: 20,
    default: 4,
    description: 'Degrees each upper arm sways back (a quarter of a cycle late); the elbow follows',
  },
};

/** Q16 breath `(1 − cos 2π x) / 2` at `num / den` turns. */
function breath(num: number, den: number): number {
  return divRound(65536 - turnCos(num, den), 2);
}

function generate(rig: PresetRig, input: PresetParams = {}): PresetResult {
  const p = resolveParams(IDLE_BREATHE_PARAMS, input);
  const n = param(p, 'frames');
  const quantum = param(p, 'angleQuantum');
  const ctx = presetContext(rig, ['torso'], quantum);
  const cycle = CYCLE_UNITS * n;
  const phaseUnits = param(p, 'phase') * n;
  const frames: PresetFrame[] = [];
  for (let f = 0; f < n; f++) {
    const t = (CYCLE_UNITS * f + phaseUnits) % cycle;
    const keys: Partial<Record<BoneId, BoneKey>> = {};
    const b = breath(t, cycle);
    keys[ctx.id('torso')] = {
      angle: scaleAngle(-param(p, 'chestTilt'), b, quantum),
      offset: { x: 0, y: -scaleInt(param(p, 'amplitude'), b) + 0 },
    };
    // Lagged breaths: (8 t − cycle) / (8 cycle) is t / cycle − 1/8 turns; (4 t − cycle) / (4 cycle) is − 1/4.
    if (ctx.has('head')) {
      keys[ctx.id('head')] = {
        angle: scaleAngle(param(p, 'headTilt'), breath(8 * t - cycle, 8 * cycle), quantum),
      };
    }
    const arm = breath(4 * t - cycle, 4 * cycle);
    for (const side of ['l', 'r'] as const) {
      if (ctx.has(`upper_arm_${side}`)) {
        keys[ctx.id(`upper_arm_${side}`)] = {
          angle: scaleAngle(param(p, 'armSway'), arm, quantum),
        };
      }
      if (ctx.has(`lower_arm_${side}`)) {
        keys[ctx.id(`lower_arm_${side}`)] = {
          angle: scaleAngle(-param(p, 'armSway') / 2, arm, quantum),
        };
      }
    }
    frames.push({
      boneKeys: keys,
      rootMotion: { dx: 0, dy: 0 },
      labels: { breath: t < cycle / 2 ? 'inhale' : 'exhale' },
    });
  }
  return { preset: 'idle-breathe', loop: 'loop', angleQuantum: quantum, params: p, frames };
}

/** The idle breathing preset (FR-RIG-15). */
export const idleBreathe: Preset = {
  name: 'idle-breathe',
  summary:
    'Looping idle: chest rise and fall, head counter-motion, small arm sway; the legs stay planted',
  loop: 'loop',
  params: IDLE_BREATHE_PARAMS,
  generate,
};
