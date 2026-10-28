/**
 * The `.pxf` render cache (spec 7, 3.4 clarifications 1, 3, 4, 10): `render/index.json` plus one
 * flattened PNG per frame and skin, which is all the Godot importer reads.
 *
 * Naming: animations are listed as `animations[group][direction]`, an undirected animation under the
 * direction key `default`; skin `base` is the unskinned render, then one skin per document skin.
 * Frame PNGs live at `render/<skin>/<group>/<direction>/<n>.png` (`n` = 0-based frame index) and
 * `image` in the index is the path relative to `render/<skin>/`. Frames whose hashes are equal share
 * the PNG of the first one (in sorted group, direction, index order).
 * @packageDocumentation
 */
import { CoreError, renderFrame, renderInputKey } from '@pixel-forge/core';
import type { DeepReadonly, DocumentView, RigRenderer } from '@pixel-forge/core';
import { encodePng } from '@pixel-forge/png';
import { sha256Hex } from '@pixel-forge/raster';
import type {
  Animation,
  AuthoredAnimation,
  Frame,
  RenderAnimation,
  RenderFrame,
  RenderIndex,
} from '@pixel-forge/schema';
import { BASE_SKIN_KEY, SCHEMA_VERSION, UNDIRECTED_KEY } from '@pixel-forge/schema';
import { strToU8 } from 'fflate';
import { IoError } from '../errors.js';
import type { PxfFile } from './file.js';

/** Options of {@link buildRenderCache}. */
export interface RenderCacheOptions {
  /**
   * Document skin names to render besides `base` (which is always rendered). Default: every skin of
   * the document, in document order.
   */
  readonly skins?: readonly string[];
  /** The part renderer; required when an exported part layer is drawn in some frame. */
  readonly rig?: RigRenderer;
  /** The previous file: frames whose hash is unchanged reuse its PNG bytes instead of rendering. */
  readonly previous?: PxfFile;
}

/** A built cache: the index and the PNG bytes keyed by path relative to `render/`. */
export interface RenderCache {
  readonly index: RenderIndex;
  readonly pngs: Map<string, Uint8Array>;
  /** Frames rendered and encoded (not reused, not shared) in this build. */
  readonly rendered: number;
  /** Frames whose PNGs were reused from `previous`. */
  readonly reused: number;
}

type Anim = DeepReadonly<Animation>;
type Authored = DeepReadonly<AuthoredAnimation>;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The direction key of an animation: its direction, or `default` (`UNDIRECTED_KEY`). */
export function directionKey(a: { readonly direction?: string }): string {
  return a.direction ?? UNDIRECTED_KEY;
}

/** The skins to render, `base` first. Unknown requested names are an error. */
function skinList(view: DocumentView, wanted: readonly string[] | undefined): string[] {
  const names = view.doc.skins.map((s) => s.name);
  if (wanted !== undefined) {
    for (const w of wanted) {
      if (w !== BASE_SKIN_KEY && !names.includes(w)) {
        throw new IoError('BAD_INPUT', `the document has no skin '${w}'`);
      }
    }
  }
  const keep = names.filter((n) => wanted === undefined || wanted.includes(n));
  return [BASE_SKIN_KEY, ...new Set(keep)];
}

/** PNG bytes of the previous cache by `<hash>|<skin>`. */
function previousPngs(previous: PxfFile | undefined): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const index = previous?.renderIndex;
  if (previous === undefined || index === undefined) return out;
  for (const dirs of Object.values(index.animations)) {
    for (const anim of Object.values(dirs)) {
      if (!('frames' in anim)) continue;
      for (const f of anim.frames) {
        for (const skin of index.skins) {
          const bytes = previous.renderPngs.get(`${skin}/${f.image}`);
          if (bytes !== undefined) out.set(`${f.hash}|${skin}`, bytes);
        }
      }
    }
  }
  return out;
}

/**
 * The hash stored in the index for a frame: its `renderInputKey` for `base` alone, or, with skins,
 * the SHA-256 of the keys of all rendered skins (`base` first, joined by newlines), so any skin
 * change invalidates the frame's PNGs.
 */
function frameHash(keys: readonly string[]): string {
  const first = keys[0];
  if (keys.length === 1 && first !== undefined) return first;
  return sha256Hex(strToU8(keys.join('\n')));
}

/**
 * Renders the cache of `view`: for every animation, direction and skin, every frame with
 * `renderFrame(..., { exportOnly: true, skin })` (only exported layers), as an RGBA PNG.
 *
 * - A mirror animation **without** overrides is a `{ loop, mirrorOf }` entry and has no PNGs; the
 *   consumer flips the source (FR-RIG-16). A mirror **with** overrides is a normal, fully rendered
 *   entry (clarification 1) whose markers are mirrored (`x' = 2 * origin.x - x`).
 * - `previous` makes the build incremental: a frame whose hash appears in the previous index (for all
 *   rendered skins) reuses those PNG bytes.
 *
 * @throws IoError `RIG_REQUIRED` (a frame draws part layers and no `rig` was given), `BAD_INPUT`
 *   (unknown skin, duplicate `(group, direction)`, a mirror whose source is not authored in its
 *   group). Rendering errors of `renderFrame` (a missing image, a broken link) are `CoreError`s.
 */
