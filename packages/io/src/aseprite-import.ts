/**
 * `.aseprite` to document mapping and in-place re-import (FR-DOC-04, T4.5).
 *
 * Built on the T4.4 parser (`parseAseprite`); written from the published file-format notes and the
 * spec only (no Aseprite source). The mapping rules:
 *
 * - **Tags.** Each tag becomes an animation (`group` = the tag name made into a schema `Name`);
 *   untagged frames go to the animation `default`. Tag direction `reverse` lists the frames in
 *   reverse, `pingpong` / `pingpong_reverse` give loop mode `pingpong`, and repeat count 1 on a
 *   forward or reverse tag gives `once`.
 * - **Overlapping tags.** A frame that belongs to several tags appears in each animation (frame ids
 *   are unique across the document, so each occurrence is its own frame). For every layer the first
 *   occurrence owns the cel; the others hold `{ linkTo: <first occurrence> }` (one hop).
 * - **Aseprite's own linked cels** resolve to their source cel: the cel becomes a link to the first
 *   occurrence of the source frame, or the image cel itself when it is that frame.
 * - **Layers.** Groups, image layers and reference layers keep their tree, visibility and opacity
 *   (`export` follows visibility). Tilemap layers are skipped and reported. A layer whose name
 *   parses as `part:<bone>[.<part>][@<variant>][#<view>]` (`parsePartLayerName` of `rig`) is a
 *   *part source*: its single drawing becomes a variant, through `bindParts` of `core` with the raw
 *   name passed as `rawNames`. Part sources are imported as canvas-sized images at offset (0, 0) so a
 *   variant's pivot stays valid (pivot in image coordinates = canvas coordinates) and a later
 *   re-import can rewrite the pixels in place under the same image id.
 * - **Palette.** The file palette becomes the active palette when the document has none; otherwise
 *   it is added (not active) and reported. An identical existing palette is reused.
 *
 * **Re-import** (`reimportAsepriteTx`) updates a document from an edited file: layers, parts (by
 * bone, part, variant and view), animations (by group) are matched **by name**; frames by
 * `(tag, index)`. Added frames are appended without keys, removed frames drop their keys, overrides
 * and cels, and both are listed in the report. Matched items keep their ids, so bindings, pivots,
 * bone/part keys, markers and events survive; changed pixels are written into the existing images
 * (same image id) whenever the size allows, so a pixel-only edit of a part leaves the rig data
 * byte-identical.
 * @packageDocumentation
 */
import { DocumentStore, bindParts, referencedImages } from '@pixel-forge/core';
import type { BoundPart, BindSkipReason, DeepReadonly, Transaction } from '@pixel-forge/core';
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { DEFAULT_VARIANT_NAME, parsePartLayerName, partLayerName } from '@pixel-forge/rig';
import type { PartLayerName } from '@pixel-forge/rig';
import { NAME_REGEX, SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type {
  AnimationId,
  Cel,
  Document,
  FrameId,
  ImageId,
  Layer,
  LayerId,
  LoopMode,
  PaletteId,
  PartId,
  VariantId,
  ViewId,
} from '@pixel-forge/schema';
import { findAseCel, parseAseprite, resolveAseCel, aseCelToRgba } from './aseprite/index.js';
import type { AseFile, AseLayer, AseTag } from './aseprite/index.js';
import { defaultOrigin } from './sheet-import.js';
import { IoError } from './errors.js';

/** Group of the animation that holds the frames no tag covers. */
export const DEFAULT_ANIMATION = 'default';

/** Options shared by the import and re-import functions. */
export interface AsepriteImportOptions {
  /**
   * View of the rig that `part:` layers without a `#view` suffix go to. Default: the first view.
   * (Passed to `bindParts`.)
   */
  viewId?: ViewId;
  /** Default z for new parts, see `BindPartsOptions.zByBone`. */
  zByBone?: Readonly<Record<string, number>>;
  /** Display name of the imported palette. Default `aseprite`. */
  paletteName?: string;
}

/** Options of {@link createDocumentFromAseprite}. */
export interface CreateFromAsepriteOptions extends AsepriteImportOptions {
  /** Display name of the document. Default `aseprite`. */
  name?: string;
  /** Origin pixel. Default bottom-centre of the canvas (`defaultOrigin`). */
  origin?: { x: number; y: number };
  /** Pixels per engine unit. Default 16. */
  pixelsPerUnit?: number;
  /** Id generator seed (ids are deterministic for a seed). Default 1. */
  idSeed?: number;
}

/** What happened to the palette. */
export interface AsepritePaletteReport {
  id: PaletteId;
  name: string;
  /**
   * `active`: added and made the active palette (the document had none); `added`: added, not
   * active (the document already had an active palette); `existing`: an identical palette was
   * already there and was reused.
   */
  action: 'active' | 'added' | 'existing';
  /** Whether the palette is the document's active palette afterwards. */
  isActive: boolean;
}

/** A layer or animation whose source name had to be changed to a valid schema name. */
export interface AsepriteRename {
  kind: 'layer' | 'animation';
  from: string;
  to: string;
}

/** A frame that was removed by a re-import, with what went with it. */
export interface RemovedFrameReport {
  /** Group of the animation. */
  animation: string;
  /** Position of the frame in the animation (0-based), as before the re-import. */
  index: number;
  frameId: FrameId;
  /** Number of bone keys that were dropped with the frame. */
  boneKeys: number;
  /** Number of part keys that were dropped with the frame. */
  partKeys: number;
  /** Number of overrides (in any animation) that were dropped with the frame. */
  overrides: number;
}

/** A frame that a re-import appended. */
export interface AddedFrameReport {
  animation: string;
  index: number;
  frameId: FrameId;
}

/** A `part:` layer that did not become a variant. */
export interface UnboundPartReport {
  /** Id of the pixel layer that holds its drawing (it stays a pixel layer). */
  layerId: LayerId;
  /** Name of that document layer. */
  layer: string;
  /** The raw Aseprite layer name; pass `{ [layerId]: source }` to `bindParts` later. */
  source: string;
  /** Why `bindParts` (or the importer) skipped it. */
  reason: BindSkipReason;
}

/** A variant whose pixels a re-import replaced. */
export interface UpdatedVariantReport {
  partId: PartId;
  variantId: VariantId;
  /** The raw Aseprite layer name. */
  source: string;
  /** True when the pixels were written into the existing image (same image id). */
  inPlace: boolean;
}

/** The result of an import or re-import. */
export interface AsepriteImportReport {
  mode: 'import' | 'reimport';
  /** Animations of the file, in order: created or matched (re-import). */
  animations: {
    group: string;
    id: AnimationId;
    /** The Aseprite tag name; missing for `default`. */
    tag?: string;
    frames: number;
    action: 'created' | 'matched';
  }[];
  /** Layers of the file as they ended up in the document (`part:` layers that were bound are under `parts`). */
  layers: {
    name: string;
    id: LayerId;
    kind: 'group' | 'pixel' | 'reference';
    action: 'created' | 'matched';
  }[];
  /** Layers of the file that were not imported (tilemaps, or a name that belongs to a layer of another kind). */
  skippedLayers: { name: string; reason: string }[];
  parts: {
    /** `part:` layers that became (part of) a part, new or existing. */
    bound: BoundPart[];
    /** Variants whose pixels were replaced (re-import). */
    updated: UpdatedVariantReport[];
    /** `part:` layers that stayed pixel layers. */
    unbound: UnboundPartReport[];
  };
  /** The palette, or `null` when the file has none. */
  palette: AsepritePaletteReport | null;
  /** Frames appended by a re-import (without keys). */
  addedFrames: AddedFrameReport[];
  /** Frames removed by a re-import, with the keys and overrides that went with them. */
  removedFrames: RemovedFrameReport[];
  /** Re-import: groups of animations of the document that the file does not mention (left untouched). */
  animationsNotInSource: string[];
  /** Re-import: names of document layers that the file does not mention (left untouched). */
  layersNotInSource: string[];
  /** Names that were rewritten to be valid and unique. */
  renamed: AsepriteRename[];
  /** Image bookkeeping: created, rewritten in place, left as they were, and deleted (orphaned). */
  images: { created: number; rewritten: number; unchanged: number; deleted: number };
  warnings: string[];
}

/** Unwraps a value the caller has just checked. */
function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('unreachable');
  return v;
}

