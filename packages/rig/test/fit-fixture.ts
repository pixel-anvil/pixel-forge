/**
 * A synthetic three-bone arm for the pose search tests (shoulder -> elbow -> wrist, 48x40 canvas),
 * drawn with the real part renderer. Hand-made ASCII art, no third-party art. The arm is long and
 * lopsided (a marker pixel on every segment) so that each angle changes the render.
 */
import type { BoneId, LayerId, PartId, VariantId } from '@pixel-forge/schema';
import { renderParts } from '../src/index.js';
import type { FitImage, FitPoseCandidate } from '../src/index.js';
import { B, F, Images, P, V, VIEW, anim, compose, rgba, variant } from './render-fixture.js';
import type { FixtureRig } from './render-fixture.js';

export const W = 48;
export const H = 40;
export const SHOULDER = B('shoulder');
export const ELBOW = B('elbow');
export const WRIST = B('wrist');

export const images = new Images({
  upper: rgba('RRRRRRRRRRRR\nRRRRRRRRRRRY\nRRRRRRRRRRRR'),
  fore: rgba('GGGGGGGGGGGG\nGGGGGGGGGGGM\nGGGGGGGGGGGG'),
  open: rgba('BBBBBB\nB.BB.B\nBBBBBB\nB....B\nBBBBBB'),
  fist: rgba('YYYYY\nYMMMY\nYMYYY\nYMMMY\nYYYYY'),
});

export const rig: FixtureRig = {
  bones: [{ id: SHOULDER }, { id: ELBOW, parentId: SHOULDER }, { id: WRIST, parentId: ELBOW }],
  parts: [
    {
      id: P('upper'),
      boneId: SHOULDER,
      layerId: 'lay_upper' as LayerId,
      variants: [variant('upper', 'upper', { x: 0, y: 1 })],
    },
    {
      id: P('fore'),
      boneId: ELBOW,
      layerId: 'lay_fore' as LayerId,
      variants: [variant('fore', 'fore', { x: 0, y: 1 })],
    },
    {
      id: P('hand'),
      boneId: WRIST,
      layerId: 'lay_hand' as LayerId,
      variants: [variant('open', 'open', { x: 0, y: 2 }), variant('fist', 'fist', { x: 0, y: 2 })],
    },
  ],
  views: [
    {
      id: VIEW,
      directions: ['side'],
      rest: {
        [SHOULDER]: { x: 10, y: 20, angle: 0 },
        [ELBOW]: { x: 12, y: 0, angle: 0 },
        [WRIST]: { x: 12, y: 0, angle: 0 },
      },
      partVisibility: {},
      defaultZ: { [P('upper')]: 1, [P('fore')]: 2, [P('hand')]: 3 },
    },
  ],
};

const BONE_IDS: Readonly<Record<string, BoneId>> = {
  shoulder: SHOULDER,
  elbow: ELBOW,
  wrist: WRIST,
};

/** Renders the arm at a candidate: angles by bone name, `variants.hand` is `open` or `fist`. */
export function renderArm(pose: FitPoseCandidate, quantum = 1): FitImage {
  const bones: Partial<Record<BoneId, { angle: number }>> = {};
  for (const [name, angle] of Object.entries(pose.angles)) {
    const id = BONE_IDS[name];
    if (id !== undefined) bones[id] = { angle };
  }
  const parts: Partial<Record<PartId, { variant: VariantId }>> = {};
  const hand = pose.variants.hand;
  if (hand !== undefined) parts[P('hand')] = { variant: V(hand) };
  const animation = anim([{ bones, parts }], [], 'once', quantum);
  return compose(renderParts({ rig, animation, frame: F(0), images }), W, H).toRGBA();
}
