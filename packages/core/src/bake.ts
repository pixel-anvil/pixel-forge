/**
 * `bakeAnimation` (FR-RIG-23, T3.7): turns a rig animation into a plain pixel animation. One
 * transaction edit; the confirmation for `replace` is the ops layer's job. See the package README
 * ("Bake") for the decisions recorded here.
 * @packageDocumentation
 */
import { IndexedImage } from '@pixel-forge/raster';
import type { Rgba, TiledImage } from '@pixel-forge/raster';
import { Name } from '@pixel-forge/schema';
import type {
  AnimRef,
  AnimationId,
  AuthoredAnimation,
  Document,
  Frame,
  FrameId,
  ImageId,
  Layer,
  LayerId,
  OverrideId,
  PartId,
  PartKey,
  PixelLayer,
} from '@pixel-forge/schema';
import { CoreError } from './errors.js';
import { referencedImages, resolveAnimation } from './frames.js';
import type { DeepReadonly } from './json.js';
import { renderFrame } from './render.js';
import type { RigRenderer } from './rig-hook.js';
import { createRigRenderer } from './rig-render.js';
import type { Transaction } from './transaction.js';

/** Why a bake was refused (`CoreError.details.reason`; code `BAD_ARGUMENT` unless noted). */
export type BakeReason =
  | 'unknown-animation'
  | 'mirror-animation'
  | 'bad-name'
  | 'name-taken'
  /** `BAD_VALUE`: an indexed document has no palette entry with alpha 0 for transparency. */
  | 'no-transparent-index'
  /** `BAD_VALUE`: an indexed document's render has a colour that is not an exact palette entry. */
  | 'not-indexable';

/** Options of {@link bakeAnimation}. */
export interface BakeOptions {
  /** `new`: add a baked animation, keep the source. `replace`: the source animation is baked in place. */
  readonly mode: 'new' | 'replace';
  /**
   * `new` only: group name of the new animation (the direction is the source's). Default
   * `<group>_baked`. Refused when `(name, direction)` exists. Ignored by `replace`.
   */
  readonly name?: string;
  /** Part renderer; default a fresh `createRigRenderer()`. */
  readonly rig?: RigRenderer;
}

/** What {@link bakeAnimation} dropped from the source animation (`replace` only; all zero for `new`). */
export interface BakeDropped {
  readonly boneKeys: number;
  readonly partKeys: number;
  readonly overrides: readonly OverrideId[];
  readonly postPasses: boolean;
  /** Cels of drawn pixel layers at the baked frames, now part of the baked layer. */
  readonly cels: number;
}

/** Result of {@link bakeAnimation}. */
export interface BakeResult {
  readonly animationId: AnimationId;
  /** The new pixel layer that holds the baked pixels. */
  readonly layerId: LayerId;
  /** Frame ids of the baked animation, in play order (the source's own ids in `replace`). */
  readonly frames: readonly FrameId[];
  readonly dropped: BakeDropped;
}

const refuse = (reason: BakeReason, message: string): CoreError =>
  new CoreError('BAD_ARGUMENT', message, { reason });

/** Converts a render to an indexed image by exact palette match (alpha 0 is the transparent index). */
function toIndexed(img: TiledImage, palette: readonly Rgba[], transparent: number): IndexedImage {
  const lut = new Map<number, number>();
  palette.forEach((c, i) => {
    if (c[3] === 0) return;
    const key = ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) >>> 0;
    if (!lut.has(key)) lut.set(key, i);
  });
  const { data, width, height } = img.toRGBA();
  const out = new Uint8Array(width * height).fill(transparent);
  for (let p = 0; p < out.length; p++) {
    const o = p * 4;
    const a = data[o + 3] ?? 0;
    if (a === 0) continue;
    const key =
      (((data[o] ?? 0) << 24) | ((data[o + 1] ?? 0) << 16) | ((data[o + 2] ?? 0) << 8) | a) >>> 0;
    const i = lut.get(key);
    if (i === undefined) {
      throw new CoreError('BAD_VALUE', 'the render has a colour that is not a palette entry', {
        reason: 'not-indexable' satisfies BakeReason,
        x: p % width,
        y: Math.floor(p / width),
      });
    }
    out[p] = i;
  }
  return IndexedImage.fromIndices(width, height, out, transparent);
}

type LayerRo = DeepReadonly<Layer>;

/** Ids of the pixel layers a render with `exportOnly` draws: visible and exported with all ancestors. */
function drawnPixelLayers(layers: readonly LayerRo[], out = new Set<string>()): Set<string> {
  for (const l of layers) {
    if (!l.visible || !l.export) continue;
    if (l.kind === 'group') drawnPixelLayers(l.children, out);
    else if (l.kind === 'pixel') out.add(l.id);
  }
  return out;
}

function allLayerNames(layers: readonly LayerRo[], out = new Set<string>()): Set<string> {
  for (const l of layers) {
    out.add(l.name);
    if (l.kind === 'group') allLayerNames(l.children, out);
  }
  return out;
}