// ---- naming ------------------------------------------------------------------------------------------

const NAME_MAX = 48;

/** A schema `Name` made from `raw`: lower case, other characters become `_`, at most 48 characters. */
function sanitizeName(raw: string, fallback: string): string {
  let s = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, NAME_MAX);
  if (s === '') s = fallback;
  if (!NAME_REGEX.test(s)) s = `${s.slice(0, NAME_MAX - 1)}_`;
  return s;
}

/** `base`, or `base_2`, `base_3`... until it is not in `taken`; adds the result to `taken`. */
function unique(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) {
    const suffix = `_${String(n)}`;
    name = `${base.slice(0, NAME_MAX - suffix.length)}${suffix}`;
  }
  taken.add(name);
  return name;
}

// ---- plan --------------------------------------------------------------------------------------------

type SrcKind = 'group' | 'pixel' | 'reference';

interface SrcLayer {
  readonly ase: AseLayer;
  readonly raw: string;
  readonly name: string;
  readonly kind: SrcKind;
  /** Set when the layer is a `part:` source. */
  readonly parsed: PartLayerName | null;
  readonly parent: SrcLayer | null;
}

interface PlannedAnim {
  readonly group: string;
  readonly tag: string | undefined;
  readonly loop: LoopMode;
  /** Aseprite frame indices in play order. */
  readonly frames: readonly number[];
}

interface Plan {
  readonly layers: readonly SrcLayer[];
  readonly anims: readonly PlannedAnim[];
  readonly skipped: { name: string; reason: string }[];
  readonly renamed: AsepriteRename[];
  readonly warnings: string[];
}

function tagFrames(tag: AseTag): number[] {
  const out: number[] = [];
  for (let f = tag.from; f <= tag.to; f++) out.push(f);
  return tag.direction === 'reverse' || tag.direction === 'pingpong_reverse' ? out.reverse() : out;
}

function tagLoop(tag: AseTag): LoopMode {
  if (tag.direction === 'pingpong' || tag.direction === 'pingpong_reverse') return 'pingpong';
  return tag.repeat === 1 ? 'once' : 'loop';
}

function planAseprite(file: AseFile, takenLayerNames: Set<string>): Plan {
  const warnings: string[] = [];
  const renamed: AsepriteRename[] = [];
  const skipped: { name: string; reason: string }[] = [];

  // Layers: parents precede children; names are unique across the file (and the document, on import).
  const layers: SrcLayer[] = [];
  const bySrc = new Map<number, SrcLayer>();
  const skippedIdx = new Set<number>();
  for (const ase of file.layers) {
    if (ase.type === 'tilemap') {
      skipped.push({ name: ase.name, reason: 'tilemap layers are not imported' });
      skippedIdx.add(ase.index);
      continue;
    }
    const parent = ase.parentIndex === null ? null : (bySrc.get(ase.parentIndex) ?? null);
    const name = unique(sanitizeName(ase.name, 'layer'), takenLayerNames);
    if (name !== ase.name) renamed.push({ kind: 'layer', from: ase.name, to: name });
    const kind: SrcKind = ase.type === 'group' ? 'group' : ase.reference ? 'reference' : 'pixel';
    const parsed = kind === 'pixel' ? parsePartLayerName(ase.name) : null;
    if (kind === 'pixel' && parsed === null && ase.name.startsWith('part:')) {
      warnings.push(
        `layer "${ase.name}" looks like a part layer but its name is not valid; imported as a plain layer`,
      );
    }
    const src: SrcLayer = { ase, raw: ase.name, name, kind, parsed, parent };
    layers.push(src);
    bySrc.set(ase.index, src);
  }

  // Animations: valid tags in file order, then `default` for the frames no tag covers.
  const n = file.frames.length;
  const validTags: AseTag[] = [];
  const covered = new Set<number>();
  for (const tag of file.tags) {
    if (tag.from < 0 || tag.to < tag.from || tag.to >= n) {
      warnings.push(
        `tag "${tag.name}" (${String(tag.from)}..${String(tag.to)}) is outside the ${String(n)} frames; skipped`,
      );
      continue;
    }
    validTags.push(tag);
    for (let f = tag.from; f <= tag.to; f++) covered.add(f);
  }
  const untagged: number[] = [];
  for (let f = 0; f < n; f++) if (!covered.has(f)) untagged.push(f);
  const taken = new Set<string>();
  if (untagged.length > 0) taken.add(DEFAULT_ANIMATION);
  const anims: PlannedAnim[] = [];
  for (const tag of validTags) {
    const group = unique(sanitizeName(tag.name, 'tag'), taken);
    if (group !== tag.name) renamed.push({ kind: 'animation', from: tag.name, to: group });
    anims.push({ group, tag: tag.name, loop: tagLoop(tag), frames: tagFrames(tag) });
  }
  if (untagged.length > 0) {
    anims.push({ group: DEFAULT_ANIMATION, tag: undefined, loop: 'loop', frames: untagged });
  }
  return { layers, anims, skipped, renamed, warnings };
}

