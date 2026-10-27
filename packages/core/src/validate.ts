/**
 * `validate(view)`: checks the document invariants I1-I7 (spec 3.3) plus image bookkeeping, and
 * returns findings instead of throwing. Pure; takes a store, snapshot or open transaction.
 * @packageDocumentation
 */
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { Document, ID_SPACE, makeId } from '@pixel-forge/schema';
import type { IdKind, ImageId } from '@pixel-forge/schema';
import type { DeepReadonly } from './json.js';
import type { DocumentView } from './view.js';

/** Severity of a {@link Finding}. Only `error` means the document breaks an invariant. */
export type Severity = 'error' | 'warning';

/** One problem found by {@link validate}. */
export interface Finding {
  /** Stable machine-readable code, see {@link FINDING_CODES}. */
  readonly code: string;
  readonly severity: Severity;
  /** Where, as a JSON path into the document (or `['images', id]` for a stored image). */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * Every code `validate()` can report, with its severity and invariant. Additive.
 *
 * Errors: `SCHEMA` (I5, I7 and all structure: the document fails `Document.safeParse`; when it does,
 * only these findings are returned, since the other checks assume a well-formed document);
 * `ID_DUPLICATE` (I4); `BONE_PARENT_MISSING`, `BONE_CYCLE`, `BONE_NAME_DUPLICATE`, `PART_BONE_MISSING`,
 * `PART_LAYER_MISSING`, `PART_LAYER_NOT_PART`, `PART_LAYER_SHARED`, `PART_LAYER_NAME_DUPLICATE`,
 * `VARIANT_VIEW_MISSING`, `VIEW_NAME_DUPLICATE`, `VIEW_BONE_MISSING`, `VIEW_PART_MISSING`,
 * `BONE_KEY_BONE_MISSING`, `PART_KEY_PART_MISSING`, `PART_KEY_VARIANT_MISSING`,
 * `OVERRIDE_PART_MISSING`, `OVERRIDE_FRAME_MISSING`, `CEL_FRAME_MISSING`, `ACTIVE_PALETTE_MISSING`,
 * `SKIN_PALETTE_MISSING`, `SKIN_NAME_DUPLICATE`, `SKIN_INDEX_RANGE`, `RAMP_NAME_DUPLICATE`,
 * `RAMP_INDEX_RANGE`, `MARKER_DEF_DUPLICATE`, `EVENT_DEF_DUPLICATE` (I1, I7); `IMAGE_MISSING`;
 * `LINK_TARGET_MISSING`, `LINK_TO_LINK`, `LINK_SELF` (I3); `INDEX_OUT_OF_RANGE`,
 * `TRANSPARENT_INDEX_OPAQUE` (I2); `ANIM_KEY_DUPLICATE`, `MIRROR_SOURCE_MISSING`, `MIRROR_OF_MIRROR`,
 * `MIRROR_GROUP_MISMATCH` (I6).
 *
 * Warnings: `ID_COUNTER_BEHIND` (I4), `PALETTE_LOCK_COLOR` (I2; the render lint of T4.1 is
 * authoritative), `IMAGE_KIND_MISMATCH`, `IMAGE_ORPHAN`, `PART_LAYER_UNBOUND`, `LAYER_NAME_DUPLICATE`
 * (I7), `VARIANT_NAME_DUPLICATE`.
 */
export const FINDING_CODES = [
  'SCHEMA',
  'ID_DUPLICATE',
  'ID_COUNTER_BEHIND',
  'BONE_PARENT_MISSING',
  'BONE_CYCLE',
  'BONE_NAME_DUPLICATE',
  'PART_BONE_MISSING',
  'PART_LAYER_MISSING',
  'PART_LAYER_NOT_PART',
  'PART_LAYER_SHARED',
  'PART_LAYER_NAME_DUPLICATE',
  'PART_LAYER_UNBOUND',
  'VARIANT_VIEW_MISSING',
  'VARIANT_NAME_DUPLICATE',
  'VIEW_NAME_DUPLICATE',
  'VIEW_BONE_MISSING',
  'VIEW_PART_MISSING',
  'BONE_KEY_BONE_MISSING',
  'PART_KEY_PART_MISSING',
  'PART_KEY_VARIANT_MISSING',
  'OVERRIDE_PART_MISSING',
  'OVERRIDE_FRAME_MISSING',
  'CEL_FRAME_MISSING',
  'LINK_TARGET_MISSING',
  'LINK_TO_LINK',
  'LINK_SELF',
  'ACTIVE_PALETTE_MISSING',
  'SKIN_PALETTE_MISSING',
  'SKIN_NAME_DUPLICATE',
  'SKIN_INDEX_RANGE',
  'RAMP_NAME_DUPLICATE',
  'RAMP_INDEX_RANGE',
  'MARKER_DEF_DUPLICATE',
  'EVENT_DEF_DUPLICATE',
  'LAYER_NAME_DUPLICATE',
  'IMAGE_MISSING',
  'IMAGE_ORPHAN',
  'IMAGE_KIND_MISMATCH',
  'INDEX_OUT_OF_RANGE',
  'TRANSPARENT_INDEX_OPAQUE',
  'PALETTE_LOCK_COLOR',
  'ANIM_KEY_DUPLICATE',
  'MIRROR_SOURCE_MISSING',
  'MIRROR_OF_MIRROR',
  'MIRROR_GROUP_MISMATCH',
] as const;

/** A code `validate()` can report. */
export type FindingCode = (typeof FINDING_CODES)[number];

type Path = readonly (string | number)[];
type Doc = DeepReadonly<Document>;
type Lay = DeepReadonly<Document['layers'][number]>;

// ---- id counter detection (I4) -------------------------------------------------------------------
// The schema's generator encodes `scramble(seed, counter)`, a bijection on [0, 2^30). We invert it
// to recover the counter of every 6-character id and compare with `meta.ids.next`. The constants
// mirror schema/src/ids.ts; the decoded counter is verified by re-encoding with `makeId`, so if the
// schema changes the check goes silent instead of reporting nonsense.

const MASK = ID_SPACE - 1;
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const OFFSET = 0x1b873593;
const MUL_A = 0x2c1b3c6d;
const MUL_B = 0x297a2d39;

function modInverse(a: number): number {
  let x = a;
  for (let i = 0; i < 5; i++) x = Math.imul(x, 2 - Math.imul(a, x));
  return x & MASK;
}
const INV_A = modInverse(MUL_A);
const INV_B = modInverse(MUL_B);

function counterOf(kind: IdKind, seed: number, id: string): number | undefined {
  const body = id.slice(id.indexOf('_') + 1);
  if (body.length !== 6) return undefined;
  let value = 0;
  for (const ch of body) {
    const digit = CROCKFORD.indexOf(ch);
    if (digit < 0) return undefined;
    value = value * 32 + digit;
  }
  let x = value;
  x ^= (x >>> 13) ^ (x >>> 26);
  x = Math.imul(x, INV_B) & MASK;
  x = (x - seed) & MASK;
  x ^= x >>> 15;
  x = Math.imul(x, INV_A) & MASK;
  x ^= seed;
  const counter = (x - OFFSET) & MASK;
  return makeId(kind, seed, counter) === id ? counter : undefined;
}

const KIND_OF_PREFIX: Record<string, IdKind> = {
  doc: 'doc',
  lay: 'layer',
  frm: 'frame',
  anm: 'animation',
  bon: 'bone',
  prt: 'part',
  var: 'variant',
  viw: 'view',
  img: 'image',
  ovr: 'override',
  pal: 'palette',
  skn: 'skin',
};

// ---- validate -------------------------------------------------------------------------------------

/**
 * Checks invariants I1-I7 and image bookkeeping of `view` and returns all findings (empty: clean).
 * Never throws and never mutates. A document that fails the schema yields only `SCHEMA` findings.
 *
 * Decisions (documented in the core README):
 * - **I4 counter**: each 6-character generated id is decoded back to its counter; any counter >=
 *   `meta.ids.next` means the generator would re-issue an id still in use (`ID_COUNTER_BEHIND`,
 *   warning, because a hand-written 6-character id decodes to an arbitrary counter).
 * - **I7 uniqueness**: the regex is the schema's job. Here: part-layer names are unique document-wide
 *   (error: `part:` ops address them by name), other layer names unique among siblings (warning),
 *   bone, view, skin, ramp (per palette), marker-def and event-def names unique (errors), variant
 *   names unique per part and view (warning).
 * - **I2** palette lock for RGBA documents is only checked on stored images (`PALETTE_LOCK_COLOR`,
 *   warning); the render-based lint (T4.1) is authoritative.
 */
export function validate(view: DocumentView): Finding[] {
  const parsed = Document.safeParse(view.doc);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({
      code: 'SCHEMA',
      severity: 'error' as const,
      path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
      message: i.message,
    }));
  }
  return new Checker(view, view.doc).run();
}