/** True when `l` is a part layer or a group that holds one, at any depth. */
function holdsPart(l: LayerRo): boolean {
  return l.kind === 'part' || (l.kind === 'group' && l.children.some(holdsPart));
}

/**
 * The index among the root layers of the one that holds the first part layer (the rig block's slot): the
 * part layer itself or its top-level ancestor group. `undefined` without part layers.
 */
function rigBlockTopIndex(layers: readonly LayerRo[]): number | undefined {
  const i = layers.findIndex(holdsPart);
  return i < 0 ? undefined : i;
}

/**
 * Bakes the authored animation `animRef` into plain pixels, in the open transaction.
 *
 * **What is baked.** Every frame is rendered with `renderFrame(tx, animRef, i, {exportOnly: true,
 * rig})`: parts, part overrides, post-passes, final overrides and the other exported pixel layers,
 * with no skin (a skin still applies afterwards, by colour). The pixels of frame `i` equal that render.
 *
 * **Where.** One new pixel layer `baked` (`baked_2`, ... when the name is taken among all layers;
 * visible, opacity 255, `export: true`), inserted at the **top level** of the layer tree, at the position
 * of the top-level layer that holds the first part layer (the rig block's slot; the layer itself, or its
 * outermost group), else on top of the root. It is never put inside a group: the render it holds already
 * contains the group's opacity, visibility and export flag, which the baked layer must not inherit. Its cels are full-canvas images at offset (0, 0),
 * in the document's colour mode (an indexed document needs every colour to be an exact palette
 * entry). A fully transparent frame gets no cel. Identical consecutive frames are kept as separate
 * cels (no `linkTo`).
 *
 * **Part layers stay** (other animations use them). **Every** frame of the baked animation carries a
 * part key `visible: false` for every part, so the rig draws nothing for it whichever frame comes first
 * (deleting or reordering frames keeps it hidden); it still needs the `rig` renderer whenever part
 * layers exist.
 *
 * **`new`**: an authored animation `name` (default `<group>_baked`; same direction, loop, durations,
 * markers, events and root motion; fresh frame ids; no bone keys, overrides or post-passes). The
 * source is untouched.
 *
 * **`replace`**: the animation keeps its id, name and frame ids (so mirrors and their own final
 * overrides keep working) and loses its bone keys, part keys (replaced by the hide-all key), own
 * overrides (and their images), post-passes and `angleQuantum`; this is reported in `dropped`. The cels
 * of the pixel layers the render drew, at the baked frames, are consumed (they are in the baked
 * layer now); a link from another frame to a consumed cel is materialised first.
 *
 * **Mirrors stay derived** ("bake mirror" is M3). Baking a source leaves its mirrors correct: the
 * flip of the baked pixels equals the flip of the rig render. Baking a mirror animation is refused.
 *
 * @throws CoreError `BAD_ARGUMENT` (`BakeReason`), `BAD_VALUE` (`no-transparent-index`,
 * `not-indexable`) and whatever `renderFrame` throws.
 */