// ---- cel images ---------------------------------------------------------------------------------------

/** The pixels of one drawing, ready to become an image. */
interface ImgSpec {
  readonly indexed: boolean;
  readonly width: number;
  readonly height: number;
  /** RGBA (4 bytes per pixel) or indices (1 byte). */
  readonly data: Uint8Array;
  readonly x: number;
  readonly y: number;
  readonly opacity: number;
  readonly transparentIndex: number;
}

interface LayerCels {
  /** For each Aseprite frame: the frame whose spec it shows (after links), or undefined for no cel. */
  readonly byFrame: readonly (number | undefined)[];
  /** One spec per drawing, keyed by the (representative) source frame. */
  readonly specs: ReadonlyMap<number, ImgSpec>;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function celsOf(
  file: AseFile,
  src: SrcLayer,
  canvasSized: boolean,
  indexed: boolean,
  canvas: { w: number; h: number },
  warnings: string[],
): LayerCels {
  const n = file.frames.length;
  const byFrame: (number | undefined)[] = new Array<number | undefined>(n).fill(undefined);
  const specs = new Map<number, ImgSpec>();
  const empty = new Set<number>();
  const tIdx = file.header.transparentIndex;
  for (let f = 0; f < n; f++) {
    const cel = findAseCel(file, f, src.ase.index);
    if (cel === undefined) continue;
    if (cel.content.type === 'tilemap') {
      warnings.push(`layer "${src.raw}" frame ${String(f)}: tilemap cel skipped`);
      continue;
    }
    const resolved = resolveAseCel(file, cel);
    const s = resolved.cel.frameIndex;
    if (empty.has(s)) continue;
    if (!specs.has(s)) {
      const { width, height } = resolved.image;
      if (width === 0 || height === 0) {
        empty.add(s);
        continue;
      }
      const px = indexed ? 1 : 4;
      let data = indexed ? resolved.image.data : aseCelToRgba(file, resolved.cel).data;
      let w = width;
      let h = height;
      let x = resolved.cel.x;
      let y = resolved.cel.y;
      if (canvasSized) {
        // Compose onto a canvas-sized buffer (clipped), so image coordinates are canvas coordinates.
        const buf = new Uint8Array(canvas.w * canvas.h * px);
        if (indexed) buf.fill(tIdx);
        for (let cy = 0; cy < height; cy++) {
          const py = y + cy;
          if (py < 0 || py >= canvas.h) continue;
          for (let cx = 0; cx < width; cx++) {
            const qx = x + cx;
            if (qx < 0 || qx >= canvas.w) continue;
            const from = (cy * width + cx) * px;
            const to = (py * canvas.w + qx) * px;
            for (let k = 0; k < px; k++) buf[to + k] = data[from + k] ?? 0;
          }
        }
        data = buf;
        w = canvas.w;
        h = canvas.h;
        x = 0;
        y = 0;
      }
      specs.set(s, {
        indexed,
        width: w,
        height: h,
        data,
        x,
        y,
        opacity: resolved.cel.opacity,
        transparentIndex: tIdx,
      });
    }
    byFrame[f] = s;
  }
  if (canvasSized) {
    // A part variant is one drawing: the first frame's. Later frames show it too (links).
    const keys = [...specs.keys()].sort((a, b) => a - b);
    const rep = keys[0];
    const repSpec = rep === undefined ? undefined : specs.get(rep);
    if (rep !== undefined && repSpec !== undefined) {
      if (keys.some((k) => !sameBytes(specs.get(k)?.data ?? new Uint8Array(0), repSpec.data))) {
        warnings.push(
          `part layer "${src.raw}": the drawing differs between frames; the drawing of frame ${String(rep)} is used`,
        );
      }
      for (const k of keys) if (k !== rep) specs.delete(k);
      for (let f = 0; f < n; f++) if (byFrame[f] !== undefined) byFrame[f] = rep;
    }
  }
  return { byFrame, specs };
}

function toImage(spec: ImgSpec): TiledImage | IndexedImage {
  return spec.indexed
    ? IndexedImage.fromIndices(spec.width, spec.height, spec.data, spec.transparentIndex)
    : TiledImage.fromRGBA({ width: spec.width, height: spec.height, data: spec.data });
}

/** Can `img` take `spec`'s pixels in place (same kind and size)? */
function fits(img: TiledImage | IndexedImage | undefined, spec: ImgSpec): boolean {
  if (img?.width !== spec.width || img.height !== spec.height) return false;
  if (spec.indexed)
    return img instanceof IndexedImage && img.transparentIndex === spec.transparentIndex;
  return img instanceof TiledImage;
}

function sameContent(img: TiledImage | IndexedImage, spec: ImgSpec): boolean {
  const cur = img instanceof IndexedImage ? img.toIndices() : img.toRGBA().data;
  return sameBytes(cur, spec.data);
}

function writeSpec(img: TiledImage | IndexedImage, spec: ImgSpec): void {
  const { width, height, data } = spec;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (img instanceof IndexedImage) {
        img.set(x, y, data[y * width + x] ?? 0);
      } else {
        const o = (y * width + x) * 4;
        img.set(x, y, [data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0, data[o + 3] ?? 0]);
      }
    }
  }
}