class Checker {
  private readonly out: Finding[] = [];
  private readonly frameOwner = new Map<string, number>(); // frame id -> animation index (authored)
  private readonly layerById = new Map<string, { layer: Lay; path: Path }>();

  constructor(
    private readonly view: DocumentView,
    private readonly doc: Doc,
  ) {}

  private add(code: FindingCode, severity: Severity, path: Path, message: string): void {
    this.out.push({ code, severity, path, message });
  }
  private err(code: FindingCode, path: Path, message: string): void {
    this.add(code, 'error', path, message);
  }
  private warn(code: FindingCode, path: Path, message: string): void {
    this.add(code, 'warning', path, message);
  }

  run(): Finding[] {
    this.indexLayers(this.doc.layers, ['layers']);
    this.doc.animations.forEach((a, i) => {
      if ('frames' in a) for (const f of a.frames) this.frameOwner.set(f.id, i);
    });
    this.ids();
    this.palettes();
    this.layers();
    this.rig();
    this.animations();
    this.cels();
    this.images();
    return this.out;
  }

  private indexLayers(layers: readonly Lay[], base: Path): void {
    layers.forEach((l, i) => {
      const path = [...base, i];
      this.layerById.set(l.id, { layer: l, path });
      if (l.kind === 'group') this.indexLayers(l.children, [...path, 'children']);
    });
  }

