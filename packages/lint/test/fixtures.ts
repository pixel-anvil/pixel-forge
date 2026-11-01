/**
 * Hand-drawn fixture documents for the lint tests: one tiny pixel document (`pixelStore`) and one
 * two-bone rig document (`rigStore`, the arms of fixtures/joint/gappy_elbow and clean_capped_elbow).
 */
import { DocumentStore, rebaseOverrides } from '@pixel-forge/core';
import { TiledImage } from '@pixel-forge/raster';
import { SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type { Document, ImageId, Layer, Override, Skin } from '@pixel-forge/schema';
import { asciiToImage } from '@pixel-forge/testkit';
import type { Legend } from '@pixel-forge/testkit';

export const legend: Legend = {
  R: [255, 0, 0, 255],
  B: [0, 0, 255, 255],
  G: [0, 255, 0, 255],
  h: [255, 0, 0, 128],
};

const img = (ascii: string): TiledImage => TiledImage.fromRGBA(asciiToImage(ascii, legend));

const blankFrame = (id: string) => ({
  id: id as never,
  durationMs: 100,
  markers: {},
  events: [],
  rootMotion: { dx: 0, dy: 0 },
  boneKeys: {},
  partKeys: {},
});

export interface PixelSpec {
  /** One ASCII picture per frame; `null` has no cel (an empty frame). */
  frames: (string | null)[];
  locked?: boolean;
  indexed?: boolean;
  layerOpacity?: number;
  celOpacity?: number;
  /** `'remap'`: red to blue; `'short'`: a palette skin whose palette lacks the red entry. */
  skin?: 'remap' | 'short';
  removeOrphans?: boolean;
}

/** A 6x4 document with one pixel layer `a`; palette: transparent, red, blue. */
export function pixelStore(spec: PixelSpec): DocumentStore {
  const gen = createIdGenerator({ seed: 5, next: 0 });
  const docId = gen.next('doc');
  const pal = gen.next('palette');
  const pal2 = gen.next('palette');
  const lay = gen.next('layer');
  const anim = gen.next('animation');
  const frameIds = spec.frames.map(() => gen.next('frame'));
  const imageIds = spec.frames.map(() => gen.next('image'));
  const skinId = gen.next('skin');
  const colors: [number, number, number, number][] = [
    [0, 0, 0, 0],
    [255, 0, 0, 255],
    [0, 0, 255, 255],
  ];
  const cels: Record<
    string,
    { imageId: ImageId; offset: { x: number; y: number }; opacity: number }
  > = {};
  const images: [ImageId, TiledImage][] = [];
  spec.frames.forEach((a, i) => {
    const fid = frameIds[i];
    const iid = imageIds[i];
    if (a === null || fid === undefined || iid === undefined) return;
    cels[fid] = { imageId: iid, offset: { x: 0, y: 0 }, opacity: spec.celOpacity ?? 255 };
    images.push([iid, img(a)]);
  });
  const skins: Skin[] =
    spec.skin === 'remap'
      ? [{ id: skinId, name: 'blue', remap: [[1, 2]] }]
      : spec.skin === 'short'
        ? [{ id: skinId, name: 'short', paletteId: pal2 }]
        : [];
  const layer: Layer = {
    kind: 'pixel',
    id: lay,
    name: 'a',
    visible: true,
    opacity: spec.layerOpacity ?? 255,
    export: true,
    cels,
  };
  const doc: Document = {
    meta: {
      id: docId,
      name: 'lint',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w: 6, h: 4 },
      origin: { x: 3, y: 3 },
      pixelsPerUnit: 16,
      colorMode: 'rgba',
      paletteLocked: spec.locked ?? false,
      ids: { ...gen.state() },
    },
    palettes: [
      { id: pal, name: 'p', colors, ramps: [] },
      // The skin palette has no entry for index 1 (red): red pixels stay red under the skin.
      { id: pal2, name: 'p2', colors: [[0, 0, 0, 0]], ramps: [] },
    ],
    activePaletteId: pal,
    skins,
    layers: [layer],
    animations: [
      {
        id: anim,
        group: 'act',
        loop: 'loop',
        frames: frameIds.map((id) => blankFrame(id)),
        overrides: [],
        ...(spec.removeOrphans === true ? { postPasses: { removeOrphans: true } } : {}),
      } as never,
    ],
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
  };
  return new DocumentStore(doc, { images });
}

/** A 14x12 picture with `ch` on rows 4..7 for columns `from..to` (the limb of fixtures/joint/gappy_elbow). */
function limb(ch: string, from: number, to: number): string {
  const rows: string[] = [];
  for (let y = 0; y < 12; y++) {
    let r = '';
    for (let x = 0; x < 14; x++) r += y >= 4 && y <= 7 && x >= from && x <= to ? ch : '.';
    rows.push(r);
  }
  return rows.join('\n');
}