// ---- document helpers ---------------------------------------------------------------------------------

type LayerRo = DeepReadonly<Layer>;
type DocRo = DeepReadonly<Document>;

interface Flat {
  readonly layer: LayerRo;
  readonly parent: LayerId | undefined;
}

function flatten(layers: readonly LayerRo[], parent?: LayerId, out: Flat[] = []): Flat[] {
  for (const layer of layers) {
    out.push({ layer, parent });
    if (layer.kind === 'group') flatten(layer.children, layer.id, out);
  }
  return out;
}

/** Image reference counts over cels, variants and overrides. */
function refCounts(doc: DocRo): Map<ImageId, number> {
  const m = new Map<ImageId, number>();
  const bump = (id: ImageId): void => void m.set(id, (m.get(id) ?? 0) + 1);
  for (const { layer } of flatten(doc.layers)) {
    if (layer.kind === 'pixel' || layer.kind === 'reference') {
      for (const c of Object.values(layer.cels)) if ('imageId' in c) bump(c.imageId);
    }
  }
  for (const p of doc.rig?.parts ?? []) for (const v of p.variants) bump(v.imageId);
  for (const a of doc.animations) {
    for (const o of a.overrides) {
      if (o.set !== undefined) bump(o.set);
      if (o.erase !== undefined) bump(o.erase);
    }
  }
  return m;
}

function locate(layers: Layer[], id: LayerId): Layer | undefined {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.kind === 'group') {
      const f = locate(l.children, id);
      if (f !== undefined) return f;
    }
  }
  return undefined;
}

function celLayers(layers: Layer[], out: Extract<Layer, { cels: unknown }>[] = []) {
  for (const l of layers) {
    if (l.kind === 'group') celLayers(l.children, out);
    else if (l.kind === 'pixel' || l.kind === 'reference') out.push(l);
  }
  return out;
}

function colorsOf(
  file: AseFile,
  indexedDoc: boolean,
  warnings: string[],
): [number, number, number, number][] | null {
  const pal = file.palette;
  if (pal === null) return null;
  let colors = pal.entries.map((e): [number, number, number, number] => [e.r, e.g, e.b, e.a]);
  if (colors.length > 256) {
    warnings.push(`palette has ${String(colors.length)} colours; only the first 256 are imported`);
    colors = colors.slice(0, 256);
  }
  if (indexedDoc) {
    const t = file.header.transparentIndex;
    const c = colors[t];
    if (c !== undefined && c[3] !== 0) {
      warnings.push(
        `palette entry ${String(t)} (the transparent index) was made fully transparent`,
      );
      colors[t] = [c[0], c[1], c[2], 0];
    }
  }
  return colors;
}

// ---- the reconcile ------------------------------------------------------------------------------------

interface AnimTarget {
  readonly plan: PlannedAnim;
  readonly id: AnimationId;
  readonly existing: boolean;
  /** Frame ids by index (existing ones first, then new). */
  readonly ids: FrameId[];
  readonly oldCount: number;
  readonly removed: { id: FrameId; index: number }[];
}

interface LayerTarget {
  readonly src: SrcLayer;
  /** Existing document layer id, or the id allocated for a new one. */
  readonly id: LayerId;
  readonly existing: boolean;
  /** Pixel layers only: the cels to write. */
  cels?: Map<FrameId, Cel>;
}

