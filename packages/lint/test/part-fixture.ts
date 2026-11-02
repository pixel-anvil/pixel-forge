/**
 * A synthetic one-bone, one-part document for the lint tests of `pixels.clipped` and
 * `rig.partHole`: a small canvas, one bone, one part, one frame per angle (a bone key each).
 */
import { DocumentStore } from '@pixel-forge/core';
import { TiledImage } from '@pixel-forge/raster';
import { SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type { Document, ImageId } from '@pixel-forge/schema';
import { asciiToImage } from '@pixel-forge/testkit';

const LEGEND = { R: [255, 0, 0, 255] } as const;

export interface PartSpec {
  w: number;
  h: number;
  /** Drawn art, ASCII: `R` is opaque red, `.` is transparent. */
  art: string;
  /** The variant pivot (a pixel of the art). */
  pivot: { x: number; y: number };
  /** Where the bone's pivot sits on the canvas at rest. */
  at: { x: number; y: number };
  /** One frame per angle (degrees clockwise, a bone key on the single bone). */
  angles: number[];
  /** Add a mirror animation of the authored one. */
  mirror?: boolean;
  /** Hide the part layer. */
  hidden?: boolean;
  /** Origin column x (default `at.x`); the mirror flips about it. */
  originX?: number;
  /** The part's `maxResidualDeg` (default: unset). */
  maxResidualDeg?: number;
}

/** Builds the document of `spec`. */
export function partStore(spec: PartSpec): DocumentStore {
  const gen = createIdGenerator({ seed: 3, next: 0 });
  const docId = gen.next('doc');
  const pal = gen.next('palette');
  const lay = gen.next('layer');
  const bone = gen.next('bone');
  const part = gen.next('part');
  const view = gen.next('view');
  const variant = gen.next('variant');
  const image = gen.next('image');
  const anim = gen.next('animation');
  const mirror = gen.next('animation');
  const frames = spec.angles.map((angle) => ({
    id: gen.next('frame'),
    durationMs: 100,
    markers: {},
    events: [],
    rootMotion: { dx: 0, dy: 0 },
    boneKeys: { [bone]: { angle } },
    partKeys: {},
  }));
  const doc: Document = {
    meta: {
      id: docId,
      name: 'lintpart',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w: spec.w, h: spec.h },
      origin: { x: spec.originX ?? spec.at.x, y: spec.h - 1 },
      pixelsPerUnit: 16,
      colorMode: 'rgba',
      paletteLocked: false,
      ids: { ...gen.state() },
    },
    palettes: [{ id: pal, name: 'p', colors: [[0, 0, 0, 0]], ramps: [] }],
    activePaletteId: pal,
    skins: [],
    layers: [
      {
        kind: 'part',
        id: lay,
        name: 'p',
        visible: spec.hidden !== true,
        opacity: 255,
        export: true,
      },
    ],
    rig: {
      bones: [{ id: bone, name: 'b', length: 4 }],
      parts: [
        {
          id: part,
          boneId: bone,
          layerId: lay,
          ...(spec.maxResidualDeg === undefined ? {} : { maxResidualDeg: spec.maxResidualDeg }),
          variants: [
            {
              id: variant,
              name: 'default',
              viewId: view,
              imageId: image,
              pivot: spec.pivot,
              tags: [],
            },
          ],
        },
      ],
      views: [
        {
          id: view,
          name: 'side',
          directions: ['side'],
          rest: { [bone]: { x: spec.at.x, y: spec.at.y, angle: 0 } },
          partVisibility: {},
          defaultZ: {},
        },
      ],
    },
    animations: [
      { id: anim, group: 'act', direction: 'side', loop: 'loop', frames, overrides: [] },
      ...(spec.mirror === true
        ? [{ id: mirror, group: 'act', direction: 'west', mirrorOf: anim, overrides: [] }]
        : []),
    ],
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
  };
  const images: [ImageId, TiledImage][] = [
    [image, TiledImage.fromRGBA(asciiToImage(spec.art, LEGEND))],
  ];
  return new DocumentStore(doc, { images });
}