  // I4
  private ids(): void {
    const seen = new Map<string, Path>();
    const { seed, next } = this.doc.meta.ids;
    const note = (id: string, path: Path): void => {
      const prev = seen.get(id);
      if (prev !== undefined) {
        this.err('ID_DUPLICATE', path, `id ${id} is also used at ${prev.join('/')}`);
        return;
      }
      seen.set(id, path);
      const kind = KIND_OF_PREFIX[id.slice(0, id.indexOf('_'))];
      const counter = kind === undefined ? undefined : counterOf(kind, seed, id);
      if (counter !== undefined && counter >= next) {
        this.warn(
          'ID_COUNTER_BEHIND',
          path,
          `id ${id} was generated at counter ${String(counter)} but meta.ids.next is ${String(next)}: it could be issued again`,
        );
      }
    };
    note(this.doc.meta.id, ['meta', 'id']);
    this.doc.palettes.forEach((p, i) => {
      note(p.id, ['palettes', i, 'id']);
    });
    this.doc.skins.forEach((s, i) => {
      note(s.id, ['skins', i, 'id']);
    });
    for (const [l, { path }] of this.layerById) note(l, [...path, 'id']);
    const rig = this.doc.rig;
    rig?.bones.forEach((b, i) => {
      note(b.id, ['rig', 'bones', i, 'id']);
    });
    rig?.views.forEach((v, i) => {
      note(v.id, ['rig', 'views', i, 'id']);
    });
    rig?.parts.forEach((p, i) => {
      note(p.id, ['rig', 'parts', i, 'id']);
      p.variants.forEach((v, j) => {
        note(v.id, ['rig', 'parts', i, 'variants', j, 'id']);
      });
    });
    this.doc.animations.forEach((a, i) => {
      note(a.id, ['animations', i, 'id']);
      if ('frames' in a)
        a.frames.forEach((f, j) => {
          note(f.id, ['animations', i, 'frames', j, 'id']);
        });
      a.overrides.forEach((o, j) => {
        note(o.id, ['animations', i, 'overrides', j, 'id']);
      });
    });
  }

