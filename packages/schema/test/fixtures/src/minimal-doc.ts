/**
 * A small but complete v1 document, built by hand with the seeded id generator: two palettes with
 * ramps, one skin, four layers (a pixel layer, a group and two part layers), a rig with three
 * bones, two parts, two variants and one view, an authored `run/right` animation and its derived
 * mirror `run/left`, keys, markers, events, root motion, one part override and one final override.
 * Also the matching render cache index and manifest.
 */
import {
  BASE_SKIN_KEY,
  SCHEMA_VERSION,
  createIdGenerator,
  type DirectionFallback,
  type Document,
  type Manifest,
  type RenderIndex,
} from '../../../src/index.js';

const gen = createIdGenerator({ seed: 42, next: 0 });

/** Every id of the fixture, in creation order. */
export const ids = {
  doc: gen.next('doc'),
  palBase: gen.next('palette'),
  palRival: gen.next('palette'),
  skinRival: gen.next('skin'),
  layBody: gen.next('layer'),
  layTorso: gen.next('layer'),
  layHand: gen.next('layer'),
  layBall: gen.next('layer'),
  boneRoot: gen.next('bone'),
  boneTorso: gen.next('bone'),
  boneHand: gen.next('bone'),
  viewSide: gen.next('view'),
  partTorso: gen.next('part'),
  partHand: gen.next('part'),
  varTorso: gen.next('variant'),
  varHandOpen: gen.next('variant'),
  imgTorso: gen.next('image'),
  imgHandOpen: gen.next('image'),
  imgBall: gen.next('image'),
  imgPartFix: gen.next('image'),
  imgFinalSet: gen.next('image'),
  imgFinalErase: gen.next('image'),
  animRunRight: gen.next('animation'),
  animRunLeft: gen.next('animation'),
  frame0: gen.next('frame'),
  frame1: gen.next('frame'),
  ovrPart: gen.next('override'),
  ovrFinal: gen.next('override'),
} as const;

const directionFallback: DirectionFallback = {
  up: ['up', 'right'],
  down: ['down', 'right'],
};

const origin = { x: 16, y: 30 };

