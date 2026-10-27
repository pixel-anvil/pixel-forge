import type { BoneId, BoneKey, FrameId, LoopMode, RestTransform } from '@pixel-forge/schema';
import { RigError, type PoseAnimation, type PoseFrame } from '../src/index.js';

export const bone = (name: string): BoneId => `bon_${name}` as BoneId;
export const frameId = (i: number): FrameId => `frm_${String(i)}` as FrameId;

/** A rig of `[id, parentId?]` pairs. */
export function makeRig(bones: readonly (readonly [BoneId, (BoneId | undefined)?])[]): {
  bones: { id: BoneId; parentId?: BoneId }[];
} {
  return {
    bones: bones.map(([id, parentId]) => (parentId === undefined ? { id } : { id, parentId })),
  };
}

/** A view rest pose. */
export function makeView(rest: readonly (readonly [BoneId, number, number, number?])[]): {
  rest: Partial<Record<BoneId, RestTransform>>;
} {
  const out: Partial<Record<BoneId, RestTransform>> = {};
  for (const [id, x, y, angle] of rest) out[id] = { x, y, angle: angle ?? 0 };
  return { rest: out };
}

/** An animation of `count` frames with sparse keys `{frameIndex: {bone: key}}`. */
export function makeAnim(
  count: number,
  keys: Readonly<Record<number, Readonly<Partial<Record<BoneId, BoneKey>>>>>,
  loop: LoopMode = 'once',
  angleQuantum?: number,
): PoseAnimation & { frames: PoseFrame[] } {
  const frames = Array.from({ length: count }, (_, i) => ({
    id: frameId(i),
    boneKeys: { ...(keys[i] ?? {}) },
  }));
  return angleQuantum === undefined ? { frames, loop } : { frames, loop, angleQuantum };
}

/** The `RigError` code thrown by `f`, `'other'` for another error, `undefined` if it returns. */
export function errorCode(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    return e instanceof RigError ? e.code : 'other';
  }
  return undefined;
}

/** Seeded PRNG (mulberry32): tests are reproducible and never use `Math.random`. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const QUANTA = [0.25, 0.5, 1, 1.5, 2, 2.5, 5, 22.5, 45, 90] as const;
const INTERPS = ['step', 'linear', 'ease-in-out', undefined] as const;
const LOOPS: readonly LoopMode[] = ['loop', 'once', 'pingpong'];

/** A random rig, rest pose and animation (a forest of up to 9 bones, up to 16 frames). */
export interface RandomCase {
  rig: { bones: { id: BoneId; parentId?: BoneId }[] };
  view: { rest: Partial<Record<BoneId, RestTransform>> };
  anim: PoseAnimation & { frames: PoseFrame[]; angleQuantum: number };
}

export function randomCase(rand: () => number): RandomCase {
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
  const quantum = pick(QUANTA);
  // An angle that is sometimes an exact quantum tie, sometimes a multiple of 0.25, sometimes arbitrary.
  const angle = (range: number): number => {
    const r = rand();
    if (r < 0.15) return (int(-8, 8) + 0.5) * quantum;
    if (r < 0.4) return int(-range * 4, range * 4) / 4;
    return Math.round((rand() * 2 - 1) * range * 1000) / 1000;
  };
  const n = int(1, 9);
  const ids: BoneId[] = [];
  const bones: { id: BoneId; parentId?: BoneId }[] = [];
  for (let i = 0; i < n; i++) {
    const id = bone(`${String(int(0, 99))}x${String(i)}`);
    ids.push(id);
    bones.push(i === 0 || rand() < 0.15 ? { id } : { id, parentId: pick(ids.slice(0, i)) });
  }
  const rest: Partial<Record<BoneId, RestTransform>> = {};
  for (const b of bones) {
    if (rand() < 0.08) continue; // not in the view
    rest[b.id] =
      b.parentId === undefined
        ? { x: int(-40, 80), y: int(-40, 80), angle: angle(180) }
        : { x: int(-24, 24), y: int(-24, 24), angle: angle(180) };
  }
  const count = int(1, 16);
  const frames: PoseFrame[] = [];
  for (let f = 0; f < count; f++) {
    const boneKeys: Partial<Record<BoneId, BoneKey>> = {};
    for (const b of bones) {
      if (rand() < 0.65) continue;
      const key: { angle?: number; offset?: { x: number; y: number }; flipX?: boolean } = {};
      if (rand() < 0.7) key.angle = angle(200);
      if (rand() < 0.3) key.offset = { x: int(-6, 6), y: int(-6, 6) };
      if (rand() < 0.2 || (key.angle === undefined && key.offset === undefined)) {
        key.flipX = rand() < 0.5;
      }
      const interp = pick(INTERPS);
      boneKeys[b.id] = interp === undefined ? key : { ...key, interp };
    }
    frames.push({ id: frameId(f), boneKeys });
  }
  return {
    rig: { bones },
    view: { rest },
    anim: { frames, loop: pick(LOOPS), angleQuantum: quantum },
  };
}

/** Smallest angle between two directions, in radians. */
export function angularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return (Math.min(d, 360 - d) * Math.PI) / 180;
}