export interface RigSpec {
  /** `capped` has a 1 px hidden overlap at the elbow (no gaps); `gappy` has none. */
  elbow: 'gappy' | 'capped';
  /** `none`; `stale` (wrong base hash); `ok` (re-based); `error` (a final override whose image is missing). */
  override?: 'none' | 'stale' | 'ok' | 'error';
}

/** Two part layers (`upper`, `lower`), 14x12, pivot (7, 5), one frame. */
export function rigStore(spec: RigSpec): DocumentStore {
  const gen = createIdGenerator({ seed: 9, next: 0 });
  const docId = gen.next('doc');
  const pal = gen.next('palette');
  const layTop = gen.next('layer');
  const layBot = gen.next('layer');
  const boneUpper = gen.next('bone');
  const boneLower = gen.next('bone');
  const partUpper = gen.next('part');
  const partLower = gen.next('part');
  const view = gen.next('view');
  const varUpper = gen.next('variant');
  const varLower = gen.next('variant');
  const imgUpper = gen.next('image');
  const imgLower = gen.next('image');
  const imgDot = gen.next('image');
  const missing = gen.next('image');
  const anim = gen.next('animation');
  const frame = gen.next('frame');
  const ovId = gen.next('override');
  const overrides: Override[] =
    spec.override === 'stale' || spec.override === 'ok'
      ? [
          {
            id: ovId,
            frameId: frame,
            target: { partId: partLower },
            anchor: { x: 1, y: 0 },
            set: imgDot,
            baseHash: '0'.repeat(64),
          },
        ]
      : spec.override === 'error'
        ? [
            {
              id: ovId,
              frameId: frame,
              target: 'final',
              anchor: { x: 0, y: 0 },
              set: missing,
              baseHash: '0'.repeat(64),
            },
          ]
        : [];
  const part = (
    id: typeof partUpper,
    boneId: typeof boneUpper,
    layerId: typeof layTop,
    vid: typeof varUpper,
    imageId: typeof imgUpper,
    pivot: { x: number; y: number },
  ) => ({
    id,
    boneId,
    layerId,
    variants: [{ id: vid, name: 'default', viewId: view, imageId, pivot, tags: [] }],
  });
  const partLayer = (id: typeof layTop, name: string): Layer => ({
    kind: 'part',
    id,
    name,
    visible: true,
    opacity: 255,
    export: true,
  });
  const doc: Document = {
    meta: {
      id: docId,
      name: 'lintrig',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w: 14, h: 12 },
      origin: { x: 7, y: 11 },
      pixelsPerUnit: 16,
      colorMode: 'rgba',
      paletteLocked: false,
      ids: { ...gen.state() },
    },
    palettes: [{ id: pal, name: 'p', colors: [[0, 0, 0, 0]], ramps: [] }],
    activePaletteId: pal,
    skins: [],
    // Bottom to top: the child first, so the parent covers the child's cap.
    layers: [partLayer(layBot, 'lower'), partLayer(layTop, 'upper')],
    rig: {
      bones: [
        { id: boneUpper, name: 'upper', length: 7 },
        { id: boneLower, name: 'lower', parentId: boneUpper, length: 7 },
      ],
      parts: [
        part(partUpper, boneUpper, layTop, varUpper, imgUpper, { x: 0, y: 0 }),
        part(partLower, boneLower, layBot, varLower, imgLower, { x: 7, y: 5 }),
      ],
      views: [
        {
          id: view,
          name: 'side',
          directions: ['side'],
          rest: {
            [boneUpper]: { x: 0, y: 0, angle: 0 },
            [boneLower]: { x: 7, y: 5, angle: 0 },
          },
          partVisibility: {},
          defaultZ: {},
        },
      ],
    },
    animations: [
      {
        id: anim,
        group: 'act',
        direction: 'side',
        loop: 'loop',
        frames: [
          {
            id: frame,
            durationMs: 100,
            markers: {},
            events: [],
            rootMotion: { dx: 0, dy: 0 },
            boneKeys: {},
            partKeys: {},
          },
        ],
        overrides,
      },
    ],
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
  };
  const upper = limb('R', 0, 6);
  // capped: the child also holds the parent's end column (hidden under the parent).
  const lower = limb('B', spec.elbow === 'capped' ? 6 : 7, 13);
  const images: [ImageId, TiledImage][] = [
    [imgUpper, img(upper)],
    [imgLower, img(lower)],
    [imgDot, img('G')],
  ];
  const store = new DocumentStore(doc, { images });
  if (spec.override === 'ok') {
    store.transact('rebase', (tx) => {
      rebaseOverrides(tx, [ovId]);
    });
  }
  return store;
}
