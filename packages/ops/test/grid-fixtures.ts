// Small flat (rig-less) documents for the grid and render op tests, adopted into a memory host.
import { DocumentStore } from '@pixel-forge/core';
import { MemoryFileSystem, fixedClock } from '@pixel-forge/io';
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type { Document, Frame, FrameId, ImageId, LayerId } from '@pixel-forge/schema';
import { createMemoryHost } from '../src/index.js';
import type { HostedDocument, OpHost, RunOptions } from '../src/index.js';

/** Fixed ids of the flat document. */
const gen = createIdGenerator({ seed: 11, next: 0 });
export const FLAT = {
  doc: gen.next('doc'),
  pal: gen.next('palette'),
  layBg: gen.next('layer'),
  layFg: gen.next('layer'),
  imgBg: gen.next('image'),
  imgFg: gen.next('image'),
  anim: gen.next('animation'),
  frame0: gen.next('frame'),
  frame1: gen.next('frame'),
} as const;
const idState = gen.state();

/** Options of {@link flatHost}. */
export interface FlatOptions {
  readonly w?: number;
  readonly h?: number;
  readonly indexed?: boolean;
  readonly paletteLocked?: boolean;
  /** Add a second pixel layer ("fg") so the layer must be named. */
  readonly twoLayers?: boolean;
  /** Paints the "bg" cel of frame 0 (RGBA documents). */
  readonly paint?: (img: TiledImage) => void;
}

/** The palette of indexed flat documents: transparent, red, green, blue. */
export const FLAT_PALETTE: [number, number, number, number][] = [
  [0, 0, 0, 0],
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
];

/** A host holding one flat document: layer "bg" (cel on frame 0, frame 1 links to it), animation "idle". */
export async function openFlat(options: FlatOptions = {}): Promise<{
  host: OpHost;
  hosted: HostedDocument;
  run: RunOptions;
  frame0: FrameId;
  frame1: FrameId;
}> {
  const w = options.w ?? 8;
  const h = options.h ?? 6;
  const indexed = options.indexed === true;
  const layer = (
    id: LayerId,
    name: string,
    imageId: ImageId,
    link: boolean,
  ): Document['layers'][number] => ({
    kind: 'pixel',
    id,
    name,
    visible: true,
    opacity: 255,
    export: true,
    cels: {
      [FLAT.frame0]: { imageId, offset: { x: 0, y: 0 }, opacity: 255 },
      ...(link ? { [FLAT.frame1]: { linkTo: FLAT.frame0 } } : {}),
    },
  });
  const frame = (id: FrameId): Frame => ({
    id,
    durationMs: 100,
    markers: {},
    events: [],
    rootMotion: { dx: 0, dy: 0 },
    boneKeys: {},
    partKeys: {},
  });
  const doc: Document = {
    meta: {
      id: FLAT.doc,
      name: 'flat',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w, h },
      origin: { x: 0, y: h - 1 },
      pixelsPerUnit: 16,
      colorMode: indexed ? 'indexed' : 'rgba',
      paletteLocked: options.paletteLocked === true,
      ids: { ...idState },
    },
    palettes:
      indexed || options.paletteLocked === true
        ? [
            {
              id: FLAT.pal,
              name: 'Base',
              colors: FLAT_PALETTE.map((c): [number, number, number, number] => [
                c[0],
                c[1],
                c[2],
                c[3],
              ]),
              ramps: [],
            },
          ]
        : [],
    ...(indexed || options.paletteLocked === true ? { activePaletteId: FLAT.pal } : {}),
    skins: [],
    layers: [
      layer(FLAT.layBg, 'bg', FLAT.imgBg, true),
      ...(options.twoLayers === true ? [layer(FLAT.layFg, 'fg', FLAT.imgFg, false)] : []),
    ],
    animations: [
      {
        id: FLAT.anim,
        group: 'idle',
        loop: 'loop',
        frames: [frame(FLAT.frame0), frame(FLAT.frame1)],
        overrides: [],
      },
    ],
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
  };
  const bg = indexed ? new IndexedImage(w, h, 0) : new TiledImage(w, h);
  if (bg instanceof TiledImage) options.paint?.(bg);
  const images: [ImageId, TiledImage | IndexedImage][] = [[FLAT.imgBg, bg]];
  if (options.twoLayers === true) {
    images.push([FLAT.imgFg, indexed ? new IndexedImage(w, h, 0) : new TiledImage(w, h)]);
  }
  const store = new DocumentStore(doc, { images });
  const host = createMemoryHost({
    fs: new MemoryFileSystem(),
    clock: fixedClock('2026-11-01T00:00:00Z'),
  });
  const hosted = await host.adopt({ store });
  return { host, hosted, run: { host }, frame0: FLAT.frame0, frame1: FLAT.frame1 };
}
