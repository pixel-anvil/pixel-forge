import { TiledImage, flipH } from '@pixel-forge/raster';
import type { Rgba } from '@pixel-forge/raster';
import { SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type { Animation, Document, ImageId, Override } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import {
  CoreError,
  DocumentStore,
  checkOverrides,
  copyPoseTx,
  documentHash,
  frameMarkers,
  imageHash,
  mirrorMarkers,
  pastePoseTx,
  renderFrame,
  renderInputKey,
  validate,
} from '../src/index.js';
import { blankFrame } from './helpers.js';

const gen = createIdGenerator({ seed: 31, next: 0 });
const ID = {
  doc: gen.next('doc'),
  pal: gen.next('palette'),
  layer: gen.next('layer'),
  img: gen.next('image'),
  ovImg: gen.next('image'),
  anim: gen.next('animation'),
  mirror: gen.next('animation'),
  f0: gen.next('frame'),
  ov: gen.next('override'),
  part: gen.next('part'),
  bHip: gen.next('bone'),
  bArmL: gen.next('bone'),
  bArmR: gen.next('bone'),
  view: gen.next('view'),
};
const idState = gen.state();

const R: Rgba = [255, 0, 0, 255];
const G: Rgba = [0, 255, 0, 255];
const B: Rgba = [0, 0, 255, 255];

function build(ox: number, extra: { partOverride?: boolean } = {}): DocumentStore {
  const img = new TiledImage(5, 2);
  img.set(0, 0, R);
  img.set(1, 0, G);
  img.set(4, 1, B);
  const ovImg = new TiledImage(1, 1);
  ovImg.set(0, 0, B);
  const partOverride: Override = {
    id: ID.ov,
    frameId: ID.f0,
    target: { partId: ID.part },
    anchor: { x: 0, y: 0 },
    set: ID.ovImg,
    baseHash: '0'.repeat(64),
  };
  const anims: Animation[] = [
    {
      id: ID.anim,
      group: 'idle',
      direction: 'side',
      loop: 'loop',
      frames: [
        {
          ...blankFrame(ID.f0),
          markers: { hand_l: { x: 1, y: 0 }, muzzle: { x: ox, y: 1 }, far: { x: 4, y: 1 } },
        },
      ],
      overrides: [],
    },
    {
      id: ID.mirror,
      group: 'idle',
      direction: 'side2',
      mirrorOf: ID.anim,
      overrides: extra.partOverride === true ? [partOverride] : [],
    },
  ];
  const doc: Document = {
    meta: {
      id: ID.doc,
      name: 'mirror',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w: 5, h: 2 },
      origin: { x: ox, y: 1 },
      pixelsPerUnit: 16,
      colorMode: 'rgba',
      paletteLocked: false,
      ids: { ...idState },
    },
    palettes: [{ id: ID.pal, name: 'Base', colors: [[0, 0, 0, 0]], ramps: [] }],
    activePaletteId: ID.pal,
    skins: [],
    layers: [
      {
        kind: 'pixel',
        id: ID.layer,
        name: 'art',
        visible: true,
        opacity: 255,
        export: true,
        cels: { [ID.f0]: { imageId: ID.img, offset: { x: 0, y: 0 }, opacity: 255 } },
      },
    ],
    animations: anims,
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
    rig: {
      bones: [
        { id: ID.bHip, name: 'hip', length: 4 },
        { id: ID.bArmL, name: 'arm_l', parentId: ID.bHip, length: 4 },
        { id: ID.bArmR, name: 'arm_r', parentId: ID.bHip, length: 4 },
      ],
      parts: [],
      views: [
        {
          id: ID.view,
          name: 'side',
          directions: ['side'],
          rest: {},
          defaultZ: {},
          partVisibility: {},
        },
      ],
    },
  };
  const images: [ImageId, TiledImage][] = [
    [ID.img, img],
    [ID.ovImg, ovImg],
  ];
  return new DocumentStore(doc, { images });
}

const row = (img: TiledImage, y: number): string =>
  Array.from({ length: img.width }, (_, x) => {
    const p = img.get(x, y);
    return p[3] === 0 ? '.' : p[0] === 255 ? 'R' : p[1] === 255 ? 'G' : 'B';
  }).join('');