  // I2 (palette side), skins, ramps
  private palettes(): void {
    const { activePaletteId } = this.doc;
    const active = this.doc.palettes.find((p) => p.id === activePaletteId);
    if (activePaletteId !== undefined && active === undefined) {
      this.err(
        'ACTIVE_PALETTE_MISSING',
        ['activePaletteId'],
        `active palette ${activePaletteId} does not exist`,
      );
    } else if (activePaletteId === undefined && this.doc.meta.colorMode === 'indexed') {
      this.err(
        'ACTIVE_PALETTE_MISSING',
        ['activePaletteId'],
        'an indexed document needs an active palette',
      );
    }
    this.doc.palettes.forEach((p, pi) => {
      const names = new Set<string>();
      p.ramps.forEach((r, ri) => {
        if (names.has(r.name))
          this.err(
            'RAMP_NAME_DUPLICATE',
            ['palettes', pi, 'ramps', ri, 'name'],
            `ramp name ${r.name} repeats in palette ${p.id}`,
          );
        names.add(r.name);
        r.indices.forEach((ix, k) => {
          if (ix >= p.colors.length)
            this.err(
              'RAMP_INDEX_RANGE',
              ['palettes', pi, 'ramps', ri, 'indices', k],
              `ramp ${r.name}: index ${String(ix)} >= palette length ${String(p.colors.length)}`,
            );
        });
      });
    });
    const skinNames = new Set<string>();
    this.doc.skins.forEach((s, i) => {
      if (skinNames.has(s.name))
        this.err('SKIN_NAME_DUPLICATE', ['skins', i, 'name'], `skin name ${s.name} repeats`);
      skinNames.add(s.name);
      if ('paletteId' in s) {
        if (!this.doc.palettes.some((p) => p.id === s.paletteId))
          this.err(
            'SKIN_PALETTE_MISSING',
            ['skins', i, 'paletteId'],
            `skin ${s.name} uses missing palette ${s.paletteId}`,
          );
      } else if (active !== undefined) {
        s.remap.forEach((pair, k) => {
          for (const ix of pair) {
            if (ix >= active.colors.length)
              this.err(
                'SKIN_INDEX_RANGE',
                ['skins', i, 'remap', k],
                `skin ${s.name}: index ${String(ix)} >= palette length ${String(active.colors.length)}`,
              );
          }
        });
      }
    });
    const dup = (
      defs: readonly { readonly name: string }[],
      key: 'markerDefs' | 'eventDefs',
      code: FindingCode,
    ): void => {
      const names = new Set<string>();
      defs.forEach((d, i) => {
        if (names.has(d.name)) this.err(code, [key, i, 'name'], `${key} name ${d.name} repeats`);
        names.add(d.name);
      });
    };
    dup(this.doc.markerDefs, 'markerDefs', 'MARKER_DEF_DUPLICATE');
    dup(this.doc.eventDefs, 'eventDefs', 'EVENT_DEF_DUPLICATE');
  }

  // I7 layer names, part layer binding
  private layers(): void {
    const partNames = new Map<string, Path>();
    const sibling = (layers: readonly Lay[], base: Path): void => {
      const names = new Set<string>();
      layers.forEach((l, i) => {
        const path = [...base, i];
        if (names.has(l.name))
          this.warn(
            'LAYER_NAME_DUPLICATE',
            [...path, 'name'],
            `layer name ${l.name} repeats among siblings`,
          );
        names.add(l.name);
        if (l.kind === 'part') {
          const prev = partNames.get(l.name);
          if (prev !== undefined)
            this.err(
              'PART_LAYER_NAME_DUPLICATE',
              [...path, 'name'],
              `part layer name ${l.name} is also used at ${prev.join('/')}`,
            );
          else partNames.set(l.name, path);
          if (!this.doc.rig?.parts.some((p) => p.layerId === l.id))
            this.warn('PART_LAYER_UNBOUND', path, `part layer ${l.name} has no part`);
        }
        if (l.kind === 'group') sibling(l.children, [...path, 'children']);
      });
    };
    sibling(this.doc.layers, ['layers']);
  }