function run(
  tx: Transaction,
  input: Uint8Array | AseFile,
  opts: AsepriteImportOptions,
  match: boolean,
): AsepriteImportReport {
  const file = input instanceof Uint8Array ? parseAseprite(input) : input;
  const doc0 = tx.doc;
  const canvas = doc0.meta.canvas;
  const indexed = doc0.meta.colorMode === 'indexed';
  if (file.header.width !== canvas.w || file.header.height !== canvas.h) {
    throw new IoError(
      'SIZE_MISMATCH',
      `the file is ${String(file.header.width)}x${String(file.header.height)}, the document canvas is ${String(canvas.w)}x${String(canvas.h)}`,
    );
  }
  if (indexed && file.header.colorDepth !== 8) {
    throw new IoError('BAD_INPUT', 'an indexed document can only import an indexed .aseprite file');
  }
  if (indexed && file.palette === null) {
    throw new IoError('BAD_INPUT', 'indexed .aseprite file without a palette');
  }

  const flat0 = flatten(doc0.layers);
  const plan = planAseprite(file, match ? new Set() : new Set(flat0.map((f) => f.layer.name)));
  const warnings = [...plan.warnings];
  const report: AsepriteImportReport = {
    mode: match ? 'reimport' : 'import',
    animations: [],
    layers: [],
    skippedLayers: [...plan.skipped],
    parts: { bound: [], updated: [], unbound: [] },
    palette: null,
    addedFrames: [],
    removedFrames: [],
    animationsNotInSource: [],
    layersNotInSource: [],
    renamed: [...plan.renamed],
    images: { created: 0, rewritten: 0, unchanged: 0, deleted: 0 },
    warnings,
  };

  // Validate before the document is touched (an error inside a transaction aborts it).
  if (!match) {
    for (const p of plan.anims) {
      if (doc0.animations.some((a) => a.group === p.group && a.direction === undefined)) {
        throw new IoError('DUPLICATE_ANIMATION', `animation ${p.group} already exists`);
      }
    }
  }

  // ---- animations and frame ids ----
  const targets: AnimTarget[] = [];
  for (const p of plan.anims) {
    const found = match
      ? doc0.animations.find(
          (a) => a.group === p.group && a.direction === undefined && 'frames' in a,
        )
      : undefined;
    const old = found !== undefined && 'frames' in found ? found : undefined;
    const ids: FrameId[] = [];
    for (let i = 0; i < p.frames.length; i++) {
      const prev = old?.frames[i]?.id;
      if (prev !== undefined) ids.push(prev);
      else {
        const id = tx.newId('frame');
        ids.push(id);
        if (old !== undefined) {
          report.addedFrames.push({ animation: p.group, index: i, frameId: id });
        }
      }
    }
    const removed = (old?.frames ?? [])
      .map((f, index) => ({ id: f.id, index }))
      .filter((r) => r.index >= p.frames.length);
    const animId = old?.id ?? tx.newId('animation');
    targets.push({
      plan: p,
      id: animId,
      existing: old !== undefined,
      ids,
      oldCount: old?.frames.length ?? 0,
      removed,
    });
    report.animations.push({
      group: p.group,
      id: animId,
      ...(p.tag === undefined ? {} : { tag: p.tag }),
      frames: p.frames.length,
      action: old === undefined ? 'created' : 'matched',
    });
  }
  const firstOcc = new Map<number, FrameId>();
  for (const t of targets) {
    t.plan.frames.forEach((f, i) => {
      if (!firstOcc.has(f)) firstOcc.set(f, must(t.ids[i]));
    });
  }
  if (match) {
    const planned = new Set(plan.anims.map((p) => p.group));
    for (const a of doc0.animations) {
      if (!(a.direction === undefined && planned.has(a.group)))
        report.animationsNotInSource.push(a.group);
    }
  }

  // ---- removed frames: what goes with them ----
  const removedAll = new Map<FrameId, { animation: string; index: number }>();
  for (const t of targets) {
    for (const r of t.removed) removedAll.set(r.id, { animation: t.plan.group, index: r.index });
  }
  for (const t of targets) {
    const old = doc0.animations.find((a) => a.id === t.id);
    for (const r of t.removed) {
      const fr = old !== undefined && 'frames' in old ? old.frames[r.index] : undefined;
      report.removedFrames.push({
        animation: t.plan.group,
        index: r.index,
        frameId: r.id,
        boneKeys: Object.keys(fr?.boneKeys ?? {}).length,
        partKeys: Object.keys(fr?.partKeys ?? {}).length,
        overrides: doc0.animations.reduce(
          (n, a) => n + a.overrides.filter((o) => o.frameId === r.id).length,
          0,
        ),
      });
    }
  }

  // ---- layers ----
  const rig = doc0.rig;
  const refs = refCounts(doc0);
  const candidates = new Set<ImageId>(); // images that may be orphaned afterwards
  const byName = new Map<string, Flat>();
  for (const f of flat0) if (!byName.has(f.layer.name)) byName.set(f.layer.name, f);
  const partLayerNameOf = new Map<string, string>();
  for (const f of flat0) if (f.layer.kind === 'part') partLayerNameOf.set(f.layer.id, f.layer.name);
  const defaultView =
    opts.viewId !== undefined ? rig?.views.find((v) => v.id === opts.viewId) : rig?.views[0];

  const layerTargets = new Map<number, LayerTarget>(); // by Aseprite layer index
  const variantUpdates: {
    partId: PartId;
    variantId: VariantId;
    imageId: ImageId;
    source: string;
    inPlace: boolean;
  }[] = [];
  const bindIds: LayerId[] = [];
  const rawNames: Record<string, string> = {};
  const rebuilt = new Set<LayerId>();
  const matchedDocLayers = new Set<LayerId>();
  const newLayerOrder: LayerTarget[] = [];

  const framesOfPlan = (): { fid: FrameId; f: number }[] => {
    const out: { fid: FrameId; f: number }[] = [];
    for (const t of targets) t.plan.frames.forEach((f, i) => out.push({ fid: must(t.ids[i]), f }));
    return out;
  };
  const occurrences = framesOfPlan();

  /** Realises the cels of `src` for `target` (creating or rewriting images). */
  const buildCels = (
    src: SrcLayer,
    existingLayer: LayerRo | undefined,
    canvasSized: boolean,
  ): Map<FrameId, Cel> => {
    const lc = celsOf(file, src, canvasSized, indexed, canvas, warnings);
    const old =
      existingLayer !== undefined && 'cels' in existingLayer ? existingLayer.cels : undefined;
    const oldFor = (fid: FrameId) =>
      old === undefined ? undefined : (old as Record<string, Cel>)[fid];
    // candidates: every image cel this layer has on a frame we rebuild or remove
    const touched = [...occurrences.map((o) => o.fid), ...removedAll.keys()];
    for (const fid of touched) {
      const c = oldFor(fid);
      if (c !== undefined && 'imageId' in c) candidates.add(c.imageId);
    }
    const imageOf = new Map<number, ImageId>();
    for (const [s, spec] of [...lc.specs].sort((a, b) => a[0] - b[0])) {
      const fid = firstOcc.get(s);
      const prev = fid === undefined ? undefined : oldFor(fid);
      const prevId = prev !== undefined && 'imageId' in prev ? prev.imageId : undefined;
      const img = prevId === undefined ? undefined : tx.image(prevId);
      if (prevId !== undefined && refs.get(prevId) === 1 && fits(img, spec)) {
        if (img !== undefined && sameContent(img, spec)) report.images.unchanged++;
        else {
          tx.writeImage(prevId, (im) => {
            writeSpec(im, spec);
          });
          report.images.rewritten++;
        }
        candidates.delete(prevId);
        imageOf.set(s, prevId);
      } else {
        imageOf.set(s, tx.createImage(toImage(spec)));
        report.images.created++;
      }
    }
    const cels = new Map<FrameId, Cel>();
    for (const { fid, f } of occurrences) {
      const s = lc.byFrame[f];
      if (s === undefined) continue;
      const target = must(firstOcc.get(s));
      const spec = must(lc.specs.get(s));
      cels.set(
        fid,
        fid === target
          ? {
              imageId: must(imageOf.get(s)),
              offset: { x: spec.x, y: spec.y },
              opacity: spec.opacity,
            }
          : { linkTo: target },
      );
    }
    return cels;
  };

  for (const src of plan.layers) {
    let hit: Flat | undefined;
    if (match) hit = byName.get(src.name);

    // A matched part: the variant is rewritten, nothing else about the part changes.
    if (match && src.parsed !== null && rig !== undefined) {
      const bone = rig.bones.find((b) => b.name === src.parsed?.bone);
      const view =
        src.parsed.view === undefined
          ? defaultView
          : rig.views.find((v) => v.name === src.parsed?.view);
      const lname = partLayerName(src.parsed);
      const part =
        bone === undefined
          ? undefined
          : rig.parts.find((p) => p.boneId === bone.id && partLayerNameOf.get(p.layerId) === lname);
      const variant =
        part === undefined || view === undefined
          ? undefined
          : part.variants.find(
              (v) =>
                v.viewId === view.id && v.name === (src.parsed?.variant ?? DEFAULT_VARIANT_NAME),
            );
      if (part !== undefined && variant !== undefined) {
        const lc = celsOf(file, src, true, indexed, canvas, warnings);
        const specs = [...lc.specs.values()];
        if (specs.length === 0) {
          report.parts.unbound.push({
            layerId: part.layerId,
            layer: lname,
            source: src.raw,
            reason: 'empty',
          });
        } else {
          const spec = must(specs[0]);
          const img = tx.image(variant.imageId);
          if (refs.get(variant.imageId) === 1 && fits(img, spec)) {
            if (img !== undefined && sameContent(img, spec)) report.images.unchanged++;
            else {
              tx.writeImage(variant.imageId, (im) => {
                writeSpec(im, spec);
              });
              report.images.rewritten++;
            }
            variantUpdates.push({
              partId: part.id,
              variantId: variant.id,
              imageId: variant.imageId,
              source: src.raw,
              inPlace: true,
            });
          } else {
            if (img !== undefined && (img.width !== spec.width || img.height !== spec.height)) {
              warnings.push(
                `variant "${src.raw}": the image size changed (${String(img.width)}x${String(img.height)} to ${String(spec.width)}x${String(spec.height)}); the image was replaced and the pivot kept as is`,
              );
            }
            const id = tx.createImage(toImage(spec));
            report.images.created++;
            candidates.add(variant.imageId);
            variantUpdates.push({
              partId: part.id,
              variantId: variant.id,
              imageId: id,
              source: src.raw,
              inPlace: false,
            });
          }
          matchedDocLayers.add(part.layerId);
        }
        continue;
      }
    }

    if (hit !== undefined) {
      const kindOk =
        (src.kind === 'group' && hit.layer.kind === 'group') ||
        (src.kind === 'pixel' && hit.layer.kind === 'pixel') ||
        (src.kind === 'reference' && hit.layer.kind === 'reference');
      if (!kindOk) {
        report.skippedLayers.push({
          name: src.raw,
          reason: `a layer named ${src.name} exists in the document with kind ${hit.layer.kind}`,
        });
        continue;
      }
      const lt: LayerTarget = { src, id: hit.layer.id, existing: true };
      layerTargets.set(src.ase.index, lt);
      matchedDocLayers.add(hit.layer.id);
      if (src.kind !== 'group') {
        lt.cels = buildCels(src, hit.layer, src.parsed !== null);
        rebuilt.add(hit.layer.id);
      }
      report.layers.push({ name: src.name, id: hit.layer.id, kind: src.kind, action: 'matched' });
      if (src.parsed !== null) {
        bindIds.push(hit.layer.id);
        rawNames[hit.layer.id] = src.raw;
      }
      continue;
    }

    const lt: LayerTarget = { src, id: tx.newId('layer'), existing: false };
    layerTargets.set(src.ase.index, lt);
    if (src.kind !== 'group') lt.cels = buildCels(src, undefined, src.parsed !== null);
    newLayerOrder.push(lt);
    report.layers.push({ name: src.name, id: lt.id, kind: src.kind, action: 'created' });
    if (src.parsed !== null) {
      bindIds.push(lt.id);
      rawNames[lt.id] = src.raw;
    }
  }
  if (match) {
    const mentioned = new Set(plan.layers.map((l) => l.name));
    for (const f of flat0) {
      if (!matchedDocLayers.has(f.layer.id) && !mentioned.has(f.layer.name)) {
        report.layersNotInSource.push(f.layer.name);
      }
    }
  }

  // ---- palette ----
  const colors = colorsOf(file, indexed, warnings);
  let paletteId: PaletteId | undefined;
  let paletteNew:
    { id: PaletteId; name: string; colors: [number, number, number, number][] } | undefined;
  let makeActive = false;
  if (colors !== null) {
    const same = doc0.palettes.find(
      (p) =>
        p.colors.length === colors.length &&
        p.colors.every((c, i) => c.every((v, k) => v === colors[i]?.[k])),
    );
    if (same !== undefined) {
      paletteId = same.id;
      makeActive = doc0.activePaletteId === undefined;
      report.palette = {
        id: same.id,
        name: same.name,
        action: 'existing',
        isActive: makeActive || doc0.activePaletteId === same.id,
      };
    } else {
      paletteId = tx.newId('palette');
      const name = (opts.paletteName ?? 'aseprite').slice(0, 128) || 'aseprite';
      paletteNew = { id: paletteId, name, colors };
      makeActive = doc0.activePaletteId === undefined;
      report.palette = {
        id: paletteId,
        name,
        action: makeActive ? 'active' : 'added',
        isActive: makeActive,
      };
      if (!makeActive && indexed) {
        warnings.push(
          'the document already has an active palette; the imported indices are read against it as they are',
        );
      }
    }
  }

  // ---- frames that vanish: links from layers we do not rebuild are materialised first ----
  interface Mat {
    layerId: LayerId;
    owner: FrameId;
    imageId: ImageId;
    offset: { x: number; y: number };
    opacity: number;
    others: FrameId[];
  }
  const mats: Mat[] = [];
  if (removedAll.size > 0) {
    for (const { layer } of flat0) {
      if (!('cels' in layer) || rebuilt.has(layer.id)) continue;
      const cels = layer.cels as Record<string, Cel>;
      for (const rid of removedAll.keys()) {
        const own = cels[rid];
        if (own === undefined || 'linkTo' in own) continue;
        const linkers = Object.entries(cels)
          .filter(([k, c]) => 'linkTo' in c && c.linkTo === rid && !removedAll.has(k as FrameId))
          .map(([k]) => k as FrameId);
        const [owner, ...others] = linkers;
        if (owner === undefined) continue;
        const img = tx.image(own.imageId);
        if (img === undefined) continue;
        mats.push({
          layerId: layer.id,
          owner,
          imageId: tx.createImage(img),
          offset: { ...own.offset },
          opacity: own.opacity,
          others,
        });
      }
    }
  }
  // images of removed overrides
  for (const a of doc0.animations) {
    for (const o of a.overrides) {
      if (!removedAll.has(o.frameId)) continue;
      if (o.set !== undefined) candidates.add(o.set);
      if (o.erase !== undefined) candidates.add(o.erase);
    }
  }
  for (const f of flat0) {
    if ('cels' in f.layer) {
      for (const rid of removedAll.keys()) {
        const c = (f.layer.cels as Record<string, Cel>)[rid];
        if (c !== undefined && 'imageId' in c) candidates.add(c.imageId);
      }
    }
  }

  // ---- write the document ----
  tx.update((d) => {
    if (paletteNew !== undefined) {
      d.palettes.push({
        id: paletteNew.id,
        name: paletteNew.name,
        colors: paletteNew.colors,
        ramps: [],
      });
    }
    if (makeActive && paletteId !== undefined) d.activePaletteId = paletteId;

    // animations
    for (const t of targets) {
      const mk = (id: FrameId, f: number) => ({
        id,
        durationMs: Math.max(1, file.frames[f]?.durationMs ?? 100),
        markers: {},
        events: [] as string[],
        rootMotion: { dx: 0, dy: 0 },
        boneKeys: {},
        partKeys: {},
      });
      if (!t.existing) {
        d.animations.push({
          id: t.id,
          group: t.plan.group,
          loop: t.plan.loop,
          frames: t.plan.frames.map((f, i) => mk(must(t.ids[i]), f)),
          overrides: [],
        });
        continue;
      }
      const a = d.animations.find((x) => x.id === t.id);
      if (a === undefined || !('frames' in a)) continue;
      t.plan.frames.forEach((f, i) => {
        const fr = a.frames[i];
        if (fr === undefined) a.frames.push(mk(must(t.ids[i]), f));
        else fr.durationMs = Math.max(1, file.frames[f]?.durationMs ?? fr.durationMs);
      });
      if (a.frames.length > t.plan.frames.length) a.frames.splice(t.plan.frames.length);
    }
    if (removedAll.size > 0) {
      for (const a of d.animations)
        a.overrides = a.overrides.filter((o) => !removedAll.has(o.frameId));
    }

    // materialised links, then cel removal on the vanished frames
    const cl = celLayers(d.layers);
    const byId = new Map(cl.map((l) => [l.id as string, l]));
    for (const m of mats) {
      const layer = byId.get(m.layerId);
      if (layer === undefined) continue;
      layer.cels[m.owner] = { imageId: m.imageId, offset: m.offset, opacity: m.opacity };
      for (const o of m.others) layer.cels[o] = { linkTo: m.owner };
    }
    for (const layer of cl)
      for (const rid of removedAll.keys()) Reflect.deleteProperty(layer.cels, rid);

    // new layers (parents first), in file order
    for (const lt of newLayerOrder) {
      const l = lt.src;
      const base = {
        id: lt.id,
        name: l.name,
        visible: l.ase.visible,
        opacity: l.ase.opacity,
        export: l.ase.visible && l.kind !== 'reference',
      };
      const cels = Object.fromEntries(lt.cels ?? []) as Record<string, Cel>;
      const node: Layer =
        l.kind === 'group'
          ? { kind: 'group', ...base, children: [] }
          : l.kind === 'reference'
            ? { kind: 'reference', ...base, export: false, cels }
            : { kind: 'pixel', ...base, cels };
      const parent = l.parent === null ? undefined : layerTargets.get(l.parent.ase.index);
      const host = parent === undefined ? undefined : locate(d.layers, parent.id);
      if (host?.kind === 'group') host.children.push(node);
      else d.layers.push(node);
    }
    // matched layers: every planned frame is rewritten
    for (const lt of layerTargets.values()) {
      if (!lt.existing || lt.cels === undefined) continue;
      const layer = locate(d.layers, lt.id);
      if (layer === undefined || !('cels' in layer)) continue;
      for (const o of occurrences) Reflect.deleteProperty(layer.cels, o.fid);
      for (const [fid, cel] of lt.cels) layer.cels[fid] = cel;
    }
    // matched variants
    for (const u of variantUpdates) {
      if (u.inPlace) continue;
      const v = d.rig?.parts
        .find((p) => p.id === u.partId)
        ?.variants.find((x) => x.id === u.variantId);
      if (v !== undefined) v.imageId = u.imageId;
    }
  });

  // ---- bind part sources ----
  if (bindIds.length > 0) {
    const names = new Map(flatten(tx.doc.layers).map((f) => [f.layer.id as string, f.layer.name]));
    const res = bindParts(tx, {
      byName: true,
      byOverlap: false,
      layers: bindIds,
      rawNames,
      ...(opts.viewId === undefined ? {} : { viewId: opts.viewId }),
      ...(opts.zByBone === undefined ? {} : { zByBone: opts.zByBone }),
    });
    report.parts.bound.push(...res.bound);
    for (const s of res.skipped) {
      report.parts.unbound.push({
        layerId: s.layerId,
        layer: names.get(s.layerId) ?? '',
        source: rawNames[s.layerId] ?? '',
        reason: s.reason,
      });
    }
  }
  for (const u of variantUpdates) {
    report.parts.updated.push({
      partId: u.partId,
      variantId: u.variantId,
      source: u.source,
      inPlace: u.inPlace,
    });
  }
  // A bound layer is a part now: it no longer counts as a pixel layer of the report.
  const boundLayers = new Set(report.parts.bound.map((b) => b.layerId));
  report.layers = report.layers.filter((l) => !boundLayers.has(l.id));

  // ---- links that lost their target (frames of animations the file does not own) ----
  if (match) {
    const fixes: { layerId: LayerId; fid: FrameId; to: FrameId | undefined }[] = [];
    for (const { layer } of flatten(tx.doc.layers)) {
      if (!('cels' in layer)) continue;
      const cels = layer.cels as Record<string, Cel>;
      for (const [fid, cel] of Object.entries(cels)) {
        if (!('linkTo' in cel)) continue;
        let target = cels[cel.linkTo];
        let to: FrameId | undefined = cel.linkTo;
        for (let hop = 0; target !== undefined && 'linkTo' in target && hop < 8; hop++) {
          to = target.linkTo;
          target = cels[to];
        }
        const ok = target !== undefined && 'imageId' in target;
        if (!ok) fixes.push({ layerId: layer.id, fid: fid as FrameId, to: undefined });
        else if (to !== cel.linkTo) fixes.push({ layerId: layer.id, fid: fid as FrameId, to });
      }
    }
    if (fixes.length > 0) {
      tx.update((d) => {
        const byId = new Map(celLayers(d.layers).map((l) => [l.id as string, l]));
        for (const x of fixes) {
          const layer = byId.get(x.layerId);
          if (layer === undefined) continue;
          if (x.to === undefined) Reflect.deleteProperty(layer.cels, x.fid);
          else layer.cels[x.fid] = { linkTo: x.to };
        }
      });
      const dropped = fixes.filter((x) => x.to === undefined).length;
      if (dropped > 0)
        warnings.push(
          `${String(dropped)} linked cel(s) outside the file lost their target and were removed`,
        );
    }
  }

  // ---- delete orphaned images ----
  const still = referencedImages(tx.doc);
  for (const id of candidates) {
    if (!still.has(id) && tx.image(id) !== undefined) {
      tx.deleteImage(id);
      report.images.deleted++;
    }
  }
  return report;
}