describe('derived mirror (T3.6)', () => {
  it('equals flipH about the origin column (hand-written pixels)', () => {
    // origin.x = 2 is the centre of a 5-wide canvas: x -> 4 - x is exactly flipH.
    const s = build(2);
    const m = renderFrame(s, { id: ID.mirror }, 0);
    expect(row(m, 0)).toBe('...GR');
    expect(row(m, 1)).toBe('B....');
    const src = renderFrame(s, { id: ID.anim }, 0);
    expect(imageHash(m)).toBe(imageHash(flipH(src)));
    // origin.x = 3: x -> 6 - x. R(0)->6 and G(1)->5 leave the canvas, B(4)->2.
    const m3 = renderFrame(build(3), { id: ID.mirror }, 0);
    expect(row(m3, 0)).toBe('.....');
    expect(row(m3, 1)).toBe('..B..');
  });

  it('mirrors markers as x2 = 2*origin.x - x, keeping names and y', () => {
    const s = build(2);
    expect(frameMarkers(s, { id: ID.anim }, 0)).toEqual({
      hand_l: { x: 1, y: 0 },
      muzzle: { x: 2, y: 1 },
      far: { x: 4, y: 1 },
    });
    expect(frameMarkers(s, { id: ID.mirror }, 0)).toEqual({
      hand_l: { x: 3, y: 0 },
      muzzle: { x: 2, y: 1 },
      far: { x: 0, y: 1 },
    });
    // the marker of a pixel and the pixel itself land on the same column
    const m = renderFrame(s, { id: ID.mirror }, 0);
    expect(row(m, 0)[frameMarkers(s, { id: ID.mirror }, 0).hand_l?.x ?? -1]).toBe('G');
  });

  it('mirrorMarkers: half-pixel coordinates follow the contract (reflection about ox + 0.5)', () => {
    // continuous c = x + 0.5 reflects about origin point ox + 0.5: c' = 2*ox + 1 - c, so x' = 2*ox - x
    const out = mirrorMarkers({ a: { x: 1.5, y: 0 }, b: { x: -2, y: 4 } }, 3);
    expect(out).toEqual({ a: { x: 4.5, y: 0 }, b: { x: 8, y: 4 } });
    expect(mirrorMarkers(out, 3)).toEqual({ a: { x: 1.5, y: 0 }, b: { x: -2, y: 4 } });
    expect(mirrorMarkers({}, 3)).toEqual({});
  });

  it('keeps refusing a mirror part override: not rendered, not keyed, not listed', () => {
    const plain = build(2);
    const withOv = build(2, { partOverride: true });
    const a = renderFrame(plain, { id: ID.mirror }, 0);
    const b = renderFrame(withOv, { id: ID.mirror }, 0);
    expect(imageHash(b)).toBe(imageHash(a));
    expect(renderInputKey(withOv, { id: ID.mirror }, 0)).toBe(
      renderInputKey(plain, { id: ID.mirror }, 0),
    );
    expect(checkOverrides(withOv, {}).filter((o) => o.animationId === ID.mirror)).toEqual([]);
  });
});

describe('copyPoseTx / pastePoseTx', () => {
  it('copies a pose and pastes it mirrored in one undoable edit', () => {
    const s = build(2);
    s.transact('keys', (tx) => {
      tx.set(['animations', 0, 'frames', 0, 'boneKeys', ID.bArmL], { angle: 30 });
      tx.set(['animations', 0, 'frames', 0, 'boneKeys', ID.bHip], { offset: { x: 2, y: 1 } });
    });
    const before = documentHash(s);
    const res = s.transact('paste', (tx) => {
      const clip = copyPoseTx(tx, { id: ID.anim }, 0);
      return pastePoseTx(tx, { id: ID.anim }, 0, clip, { mirrored: true });
    });
    expect(res.skipped).toEqual([]);
    const a = s.doc.animations[0];
    const keys = a !== undefined && !('mirrorOf' in a) ? a.frames[0]?.boneKeys : undefined;
    expect(keys?.[ID.bArmR]).toEqual({ angle: -30 });
    expect(keys?.[ID.bArmL]).toEqual({ angle: 30 }); // unpaired key stays (arm_r had none)
    expect(keys?.[ID.bHip]).toEqual({ offset: { x: -2, y: 1 } });
    expect(validate(s).filter((f) => f.severity === 'error')).toEqual([]);
    s.undo();
    expect(documentHash(s)).toBe(before);
  });

  it('refuses mirror animations and unknown frames', () => {
    const s = build(2);
    const reason = (f: () => unknown): unknown => {
      try {
        f();
      } catch (e) {
        return e instanceof CoreError ? e.details?.reason : 'other';
      }
      return undefined;
    };
    expect(reason(() => s.transact('x', (tx) => copyPoseTx(tx, { id: ID.mirror }, 0)))).toBe(
      'mirror-animation',
    );
    expect(reason(() => s.transact('x', (tx) => copyPoseTx(tx, { id: ID.anim }, 5)))).toBe(
      'unknown-frame',
    );
  });
});