  // I1 rig
  private rig(): void {
    const rig = this.doc.rig;
    if (rig === undefined) return;
    const boneIds = new Set(rig.bones.map((b) => b.id as string));
    const partIds = new Set(rig.parts.map((p) => p.id as string));
    const viewIds = new Set(rig.views.map((v) => v.id as string));
    const boneNames = new Set<string>();
    rig.bones.forEach((b, i) => {
      if (boneNames.has(b.name))
        this.err('BONE_NAME_DUPLICATE', ['rig', 'bones', i, 'name'], `bone name ${b.name} repeats`);
      boneNames.add(b.name);
      if (b.parentId !== undefined && !boneIds.has(b.parentId))
        this.err(
          'BONE_PARENT_MISSING',
          ['rig', 'bones', i, 'parentId'],
          `bone ${b.name} has missing parent ${b.parentId}`,
        );
    });
    const parent = new Map(
      rig.bones.map((b) => [b.id as string, b.parentId as string | undefined]),
    );
    const state = new Map<string, 1 | 2>(); // 1 visiting, 2 done
    rig.bones.forEach((b, i) => {
      const chain: string[] = [];
      let cur: string | undefined = b.id;
      while (cur !== undefined && state.get(cur) === undefined) {
        state.set(cur, 1);
        chain.push(cur);
        cur = parent.get(cur);
      }
      if (cur !== undefined && state.get(cur) === 1) {
        this.err(
          'BONE_CYCLE',
          ['rig', 'bones', i, 'parentId'],
          `bone ${b.name} is part of a parent cycle`,
        );
      }
      for (const c of chain) state.set(c, 2);
    });
    const usedLayers = new Map<string, number>();
    rig.parts.forEach((p, i) => {
      const base = ['rig', 'parts', i];
      if (!boneIds.has(p.boneId))
        this.err(
          'PART_BONE_MISSING',
          [...base, 'boneId'],
          `part ${p.id} uses missing bone ${p.boneId}`,
        );
      const layer = this.layerById.get(p.layerId);
      if (layer === undefined)
        this.err(
          'PART_LAYER_MISSING',
          [...base, 'layerId'],
          `part ${p.id} uses missing layer ${p.layerId}`,
        );
      else if (layer.layer.kind !== 'part')
        this.err(
          'PART_LAYER_NOT_PART',
          [...base, 'layerId'],
          `part ${p.id}: layer ${p.layerId} is not a part layer`,
        );
      const prev = usedLayers.get(p.layerId);
      if (prev !== undefined)
        this.err(
          'PART_LAYER_SHARED',
          [...base, 'layerId'],
          `parts ${rig.parts[prev]?.id ?? ''} and ${p.id} share layer ${p.layerId}`,
        );
      usedLayers.set(p.layerId, i);
      const vnames = new Set<string>();
      p.variants.forEach((v, j) => {
        if (!viewIds.has(v.viewId))
          this.err(
            'VARIANT_VIEW_MISSING',
            [...base, 'variants', j, 'viewId'],
            `variant ${v.id} uses missing view ${v.viewId}`,
          );
        const key = `${v.viewId}/${v.name}`;
        if (vnames.has(key))
          this.warn(
            'VARIANT_NAME_DUPLICATE',
            [...base, 'variants', j, 'name'],
            `variant name ${v.name} repeats in part ${p.id} view ${v.viewId}`,
          );
        vnames.add(key);
      });
    });
    const viewNames = new Set<string>();
    rig.views.forEach((v, i) => {
      if (viewNames.has(v.name))
        this.err('VIEW_NAME_DUPLICATE', ['rig', 'views', i, 'name'], `view name ${v.name} repeats`);
      viewNames.add(v.name);
      for (const b of Object.keys(v.rest))
        if (!boneIds.has(b))
          this.err(
            'VIEW_BONE_MISSING',
            ['rig', 'views', i, 'rest', b],
            `view ${v.name}: missing bone ${b}`,
          );
      for (const key of ['partVisibility', 'defaultZ'] as const) {
        for (const p of Object.keys(v[key]))
          if (!partIds.has(p))
            this.err(
              'VIEW_PART_MISSING',
              ['rig', 'views', i, key, p],
              `view ${v.name}: missing part ${p}`,
            );
      }
    });
  }