/** The fixture document. */
export const minimalDoc: Document = {
  meta: {
    id: ids.doc,
    name: 'hero',
    schemaVersion: SCHEMA_VERSION,
    canvas: { w: 32, h: 32 },
    origin,
    pixelsPerUnit: 16,
    colorMode: 'indexed',
    paletteLocked: true,
    ids: gen.state(),
  },
  palettes: [
    {
      id: ids.palBase,
      name: 'Base kit',
      colors: [
        [0, 0, 0, 0],
        [20, 12, 28, 255],
        [133, 76, 48, 255],
        [210, 125, 44, 255],
        [255, 204, 170, 255],
        [48, 52, 109, 255],
        [89, 125, 206, 255],
        [222, 238, 214, 255],
      ],
      ramps: [
        { name: 'skin', indices: [2, 3, 4] },
        { name: 'cloth', indices: [5, 6] },
      ],
    },
    {
      id: ids.palRival,
      name: 'Rival kit',
      colors: [
        [0, 0, 0, 0],
        [20, 12, 28, 255],
        [133, 76, 48, 255],
        [210, 125, 44, 255],
        [255, 204, 170, 255],
        [117, 36, 36, 255],
        [208, 70, 72, 255],
        [222, 238, 214, 255],
      ],
      ramps: [{ name: 'cloth', indices: [5, 6] }],
    },
  ],
  activePaletteId: ids.palBase,
  skins: [{ id: ids.skinRival, name: 'rival', paletteId: ids.palRival }],
  layers: [
    {
      kind: 'group',
      id: ids.layBody,
      name: 'body',
      visible: true,
      opacity: 255,
      export: true,
      children: [
        { kind: 'part', id: ids.layTorso, name: 'torso', visible: true, opacity: 255, export: true },
        { kind: 'part', id: ids.layHand, name: 'hand_r', visible: true, opacity: 255, export: true },
      ],
    },
    {
      kind: 'pixel',
      id: ids.layBall,
      name: 'ball',
      visible: true,
      opacity: 255,
      export: true,
      cels: {
        [ids.frame0]: { imageId: ids.imgBall, offset: { x: 22, y: 20 }, opacity: 255 },
        [ids.frame1]: { linkTo: ids.frame0 },
      },
    },
  ],
  rig: {
    bones: [
      { id: ids.boneRoot, name: 'root', length: 0 },
      { id: ids.boneTorso, name: 'torso', parentId: ids.boneRoot, length: 8 },
      { id: ids.boneHand, name: 'hand_r', parentId: ids.boneTorso, length: 4 },
    ],
    parts: [
      {
        id: ids.partTorso,
        boneId: ids.boneTorso,
        layerId: ids.layTorso,
        variants: [
          {
            id: ids.varTorso,
            name: 'default',
            viewId: ids.viewSide,
            imageId: ids.imgTorso,
            pivot: { x: 3, y: 9 },
            tags: [],
          },
        ],
      },
      {
        id: ids.partHand,
        boneId: ids.boneHand,
        layerId: ids.layHand,
        variants: [
          {
            id: ids.varHandOpen,
            name: 'open',
            viewId: ids.viewSide,
            imageId: ids.imgHandOpen,
            pivot: { x: 1, y: 0 },
            drawnAngle: 90,
            tags: ['open'],
          },
        ],
        rotation: 'rotsprite',
        maxResidualDeg: 15,
      },
    ],
    views: [
      {
        id: ids.viewSide,
        name: 'side',
        directions: ['right'],
        rest: {
          [ids.boneRoot]: { x: 16, y: 28, angle: -90 },
          [ids.boneTorso]: { x: 0, y: -2, angle: -90 },
          [ids.boneHand]: { x: 2, y: -6, angle: 90 },
        },
        partVisibility: { [ids.partTorso]: true, [ids.partHand]: true },
        defaultZ: { [ids.partTorso]: 0, [ids.partHand]: 1 },
      },
    ],
  },
  animations: [
    {
      id: ids.animRunRight,
      group: 'run',
      direction: 'right',
      loop: 'loop',
      angleQuantum: 1,
      postPasses: { removeOrphans: {}, outline: { color: [20, 12, 28, 255], outsideOnly: true } },
      frames: [
        {
          id: ids.frame0,
          durationMs: 100,
          markers: { hand_r: { x: 19, y: 20 }, ball: { x: 24, y: 22 } },
          events: ['footstep'],
          rootMotion: { dx: 2, dy: 0 },
          boneKeys: {
            [ids.boneRoot]: { offset: { x: 0, y: -1 } },
            [ids.boneTorso]: { angle: 5, interp: 'ease-in-out' },
            [ids.boneHand]: { angle: -30 },
          },
          partKeys: { [ids.partHand]: { variant: 'auto' } },
        },
        {
          id: ids.frame1,
          durationMs: 150,
          markers: { hand_r: { x: 20, y: 19 }, ball: { x: 25, y: 21 } },
          events: [],
          rootMotion: { dx: 3, dy: 0 },
          boneKeys: {
            [ids.boneTorso]: { angle: -5 },
            [ids.boneHand]: { angle: 30, flipX: false, interp: 'step' },
          },
          partKeys: { [ids.partHand]: { variant: ids.varHandOpen, z: 2, visible: true } },
        },
      ],
      overrides: [
        {
          id: ids.ovrPart,
          frameId: ids.frame0,
          target: { partId: ids.partHand },
          anchor: { x: -1, y: -1 },
          set: ids.imgPartFix,
          baseHash: '0123456789abcdef'.repeat(4),
        },
      ],
    },
    {
      id: ids.animRunLeft,
      group: 'run',
      direction: 'left',
      mirrorOf: ids.animRunRight,
      overrides: [
        {
          id: ids.ovrFinal,
          frameId: ids.frame1,
          target: 'final',
          anchor: { x: 10, y: 12 },
          set: ids.imgFinalSet,
          erase: ids.imgFinalErase,
          baseHash: 'fedcba9876543210'.repeat(4),
        },
      ],
    },
  ],
  directionFallback,
  markerDefs: [{ name: 'hand_r' }, { name: 'ball', description: 'Where the ball sits.' }],
  eventDefs: [{ name: 'footstep' }],
};

/** The render cache index the fixture would produce (`render/index.json`). */
export const minimalRenderIndex: RenderIndex = {
  schemaVersion: SCHEMA_VERSION,
  origin,
  pixelsPerUnit: 16,
  directionFallback,
  skins: [BASE_SKIN_KEY, 'rival'],
  animations: {
    run: {
      right: {
        loop: 'loop',
        frames: [
          {
            id: ids.frame0,
            hash: '00112233445566778899aabbccddeeff'.repeat(2),
            durationMs: 100,
            image: 'run/right/0.png',
            markers: { hand_r: { x: 19, y: 20 }, ball: { x: 24, y: 22 } },
            events: ['footstep'],
            rootMotion: { dx: 2, dy: 0 },
          },
          {
            id: ids.frame1,
            hash: 'ffeeddccbbaa99887766554433221100'.repeat(2),
            durationMs: 150,
            image: 'run/right/1.png',
            markers: { hand_r: { x: 20, y: 19 }, ball: { x: 25, y: 21 } },
            events: [],
            rootMotion: { dx: 3, dy: 0 },
          },
        ],
      },
      left: { loop: 'loop', mirrorOf: 'right' },
    },
  },
};

/** The fixture's `manifest.json`. */
export const minimalManifest: Manifest = {
  format: 'pxf',
  schemaVersion: SCHEMA_VERSION,
  app: 'pixel-forge 0.0.0',
  created: '2026-01-01T00:00:00Z',
  modified: '2026-01-01T00:00:00Z',
};