export function buildRenderCache(
  view: DocumentView,
  options: RenderCacheOptions = {},
): RenderCache {
  const doc = view.doc;
  const skins = skinList(view, options.skins);
  const reuse = previousPngs(options.previous);
  const pngs = new Map<string, Uint8Array>();
  const byHash = new Map<string, string>(); // hash -> image path of its first frame

  const table = new Map<string, Map<string, Anim>>();
  for (const a of doc.animations) {
    let dirs = table.get(a.group);
    if (dirs === undefined) {
      dirs = new Map<string, Anim>();
      table.set(a.group, dirs);
    }
    if (dirs.has(directionKey(a))) {
      throw new IoError('BAD_INPUT', `duplicate animation ${a.group}/${directionKey(a)}`);
    }
    dirs.set(directionKey(a), a);
  }

  const animations: Record<string, Record<string, RenderAnimation>> = {};
  let rendered = 0;
  let reused = 0;

  const renderFrames = (ref: Anim, source: Authored, mirrorMarkers: boolean): RenderFrame[] => {
    const dir = directionKey(ref);
    return source.frames.map((frame: DeepReadonly<Frame>, i): RenderFrame => {
      const opts = (skin: string): Parameters<typeof renderInputKey>[3] => ({
        exportOnly: true,
        skin: skin === BASE_SKIN_KEY ? 'base' : { name: skin },
        ...(options.rig === undefined ? {} : { rig: options.rig }),
      });
      const hash = frameHash(skins.map((s) => renderInputKey(view, { id: ref.id }, i, opts(s))));
      let image = byHash.get(hash);
      if (image === undefined) {
        image = `${ref.group}/${dir}/${String(i)}.png`;
        byHash.set(hash, image);
        let fresh = false;
        for (const skin of skins) {
          let bytes = reuse.get(`${hash}|${skin}`);
          if (bytes === undefined) {
            fresh = true;
            try {
              const rgba = renderFrame(view, { id: ref.id }, i, opts(skin)).toRGBA();
              bytes = encodePng({ ...rgba, kind: 'rgba' });
            } catch (e) {
              if (e instanceof CoreError && e.code === 'NO_RIG_RENDERER') {
                throw new IoError(
                  'RIG_REQUIRED',
                  `animation ${ref.group}/${dir} frame ${String(i)} draws part layers: pass a RigRenderer as the 'rig' option (or set renderCache: false)`,
                  { cause: e },
                );
              }
              throw e;
            }
          }
          pngs.set(`${skin}/${image}`, bytes);
        }
        if (fresh) rendered++;
        else reused++;
      }
      const ox = doc.meta.origin.x;
      const markers: Record<string, { x: number; y: number }> = {};
      for (const [name, p] of Object.entries(frame.markers)) {
        markers[name] = { x: mirrorMarkers ? 2 * ox - p.x : p.x, y: p.y };
      }
      return {
        id: frame.id,
        hash,
        durationMs: frame.durationMs,
        image,
        markers,
        events: [...frame.events],
        rootMotion: { dx: frame.rootMotion.dx, dy: frame.rootMotion.dy },
      };
    });
  };

  for (const group of [...table.keys()].sort(cmp)) {
    const dirs = table.get(group);
    if (dirs === undefined) continue;
    const out: Record<string, RenderAnimation> = {};
    for (const dir of [...dirs.keys()].sort(cmp)) {
      const a = dirs.get(dir);
      if (a === undefined) continue;
      if (!('mirrorOf' in a)) {
        out[dir] = { loop: a.loop, frames: renderFrames(a, a, false) };
        continue;
      }
      const src = doc.animations.find((x) => x.id === a.mirrorOf);
      if (src === undefined || 'mirrorOf' in src || src.group !== a.group) {
        throw new IoError(
          'BAD_INPUT',
          `animation ${a.group}/${dir} mirrors ${a.mirrorOf}, which is not an authored animation of its group`,
        );
      }
      out[dir] =
        a.overrides.length === 0
          ? { loop: src.loop, mirrorOf: directionKey(src) }
          : { loop: src.loop, frames: renderFrames(a, src, true) };
    }
    animations[group] = out;
  }

  const directionFallback: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(doc.directionFallback)) directionFallback[k] = [...v];
  const index: RenderIndex = {
    schemaVersion: SCHEMA_VERSION,
    origin: { x: doc.meta.origin.x, y: doc.meta.origin.y },
    pixelsPerUnit: doc.meta.pixelsPerUnit,
    directionFallback,
    skins,
    animations,
  };
  return { index, pngs, rendered, reused };
}
