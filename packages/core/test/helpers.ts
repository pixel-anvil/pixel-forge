import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type { AuthoredAnimation, Document, Frame, FrameId, ImageId } from '@pixel-forge/schema';
import { CoreError, DocumentStore } from '../src/index.js';
import type { StoreOptions, StoredImage } from '../src/index.js';

/** Deterministic PRNG (mulberry32), so property tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in `[0, n)`. */
export function int(r: () => number, n: number): number {
  return Math.floor(r() * n);
}

/** The error code thrown by `f` (`'other'` for a non-CoreError), or `undefined`. */
export function codeOf(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    return e instanceof CoreError ? e.code : 'other';
  }
  return undefined;
}

/** A frame with no keys. */
export function blankFrame(id: FrameId, durationMs = 100): Frame {
  return {
    id,
    durationMs,
    markers: {},
    events: [],
    rootMotion: { dx: 0, dy: 0 },
    boneKeys: {},
    partKeys: {},
  };
}

const gen = createIdGenerator({ seed: 7, next: 0 });

/** Ids of the test document, in creation order. */
export const ids = {
  doc: gen.next('doc'),
  pal: gen.next('palette'),
  layBg: gen.next('layer'),
  layGroup: gen.next('layer'),
  laySpark: gen.next('layer'),
  imgBg: gen.next('image'),
  imgSpark: gen.next('image'),
  imgMask: gen.next('image'),
  anim: gen.next('animation'),
  frame0: gen.next('frame'),
  frame1: gen.next('frame'),
} as const;

const idState = gen.state();

/** A small schema-valid RGBA document: a background layer, a group with one layer, one animation. */
export function makeDoc(): Document {
  return {
    meta: {
      id: ids.doc,
      name: 'test',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w: 40, h: 36 },
      origin: { x: 20, y: 34 },
      pixelsPerUnit: 16,
      colorMode: 'rgba',
      paletteLocked: false,
      ids: { ...idState },
    },
    palettes: [
      {
        id: ids.pal,
        name: 'Base',
        colors: [
          [0, 0, 0, 0],
          [255, 0, 0, 255],
        ],
        ramps: [],
      },
    ],
    activePaletteId: ids.pal,
    skins: [],
    layers: [
      {
        kind: 'pixel',
        id: ids.layBg,
        name: 'bg',
        visible: true,
        opacity: 255,
        export: true,
        cels: {
          [ids.frame0]: { imageId: ids.imgBg, offset: { x: 0, y: 0 }, opacity: 255 },
          [ids.frame1]: { linkTo: ids.frame0 },
        },
      },
      {
        kind: 'group',
        id: ids.layGroup,
        name: 'fx',
        visible: true,
        opacity: 255,
        export: true,
        children: [
          {
            kind: 'pixel',
            id: ids.laySpark,
            name: 'spark',
            visible: true,
            opacity: 200,
            export: true,
            cels: {
              [ids.frame0]: { imageId: ids.imgSpark, offset: { x: 3, y: 4 }, opacity: 255 },
            },
          },
        ],
      },
    ],
    animations: [
      {
        id: ids.anim,
        group: 'idle',
        loop: 'loop',
        frames: [blankFrame(ids.frame0), blankFrame(ids.frame1, 150)],
        overrides: [],
      },
    ],
    directionFallback: {},
    markerDefs: [{ name: 'hand_r' }],
    eventDefs: [{ name: 'step' }],
  };
}

/** The images of {@link makeDoc}: a 40x36 RGBA background with 3 pixels, an 8x8 spark, a 20x20 indexed mask. */
export function makeImages(): [ImageId, StoredImage][] {
  const bg = new TiledImage(40, 36);
  bg.set(0, 0, [10, 20, 30, 255]);
  bg.set(17, 3, [40, 50, 60, 255]);
  bg.set(39, 35, [70, 80, 90, 128]);
  const spark = new TiledImage(8, 8);
  spark.set(4, 4, [255, 255, 0, 255]);
  const mask = new IndexedImage(20, 20);
  mask.set(1, 1, 255);
  return [
    [ids.imgBg, bg],
    [ids.imgSpark, spark],
    [ids.imgMask, mask],
  ];
}

/** A store over {@link makeDoc} and {@link makeImages}. */
export function makeStore(options: Omit<StoreOptions, 'images'> = {}): DocumentStore {
  return new DocumentStore(makeDoc(), { ...options, images: makeImages() });
}

/** The (only) authored animation of a draft or document. */
export function authored(d: Document): AuthoredAnimation {
  const a = d.animations[0];
  if (a === undefined || 'mirrorOf' in a) throw new Error('fixture has one authored animation');
  return a;
}

/** Narrow a stored image to RGBA. */
export function rgba(img: StoredImage | undefined): TiledImage {
  if (!(img instanceof TiledImage)) throw new Error('expected a TiledImage');
  return img;
}