  // I6 + keys + overrides (I1)
  private animations(): void {
    const keys = new Map<string, number>();
    const rig = this.doc.rig;
    const partById = new Map((rig?.parts ?? []).map((p) => [p.id as string, p]));
    const boneIds = new Set((rig?.bones ?? []).map((b) => b.id as string));
    this.doc.animations.forEach((a, i) => {
      const base = ['animations', i];
      const key = `${a.group}\u0000${a.direction ?? ''}\u0000${a.direction === undefined ? 'u' : 'd'}`;
      const prev = keys.get(key);
      if (prev !== undefined)
        this.err(
          'ANIM_KEY_DUPLICATE',
          base,
          `animation (${a.group}, ${a.direction ?? 'undirected'}) repeats animation at index ${String(prev)}`,
        );
      keys.set(key, i);
      let frameIds: Set<string>;
      if ('mirrorOf' in a) {
        const src = this.doc.animations.find((s) => s.id === a.mirrorOf);
        if (src === undefined) {
          this.err(
            'MIRROR_SOURCE_MISSING',
            [...base, 'mirrorOf'],
            `mirror source ${a.mirrorOf} does not exist`,
          );
          frameIds = new Set();
        } else if ('mirrorOf' in src) {
          this.err(
            'MIRROR_OF_MIRROR',
            [...base, 'mirrorOf'],
            `mirror source ${src.id} is itself a mirror`,
          );
          frameIds = new Set();
        } else {
          if (src.group !== a.group)
            this.err(
              'MIRROR_GROUP_MISMATCH',
              [...base, 'mirrorOf'],
              `mirror group ${a.group} differs from source group ${src.group}`,
            );
          frameIds = new Set(src.frames.map((f) => f.id as string));
        }
      } else {
        frameIds = new Set(a.frames.map((f) => f.id as string));
        a.frames.forEach((f, j) => {
          for (const b of Object.keys(f.boneKeys))
            if (!boneIds.has(b))
              this.err(
                'BONE_KEY_BONE_MISSING',
                [...base, 'frames', j, 'boneKeys', b],
                `key for missing bone ${b}`,
              );
          for (const [pid, k] of Object.entries(f.partKeys)) {
            const part = partById.get(pid);
            if (part === undefined) {
              this.err(
                'PART_KEY_PART_MISSING',
                [...base, 'frames', j, 'partKeys', pid],
                `key for missing part ${pid}`,
              );
            } else if (
              k.variant !== undefined &&
              k.variant !== 'auto' &&
              !part.variants.some((v) => v.id === k.variant)
            ) {
              this.err(
                'PART_KEY_VARIANT_MISSING',
                [...base, 'frames', j, 'partKeys', pid, 'variant'],
                `part ${pid} has no variant ${k.variant}`,
              );
            }
          }
        });
      }
      a.overrides.forEach((o, j) => {
        if (o.target !== 'final' && !partById.has(o.target.partId))
          this.err(
            'OVERRIDE_PART_MISSING',
            [...base, 'overrides', j, 'target'],
            `override targets missing part ${o.target.partId}`,
          );
        if (!frameIds.has(o.frameId))
          this.err(
            'OVERRIDE_FRAME_MISSING',
            [...base, 'overrides', j, 'frameId'],
            `override frame ${o.frameId} is not a frame of this animation`,
          );
      });
    });
  }

