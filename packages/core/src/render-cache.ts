/**
 * The `renderFrame` memo and the render input key (the `.pxf` per-frame hash, spec 7).
 * @packageDocumentation
 */
import { IndexedImage, sha256Hex } from '@pixel-forge/raster';
import type { TiledImage } from '@pixel-forge/raster';
import type { AnimRef, FrameRef, ImageId, Override } from '@pixel-forge/schema';
import { utf8 } from './hash.js';
import { imageHash } from './images.js';
import type { StoredImage } from './images.js';
import { canonicalJson } from './json.js';
import type { DeepReadonly, JsonValue } from './json.js';
import { planFrame, renderPlan, skinPaletteOf } from './render.js';
import type { RenderOptions, RenderPlan, ResolvedOverride } from './render.js';
import type { DocumentView } from './view.js';

const KEY_VERSION = 1;

const imageDesc = (img: StoredImage): string =>
  `${img instanceof IndexedImage ? 'i' : 'r'}:${imageHash(img)}`;

/** Override content that reaches the pixels: id, anchor and the two images (kind plus hash). */
const overrideDesc = (o: ResolvedOverride): JsonValue => ({
  id: o.override.id,
  anchor: o.override.anchor,
  set: o.set === undefined ? null : imageDesc(o.set),
  erase: o.erase === undefined ? null : imageDesc(o.erase),
});

/** A part override of this frame: like {@link overrideDesc} plus the target part, read from the view. */
function partOverrideDesc(view: DocumentView, o: DeepReadonly<Override>): JsonValue {
  const img = (id: ImageId | undefined): JsonValue => {
    if (id === undefined) return null;
    const i = view.image(id);
    return i === undefined ? `missing:${id}` : imageDesc(i);
  };
  return {
    id: o.id,
    target: o.target,
    anchor: o.anchor,
    set: img(o.set),
    erase: img(o.erase),
  };
}

function describe(view: DocumentView, plan: RenderPlan, opts: RenderOptions): JsonValue {
  const meta = view.doc.meta;
  const hasParts = plan.parts.length > 0;
  const palette = meta.colorMode === 'indexed' || plan.skin !== undefined;
  const skinPalette = skinPaletteOf(view, plan.skin);
  let rig: JsonValue = null;
  if (hasParts) {
    const src = plan.source;
    const layers = plan.parts.map((p) => ({ id: p.layer.id, opacity: p.opacity }));
    const renderKey = opts.rig?.renderKey;
    if (renderKey === undefined) {
      // An unknown renderer may read anything: every image and the whole animation node.
      const images: Record<string, JsonValue> = {};
      for (const id of view.imageIds()) {
        const img = view.image(id);
        if (img !== undefined) images[id] = imageDesc(img);
      }
      rig = {
        present: opts.rig !== undefined,
        layers,
        animation: src,
        frameIndex: plan.frameIndex,
        definition: view.doc.rig ?? null,
        images,
      };
    } else {
      // The renderer says it is rig's `renderParts` (T3.3) by its `renderKey`, which reads: the rig,
      // the variant images, every frame's bone and part keys (interpolation looks at the
      // neighbouring keys), loop, quantum and direction, and this frame's part overrides with their
      // images (described like the final overrides: set and erase with image kind and hash).
      const partOverrides = src.overrides.filter(
        (o) => o.frameId === plan.frame.id && o.target !== 'final',
      );
      const variants: Record<string, JsonValue> = {};
      for (const p of view.doc.rig?.parts ?? []) {
        for (const v of p.variants) {
          const img = view.image(v.imageId);
          variants[v.imageId] = img === undefined ? null : imageDesc(img);
        }
      }
      rig = {
        present: true,
        renderer: renderKey,
        layers,
        animation: {
          direction: src.direction ?? null,
          loop: src.loop,
          angleQuantum: src.angleQuantum ?? null,
          keys: src.frames.map((f) => ({ bone: f.boneKeys, part: f.partKeys })),
          partOverrides: partOverrides.map((o) => partOverrideDesc(view, o)),
        },
        frameIndex: plan.frameIndex,
        definition: view.doc.rig ?? null,
        variants,
      };
    }
  }
  const d = {
    v: KEY_VERSION,
    canvas: meta.canvas,
    colorMode: meta.colorMode,
    mirror: plan.mirrored
      ? { origin: meta.origin, finals: plan.mirrorFinals.map(overrideDesc) }
      : null,
    items: plan.items.map((i) => ({
      layer: i.layerId,
      image: imageDesc(i.image),
      x: i.x,
      y: i.y,
      opacity: i.opacity,
    })),
    rigAt: hasParts ? plan.rigAt : null,
    postPasses: plan.postPasses ?? null,
    finals: plan.finals.map(overrideDesc),
    rig,
    palette: palette ? (plan.palette ?? null) : null,
    skin: plan.skin ?? 'base',
    skinPalette: skinPalette ?? null,
  };
  return d;
}