// ---- public API -------------------------------------------------------------------------------------------

/**
 * Imports an `.aseprite` file into an open transaction, **adding** its layers, animations and
 * palette to the document (see the module description for the mapping). Layer names that clash with
 * existing layers get a numeric suffix (`body_2`); an animation `(group, undefined)` that already
 * exists is an error. The canvas must equal the file's, and an indexed document only takes an
 * indexed file. `part:` layers are bound with `bindParts` when the rig has the bone and view;
 * otherwise they stay pixel layers and are listed in `report.parts.unbound` with the raw name.
 *
 * @param input file bytes, or an already parsed {@link AseFile}
 * @throws IoError `SIZE_MISMATCH`, `BAD_INPUT`, `DUPLICATE_ANIMATION`; `AseError` for a bad file.
 */
export function importAsepriteTx(
  tx: Transaction,
  input: Uint8Array | AseFile,
  options: AsepriteImportOptions = {},
): AsepriteImportReport {
  return run(tx, input, options, false);
}

/**
 * Re-imports an edited `.aseprite` file into the document it was imported into, in place. Layers
 * and parts are matched **by name**, animations by group, frames by `(tag, index)`:
 *
 * - a matched layer keeps its id, position, visibility, opacity and export flag; its cels on the
 *   file's frames are replaced (pixels are written into the existing image when the size is the
 *   same, so the image id is kept);
 * - a matched part variant (`part:` layer: bone, part, variant, view) keeps its id and pivot; only
 *   its pixels change, in place when the size is unchanged (part sources are canvas-sized);
 * - matched frames keep their ids, bone keys, part keys, markers, events, root motion and
 *   overrides; only the duration is taken from the file. The animation's loop mode is kept;
 * - **frames added** in the file are appended to the animation without keys (reported in
 *   `report.addedFrames`); **frames removed** drop their keys, overrides and cels
 *   (`report.removedFrames` lists each with the keys and overrides it lost);
 * - layers and animations of the document that the file does not mention are left untouched
 *   (`layersNotInSource`, `animationsNotInSource`); layers and animations of the file that the
 *   document lacks are created, and new `part:` layers are bound.
 *
 * Re-importing an unchanged file changes nothing.
 *
 * @throws IoError `SIZE_MISMATCH`, `BAD_INPUT`; `AseError` for a bad file.
 */