  // I1 cels + I3 links
  private cels(): void {
    for (const [, { layer, path }] of this.layerById) {
      if (layer.kind !== 'pixel' && layer.kind !== 'reference') continue;
      for (const [fid, cel] of Object.entries(layer.cels)) {
        const at = [...path, 'cels', fid];
        if (!this.frameOwner.has(fid))
          this.err(
            'CEL_FRAME_MISSING',
            at,
            `cel of layer ${layer.name} is keyed by unknown frame ${fid}`,
          );
        if (!('linkTo' in cel)) continue;
        if (cel.linkTo === fid) {
          this.err('LINK_SELF', at, `cel links to itself`);
          continue;
        }
        const target = layer.cels[cel.linkTo];
        if (target === undefined)
          this.err(
            'LINK_TARGET_MISSING',
            at,
            `link target ${cel.linkTo} has no cel on layer ${layer.name}`,
          );
        else if ('linkTo' in target)
          this.err('LINK_TO_LINK', at, `link target ${cel.linkTo} is itself a link`);
      }
    }
  }

  // image references, orphans, I2 stored-image checks
  private images(): void {
    const refs = new Map<string, Path>();
    const masks = new Set<string>();
    const ref = (id: string, path: Path, mask = false): void => {
      if (!refs.has(id)) refs.set(id, path);
      if (mask) masks.add(id);
      if (this.view.image(id as ImageId) === undefined)
        this.err('IMAGE_MISSING', path, `image ${id} is not stored`);
    };
    for (const [, { layer, path }] of this.layerById) {
      if (layer.kind !== 'pixel' && layer.kind !== 'reference') continue;
      for (const [fid, cel] of Object.entries(layer.cels))
        if ('imageId' in cel) ref(cel.imageId, [...path, 'cels', fid, 'imageId']);
    }
    this.doc.rig?.parts.forEach((p, i) => {
      p.variants.forEach((v, j) => {
        ref(v.imageId, ['rig', 'parts', i, 'variants', j, 'imageId']);
      });
    });
    this.doc.animations.forEach((a, i) => {
      a.overrides.forEach((o, j) => {
        if (o.set !== undefined) ref(o.set, ['animations', i, 'overrides', j, 'set']);
        if (o.erase !== undefined) ref(o.erase, ['animations', i, 'overrides', j, 'erase'], true);
      });
    });
    const { colorMode, paletteLocked } = this.doc.meta;
    const palette = this.doc.palettes.find((p) => p.id === this.doc.activePaletteId);
    for (const id of this.view.imageIds()) {
      const at = ['images', id];
      if (!refs.has(id))
        this.warn('IMAGE_ORPHAN', at, `image ${id} is not referenced by the document`);
      const img = this.view.image(id);
      if (img === undefined || masks.has(id)) continue; // erase masks are 8-bit masks in every mode
      if (colorMode === 'indexed') {
        if (!(img instanceof IndexedImage)) {
          this.warn('IMAGE_KIND_MISMATCH', at, `image ${id} is RGBA in an indexed document`);
          continue;
        }
        if (palette === undefined) continue;
        const len = palette.colors.length;
        let max = 0;
        for (const ix of img.toIndices()) if (ix > max) max = ix;
        if (max >= len)
          this.err(
            'INDEX_OUT_OF_RANGE',
            at,
            `image ${id} uses index ${String(max)} but the palette has ${String(len)} colours`,
          );
        const t = palette.colors[img.transparentIndex];
        if (t !== undefined && t[3] !== 0)
          this.err(
            'TRANSPARENT_INDEX_OPAQUE',
            at,
            `image ${id}: palette[${String(img.transparentIndex)}] has alpha ${String(t[3])}, expected 0`,
          );
      } else if (img instanceof IndexedImage) {
        this.warn('IMAGE_KIND_MISMATCH', at, `image ${id} is indexed in an RGBA document`);
      } else if (paletteLocked && img instanceof TiledImage && palette !== undefined) {
        const allowed = new Set(palette.colors.map((c) => c.join(',')));
        const { data } = img.toRGBA();
        let bad: string | undefined;
        for (let o = 0; o < data.length && bad === undefined; o += 4) {
          if (data[o + 3] === 0) continue;
          const c = `${String(data[o])},${String(data[o + 1])},${String(data[o + 2])},${String(data[o + 3])}`;
          if (!allowed.has(c)) bad = c;
        }
        if (bad !== undefined)
          this.warn(
            'PALETTE_LOCK_COLOR',
            at,
            `image ${id} has colour ${bad} outside the locked palette (the render lint is authoritative)`,
          );
      }
    }
  }
}