/**
 * The render input key of one frame: lower-case hex SHA-256 of the canonical JSON of everything that
 * affects `renderFrame`'s output, namely: key version, canvas and colour mode, the origin (mirrors
 * only) with the mirror's own final overrides, every image drawn (kind plus `imageHash`) with layer
 * id, offset and final opacity (layer chain times cel opacity), the post-passes config, the final
 * overrides of the frame (id, anchor, set and erase image hashes, in order), the active palette
 * (indexed documents and skins), the skin (or `base`) and its palette, and, when the frame has part
 * layers, the position of the rig block among the pixel layers and the inputs of the part pipeline
 * (part layers with opacity, whether the renderer exists, the renderer's `renderKey`, the source
 * animation's direction, loop, quantum and the bone and part keys of all its frames, this frame's part
 * overrides (id, target, anchor, set and erase image hashes, in order), the frame index, `doc.rig`,
 * and the hashes of the variant images). Durations, markers, `baseHash`, images nothing draws and
 * other frames' overrides are not in it. That narrowing applies only to a renderer that gives a
 * `renderKey` (`createRigRenderer` does); for one without a key the key holds the whole animation
 * node and every image of the document, as it did before T3.3. A mirror's part overrides are not in
 * the key yet (T3.6).
 *
 * Hence it changes iff an input that can reach the pixels changes: renaming a layer, editing a hidden
 * or filtered-out layer, or touching another animation leaves it unchanged. Throws like `renderFrame`
 * for unresolvable references. It does not need `opts.rig` to render, so the `.pxf` writer can key
 * frames without rendering them.
 */
export function renderInputKey(
  view: DocumentView,
  anim: AnimRef,
  frame: FrameRef,
  opts: RenderOptions = {},
): string {
  const plan = planFrame(view, anim, frame, opts);
  return sha256Hex(utf8(canonicalJson(describe(view, plan, opts))));
}

/** A memoising `renderFrame`; see {@link createFrameRenderer}. */
export interface FrameRenderer {
  (view: DocumentView, anim: AnimRef, frame: FrameRef, opts?: RenderOptions): TiledImage;
  /** Cache hits and misses since creation. */
  readonly stats: { hits: number; misses: number };
  /** Drops every cached frame. */
  clear(): void;
}

/**
 * A `renderFrame` with an internal memo (no global state). The memo key is built from object
 * identities: the frozen document nodes (meta, skin, palette, animation, post-passes, overrides, `doc.rig`), the image
 * instances with their `version`, the rig renderer instance, and the resolved draw list (layer,
 * offset, final opacity), so it needs no pixel hashing and survives unrelated edits (a store keeps
 * unchanged nodes). Identities are numbered through `WeakMap`s, so nothing is retained by the key.
 * The memo keeps at most `capacity` frames (least recently used out). A hit returns a copy-on-write
 * clone, so callers may mutate their result freely.
 *
 * A rig renderer must follow the hook contract (pure, keyed on its inputs): with part layers, the
 * key includes `doc.rig`, the animation node, all image instances and the renderer instance.
 */
export function createFrameRenderer(capacity = 64): FrameRenderer {
  const ids = new WeakMap<object, number>();
  let next = 0;
  const idOf = (o: object | undefined): string => {
    if (o === undefined) return '-';
    let n = ids.get(o);
    if (n === undefined) {
      n = ++next;
      ids.set(o, n);
    }
    return String(n);
  };
  const memo = new Map<string, TiledImage>();
  const stats = { hits: 0, misses: 0 };

  const overrideId = (o: ResolvedOverride): string => {
    const img = (i: StoredImage | undefined): string =>
      i === undefined ? '-' : `${idOf(i)}.${String(i.version)}`;
    const { x, y } = o.override.anchor;
    return `o${idOf(o.override)}@${String(x)},${String(y)}s${img(o.set)}e${img(o.erase)}`;
  };

  const render = (
    view: DocumentView,
    anim: AnimRef,
    frame: FrameRef,
    opts: RenderOptions = {},
  ): TiledImage => {
    const plan = planFrame(view, anim, frame, opts);
    const doc = view.doc;
    const parts: string[] = [
      idOf(doc.meta),
      plan.mirrored ? 'm' : 'a',
      idOf(plan.skin),
      idOf(plan.palette),
      idOf(skinPaletteOf(view, plan.skin)),
      `R${String(plan.rigAt)}`,
      `pp${idOf(plan.postPasses)}`,
      ...plan.finals.map(overrideId),
      'M',
      ...plan.mirrorFinals.map(overrideId),
      ...plan.items.map(
        (i) =>
          `${i.layerId}:${idOf(i.image)}.${String(i.image.version)}@${String(i.x)},${String(i.y)}*${String(i.opacity)}`,
      ),
    ];
    if (plan.parts.length > 0) {
      parts.push(
        'P',
        idOf(opts.rig),
        idOf(plan.source),
        String(plan.frameIndex),
        idOf(doc.rig),
        ...plan.parts.map((p) => `${p.layer.id}*${String(p.opacity)}`),
        ...view.imageIds().map((id) => {
          const img = view.image(id);
          return img === undefined ? id : `${id}:${idOf(img)}.${String(img.version)}`;
        }),
      );
    }
    const key = parts.join('|');
    const hit = memo.get(key);
    if (hit !== undefined) {
      stats.hits++;
      memo.delete(key);
      memo.set(key, hit);
      return hit.clone();
    }
    stats.misses++;
    const out = renderPlan(view, plan, opts);
    memo.set(key, out);
    while (memo.size > capacity) {
      const oldest = memo.keys().next();
      if (oldest.done === true) break;
      memo.delete(oldest.value);
    }
    return out.clone();
  };
  return Object.assign(render, {
    stats,
    clear: (): void => {
      memo.clear();
    },
  });
}