export function reimportAsepriteTx(
  tx: Transaction,
  input: Uint8Array | AseFile,
  options: AsepriteImportOptions = {},
): AsepriteImportReport {
  return run(tx, input, options, true);
}

/**
 * Builds a fresh document from an `.aseprite` file (one undoable transaction "Import .aseprite"):
 * canvas, colour mode (indexed for an 8-bit file, else RGBA), palette (active), layers, animations.
 * `part:` layers stay pixel layers (a new document has no rig); bind them later with `bindParts`
 * and `report.parts.unbound[].source` as `rawNames`.
 */
export function createDocumentFromAseprite(
  input: Uint8Array | AseFile,
  options: CreateFromAsepriteOptions = {},
): { store: DocumentStore; report: AsepriteImportReport } {
  const file = input instanceof Uint8Array ? parseAseprite(input) : input;
  const { width: w, height: h } = file.header;
  const gen = createIdGenerator({ seed: options.idSeed ?? 1, next: 0 });
  const doc: Document = {
    meta: {
      id: gen.next('doc'),
      name: options.name ?? 'aseprite',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w, h },
      origin: options.origin ?? defaultOrigin([w, h]),
      pixelsPerUnit: options.pixelsPerUnit ?? 16,
      colorMode: file.header.colorDepth === 8 ? 'indexed' : 'rgba',
      paletteLocked: false,
      ids: gen.state(),
    },
    palettes: [],
    skins: [],
    layers: [],
    animations: [],
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
  };
  const store = new DocumentStore(doc);
  const tx = store.begin('Import .aseprite');
  try {
    const report = run(tx, file, options, false);
    tx.commit();
    return { store, report };
  } catch (e) {
    tx.cancel();
    throw e;
  }
}

/**
 * Re-imports `input` into `store` as one undoable transaction "Re-import .aseprite" (see
 * {@link reimportAsepriteTx}). The transaction is cancelled when the import throws.
 */
export function reimportAseprite(
  store: DocumentStore,
  input: Uint8Array | AseFile,
  options: AsepriteImportOptions = {},
): AsepriteImportReport {
  return store.transact('Re-import .aseprite', (tx) => reimportAsepriteTx(tx, input, options));
}
