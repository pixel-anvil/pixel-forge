import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type { Document, FrameId, ImageId } from '@pixel-forge/schema';
import { DocumentStore } from '../src/index.js';
import type { StoredImage } from '../src/index.js';

const gen = createIdGenerator({ seed: 11, next: 0 });

/** Ids of the rich fixture, generated in order so `meta.ids.next` is ahead of all of them. */
export const F = {
  doc: gen.next('doc'),
  pal: gen.next('palette'),
  layBody: gen.next('layer'),
  layArm: gen.next('layer'),
  layFx: gen.next('layer'),
  laySpark: gen.next('layer'),
  layRef: gen.next('layer'),
  boneRoot: gen.next('bone'),
  boneArm: gen.next('bone'),
  view: gen.next('view'),
  part: gen.next('part'),
  varA: gen.next('variant'),
  varB: gen.next('variant'),
  imgBody0: gen.next('image'),
  imgBody2: gen.next('image'),
  imgSpark: gen.next('image'),
  imgRef: gen.next('image'),
  imgVarA: gen.next('image'),
  imgVarB: gen.next('image'),
  imgSet1: gen.next('image'),
  imgErase1: gen.next('image'),
  imgSet2: gen.next('image'),
  run: gen.next('animation'),
  runL: gen.next('animation'),
  idle: gen.next('animation'),
  f0: gen.next('frame'),
  f1: gen.next('frame'),
  f2: gen.next('frame'),
  g0: gen.next('frame'),
  ovr1: gen.next('override'),
  ovr2: gen.next('override'),
} as const;

const idState = gen.state();
const HASH = 'a'.repeat(64);

function frame(id: FrameId, durationMs: number, extra: object = {}) {
  return {
    id,
    durationMs,
    markers: {},
    events: [],
    rootMotion: { dx: 0, dy: 0 },
    boneKeys: {},
    partKeys: {},
    ...extra,
  };
}

/** A rich schema-valid RGBA document: rig, links, overrides, a mirror and a second animation. */
export function richDoc(): Document {
  return {
    meta: {
      id: F.doc,
      name: 'rich',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w: 16, h: 16 },
      origin: { x: 8, y: 15 },
      pixelsPerUnit: 16,
      colorMode: 'rgba',
      paletteLocked: false,
      ids: { ...idState },
    },
    palettes: [
      {
        id: F.pal,
        name: 'Base',
        colors: [
          [0, 0, 0, 0],
          [255, 0, 0, 255],
        ],
        ramps: [],
      },
    ],
    activePaletteId: F.pal,
    skins: [],
    layers: [
      {
        kind: 'pixel',
        id: F.layBody,
        name: 'body',
        visible: true,
        opacity: 255,
        export: true,
        cels: {
          [F.f0]: { imageId: F.imgBody0, offset: { x: 1, y: 2 }, opacity: 200 },
          [F.f1]: { linkTo: F.f0 },
          [F.f2]: { imageId: F.imgBody2, offset: { x: 0, y: 0 }, opacity: 255 },
          [F.g0]: { linkTo: F.f0 },
        },
      },
      { kind: 'part', id: F.layArm, name: 'arm', visible: true, opacity: 255, export: true },
      {
        kind: 'group',
        id: F.layFx,
        name: 'fx',
        visible: true,
        opacity: 255,
        export: true,
        children: [
          {
            kind: 'pixel',
            id: F.laySpark,
            name: 'spark',
            visible: true,
            opacity: 255,
            export: true,
            cels: { [F.f1]: { imageId: F.imgSpark, offset: { x: 3, y: 3 }, opacity: 255 } },
          },
        ],
      },
      {
        kind: 'reference',
        id: F.layRef,
        name: 'ref',
        visible: true,
        opacity: 255,
        export: false,
        cels: { [F.f0]: { imageId: F.imgRef, offset: { x: 0, y: 0 }, opacity: 128 } },
      },
    ],
    rig: {
      bones: [
        { id: F.boneRoot, name: 'root', length: 4 },
        { id: F.boneArm, name: 'arm', parentId: F.boneRoot, length: 3 },
      ],
      parts: [
        {
          id: F.part,
          boneId: F.boneArm,
          layerId: F.layArm,
          variants: [
            {
              id: F.varA,
              name: 'a',
              viewId: F.view,
              imageId: F.imgVarA,
              pivot: { x: 1, y: 1 },
              tags: [],
            },
            {
              id: F.varB,
              name: 'b',
              viewId: F.view,
              imageId: F.imgVarB,
              pivot: { x: 1, y: 1 },
              tags: [],
            },
          ],
        },
      ],
      views: [
        {
          id: F.view,
          name: 'side',
          directions: ['side'],
          rest: {
            [F.boneRoot]: { x: 8, y: 10, angle: 0 },
            [F.boneArm]: { x: 2, y: 0, angle: 90 },
          },
          partVisibility: { [F.part]: true },
          defaultZ: { [F.part]: 1 },
        },
      ],
    },
    animations: [
      {
        id: F.run,
        group: 'run',
        direction: 'side',
        loop: 'loop',
        frames: [
          frame(F.f0, 100),
          frame(F.f1, 120, {
            markers: { hand_r: { x: 5, y: 6 } },
            events: ['step'],
            rootMotion: { dx: 2, dy: -1 },
            boneKeys: { [F.boneArm]: { angle: 45, interp: 'step' } },
            partKeys: { [F.part]: { variant: F.varB, z: 3 } },
          }),
          frame(F.f2, 140),
        ],
        overrides: [
          {
            id: F.ovr1,
            frameId: F.f1,
            target: { partId: F.part },
            anchor: { x: 1, y: -1 },
            set: F.imgSet1,
            erase: F.imgErase1,
            baseHash: HASH,
          },
        ],
      },
      {
        id: F.runL,
        group: 'run',
        direction: 'left',
        mirrorOf: F.run,
        overrides: [
          {
            id: F.ovr2,
            frameId: F.f1,
            target: 'final',
            anchor: { x: 0, y: 0 },
            set: F.imgSet2,
            baseHash: HASH,
          },
        ],
      },
      {
        id: F.idle,
        group: 'idle',
        loop: 'loop',
        frames: [frame(F.g0, 90)],
        overrides: [],
      },
    ],
    directionFallback: {},
    markerDefs: [{ name: 'hand_r' }],
    eventDefs: [{ name: 'step' }],
  };
}

function rgbaImage(w: number, h: number, seed: number): TiledImage {
  const img = new TiledImage(w, h);
  img.set(seed % w, seed % h, [255, 0, 0, 255]);
  return img;
}

/** Images of {@link richDoc}; every one is referenced. */
export function richImages(): [ImageId, StoredImage][] {
  const mask = new IndexedImage(4, 4);
  mask.set(1, 1, 255);
  return [
    [F.imgBody0, rgbaImage(8, 8, 1)],
    [F.imgBody2, rgbaImage(8, 8, 2)],
    [F.imgSpark, rgbaImage(4, 4, 3)],
    [F.imgRef, rgbaImage(8, 8, 4)],
    [F.imgVarA, rgbaImage(4, 4, 5)],
    [F.imgVarB, rgbaImage(4, 4, 6)],
    [F.imgSet1, rgbaImage(4, 4, 7)],
    [F.imgErase1, mask],
    [F.imgSet2, rgbaImage(4, 4, 8)],
  ];
}

/** A store over the rich fixture. */
export function richStore(): DocumentStore {
  return new DocumentStore(richDoc(), { images: richImages() });
}
