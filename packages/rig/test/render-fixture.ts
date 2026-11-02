/**
 * A tiny two-bone rig for the part render tests: an "arm" (root, pivot (2, 2)) and a "leg" (root,
 * pivot (7, 1)), each with one part, on a 10×6 canvas. Hand-drawn ASCII, no third-party art.
 */
import { IndexedImage, TiledImage, composite } from '@pixel-forge/raster';
import type { RotatableImage } from '@pixel-forge/raster';
import type {
  BoneId,
  BoneKey,
  FrameId,
  ImageId,
  LayerId,
  LoopMode,
  OverrideId,
  PartId,
  PartKey,
  VariantId,
  ViewId,
} from '@pixel-forge/schema';
import { asciiToImage } from '@pixel-forge/testkit';
import type { Legend } from '@pixel-forge/testkit';
import type {
  FrameOverride,
  ImageLookup,
  PartAnimation,
  PartRender,
  PartRig,
  PartVariant,
  RigPart,
} from '../src/index.js';

export const legend: Legend = {
  R: [255, 0, 0, 255],
  G: [0, 255, 0, 255],
  B: [0, 0, 255, 255],
  Y: [255, 255, 0, 255],
  M: [255, 0, 255, 255],
  h: [255, 0, 0, 128],
};

/** Unwraps a value the test knows is there. */
export function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing');
  return v;
}

export const rgba = (ascii: string): TiledImage => TiledImage.fromRGBA(asciiToImage(ascii, legend));

/** Indexed image from digits (`.` is the transparent index `ti`). */
export const indexed = (ascii: string, ti = 0): IndexedImage => {
  const rows = ascii
    .trim()
    .split('\n')
    .map((l) => l.trim());
  const data = Uint8Array.from(
    rows
      .join('')
      .split('')
      .map((c) => (c === '.' ? ti : Number(c))),
  );
  return IndexedImage.fromIndices(rows[0]?.length ?? 0, rows.length, data, ti);
};

export const B = (n: string): BoneId => `bon_${n}` as BoneId;
export const P = (n: string): PartId => `prt_${n}` as PartId;
export const LAY = (n: string): LayerId => `lay_${n}` as LayerId;
export const V = (n: string): VariantId => `var_${n}` as VariantId;
export const IMG = (n: string): ImageId => `img_${n}` as ImageId;
export const OV = (n: string): OverrideId => `ovr_${n}` as OverrideId;
export const F = (i: number): FrameId => `frm_${String(i)}` as FrameId;
export const VIEW: ViewId = 'viw_side' as ViewId;
export const VIEW2: ViewId = 'viw_front' as ViewId;

/** A mutable image map with the lookup interface. */
export class Images implements ImageLookup {
  readonly map = new Map<ImageId, RotatableImage>();
  constructor(entries: Record<string, RotatableImage> = {}) {
    for (const [k, v] of Object.entries(entries)) this.map.set(IMG(k), v);
  }
  image(id: ImageId): RotatableImage | undefined {
    return this.map.get(id);
  }
}

/** The fixture images: the arm `RRB / R..` (pivot top-left), a green alternate, the leg `B B G`. */
export const fixtureImages = (): Images =>
  new Images({
    arm: rgba('RRB\nR..'),
    arm2: rgba('GGG\nG..'),
    leg: rgba('B\nB\nG'),
    dot: rgba('Y'),
  });

export const variant = (
  name: string,
  image: string,
  pivot: { x: number; y: number },
  extra: Partial<PartVariant> = {},
): PartVariant => ({ id: V(name), viewId: VIEW, imageId: IMG(image), pivot, ...extra });

export interface FixtureRig extends PartRig {
  bones: { id: BoneId; parentId?: BoneId }[];
  parts: (Omit<RigPart, 'variants'> & { variants: PartVariant[] })[];
  views: {
    id: ViewId;
    directions: string[];
    rest: Partial<Record<BoneId, { x: number; y: number; angle: number }>>;
    partVisibility: Partial<Record<PartId, boolean>>;
    defaultZ: Partial<Record<PartId, number>>;
  }[];
}

export function fixtureRig(): FixtureRig {
  return {
    bones: [{ id: B('arm') }, { id: B('leg') }],
    parts: [
      {
        id: P('arm'),
        boneId: B('arm'),
        layerId: LAY('arm'),
        variants: [variant('arm', 'arm', { x: 0, y: 0 }), variant('arm2', 'arm2', { x: 0, y: 0 })],
      },
      {
        id: P('leg'),
        boneId: B('leg'),
        layerId: LAY('leg'),
        variants: [variant('leg', 'leg', { x: 0, y: 0 })],
      },
    ],
    views: [
      {
        id: VIEW,
        directions: ['side'],
        rest: { [B('arm')]: { x: 2, y: 2, angle: 0 }, [B('leg')]: { x: 7, y: 1, angle: 0 } },
        partVisibility: {},
        defaultZ: { [P('arm')]: 1 },
      },
    ],
  };
}

export interface FrameKeys {
  bones?: Partial<Record<BoneId, BoneKey>>;
  parts?: Partial<Record<PartId, PartKey>>;
}

/** An animation of `frames.length` frames with the given keys and overrides. */
export function anim(
  frames: FrameKeys[],
  overrides: FrameOverride[] = [],
  loop: LoopMode = 'once',
  angleQuantum?: number,
): PartAnimation & { frames: PartAnimation['frames'][number][] } {
  const out = {
    direction: 'side',
    loop,
    frames: frames.map((k, i) => ({
      id: F(i),
      boneKeys: { ...(k.bones ?? {}) },
      partKeys: { ...(k.parts ?? {}) },
    })),
    overrides,
  };
  return angleQuantum === undefined ? out : { ...out, angleQuantum };
}

/** Composites rendered parts onto a `w × h` canvas in the returned order (as core does). */
export function compose(parts: readonly PartRender[], w = 10, h = 6): TiledImage {
  const canvas = new TiledImage(w, h);
  for (const p of parts) {
    if (!(p.image instanceof TiledImage)) throw new Error('compose: RGBA parts only');
    composite(canvas, p.image, { x: p.offset.x, y: p.offset.y });
  }
  return canvas;
}

/** A part override with a placeholder hash. */
export const partOverride = (
  name: string,
  part: string,
  anchor: { x: number; y: number },
  imgs: { set?: string; erase?: string },
  frame = 0,
): FrameOverride => ({
  id: OV(name),
  frameId: F(frame),
  target: { partId: P(part) },
  anchor,
  ...(imgs.set === undefined ? {} : { set: IMG(imgs.set) }),
  ...(imgs.erase === undefined ? {} : { erase: IMG(imgs.erase) }),
  baseHash: '0'.repeat(64),
});