export function bakeAnimation(tx: Transaction, animRef: AnimRef, opts: BakeOptions): BakeResult {
  const doc: DeepReadonly<Document> = tx.doc;
  const index = resolveAnimation(doc, animRef);
  const src = doc.animations[index];
  if (src === undefined) throw new Error('unreachable');
  if ('mirrorOf' in src) {
    throw refuse('mirror-animation', `animation ${src.id} is a mirror: bake its source`);
  }
  const replace = opts.mode === 'replace';
  const group = opts.name ?? `${src.group}_baked`;
  if (!replace) {
    if (!Name.safeParse(group).success) throw refuse('bad-name', `bad animation name ${group}`);
    const taken = doc.animations.some((a) => a.group === group && a.direction === src.direction);
    if (taken) throw refuse('name-taken', `animation ${group} already exists in this direction`);
  }

  // Render everything first: an error leaves the document untouched.
  const rig = opts.rig ?? createRigRenderer();
  const indexed = doc.meta.colorMode === 'indexed';
  const palette = doc.palettes.find((p) => p.id === doc.activePaletteId)?.colors;
  let transparent = 0;
  if (indexed) {
    const t = palette?.findIndex((c) => c[3] === 0) ?? -1;
    if (t < 0) {
      throw new CoreError('BAD_VALUE', 'an indexed bake needs a palette entry with alpha 0', {
        reason: 'no-transparent-index' satisfies BakeReason,
      });
    }
    transparent = t;
  }
  const rendered = src.frames.map((_, i) => {
    const img = renderFrame(tx, animRef, i, { exportOnly: true, rig });
    const empty = img.bounds() === undefined;
    const stored = indexed && palette !== undefined ? toIndexed(img, palette, transparent) : img;
    return { empty, stored };
  });

  // Plan.
  const drawn = drawnPixelLayers(doc.layers);
  const names = allLayerNames(doc.layers);
  let layerName = 'baked';
  for (let n = 2; names.has(layerName); n++) layerName = `baked_${String(n)}`;
  const layerId = tx.newId('layer');
  const animationId: AnimationId = replace ? src.id : tx.newId('animation');
  const frameIds: FrameId[] = replace
    ? src.frames.map((f) => f.id)
    : src.frames.map(() => tx.newId('frame'));
  const hide: Record<PartId, PartKey> = {};
  for (const p of doc.rig?.parts ?? []) hide[p.id] = { visible: false };

  const cels: PixelLayer['cels'] = {};
  rendered.forEach((r, i) => {
    const fid = frameIds[i];
    if (r.empty || fid === undefined) return;
    cels[fid] = { imageId: tx.createImage(r.stored), offset: { x: 0, y: 0 }, opacity: 255 };
  });
  const layer: PixelLayer = {
    kind: 'pixel',
    id: layerId,
    name: layerName,
    visible: true,
    opacity: 255,
    export: true,
    cels,
  };

  const dropped = {
    boneKeys: 0,
    partKeys: 0,
    overrides: [] as OverrideId[],
    postPasses: false,
    cels: 0,
  };
  const candidates = new Set<ImageId>();

  if (replace) {
    const baked = new Set<string>(frameIds);
    for (const f of src.frames) {
      dropped.boneKeys += Object.keys(f.boneKeys).length;
      dropped.partKeys += Object.keys(f.partKeys).length;
    }
    for (const o of src.overrides) {
      dropped.overrides.push(o.id);
      if (o.set !== undefined) candidates.add(o.set);
      if (o.erase !== undefined) candidates.add(o.erase);
    }
    dropped.postPasses = src.postPasses !== undefined;
    // Cels to consume; links from other frames to them are materialised.
    const cloneInfo = new Map<
      string,
      { imageId: ImageId; offset: { x: number; y: number }; opacity: number }
    >();
    const walk = (ls: readonly LayerRo[]): void => {
      for (const l of ls) {
        if (l.kind === 'group') walk(l.children);
        else if (l.kind === 'pixel' && drawn.has(l.id)) {
          for (const [fid, c] of Object.entries(l.cels)) {
            if (baked.has(fid)) {
              dropped.cels++;
              if ('imageId' in c) candidates.add(c.imageId);
            } else if ('linkTo' in c && baked.has(c.linkTo)) {
              const target = l.cels[c.linkTo];
              if (target !== undefined && 'imageId' in target) {
                const image = tx.image(target.imageId);
                if (image === undefined) {
                  throw new CoreError('IMAGE_MISSING', `no image ${target.imageId}`, {
                    imageId: target.imageId,
                  });
                }
                cloneInfo.set(`${l.id}/${fid}`, {
                  imageId: tx.createImage(image),
                  offset: { ...target.offset },
                  opacity: target.opacity,
                });
              }
            }
          }
        }
      }
    };
    walk(doc.layers);
    tx.update((d) => {
      const an = d.animations[index];
      if (an === undefined || 'mirrorOf' in an) return;
      for (const f of an.frames) {
        f.boneKeys = {};
        f.partKeys = { ...hide };
      }
      an.overrides = [];
      delete an.postPasses;
      delete an.angleQuantum;
      const strip = (ls: Layer[]): void => {
        for (const l of ls) {
          if (l.kind === 'group') strip(l.children);
          else if (l.kind === 'pixel' && drawn.has(l.id)) {
            for (const [fid, c] of Object.entries(l.cels)) {
              if (baked.has(fid)) continue;
              const clone = cloneInfo.get(`${l.id}/${fid}`);
              if (clone !== undefined && 'linkTo' in c) l.cels[fid as FrameId] = clone;
            }
            for (const fid of baked) Reflect.deleteProperty(l.cels, fid);
          }
        }
      };
      strip(d.layers);
    });
  } else {
    const frames: Frame[] = src.frames.map((f, i) => ({
      id: frameIds[i] ?? f.id,
      durationMs: f.durationMs,
      markers: { ...f.markers },
      events: [...f.events],
      rootMotion: { ...f.rootMotion },
      boneKeys: {},
      partKeys: { ...hide },
    }));
    const anim: AuthoredAnimation = {
      id: animationId,
      group,
      ...(src.direction === undefined ? {} : { direction: src.direction }),
      loop: src.loop,
      frames,
      overrides: [],
    };
    tx.update((d) => {
      d.animations.push(anim);
    });
  }

  tx.update((d) => {
    const at = rigBlockTopIndex(d.layers);
    if (at === undefined) d.layers.push(layer);
    else d.layers.splice(at, 0, layer);
  });

  if (candidates.size > 0) {
    const still = referencedImages(tx.doc);
    for (const id of candidates)
      if (!still.has(id) && tx.image(id) !== undefined) tx.deleteImage(id);
  }
  return { animationId, layerId, frames: frameIds, dropped };
}
