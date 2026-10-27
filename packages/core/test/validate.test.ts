import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import type {
  AuthoredAnimation,
  BoneId,
  Document,
  FrameId,
  ImageId,
  LayerId,
  MirrorAnimation,
  PartId,
  VariantId,
  ViewId,
} from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { DocumentStore, FINDING_CODES, validate } from '../src/index.js';
import type { Finding, FindingCode, StoredImage } from '../src/index.js';
import { F, richDoc, richImages, richStore } from './frames-fixture.js';

type Images = [ImageId, StoredImage][];
type Mutate = (d: Document, images: Images) => void;

function findings(mutate: Mutate): Finding[] {
  const doc = richDoc();
  const images = richImages();
  mutate(doc, images);
  return validate(new DocumentStore(doc, { images }));
}

const run = (d: Document): AuthoredAnimation => d.animations[0] as AuthoredAnimation;
const mirror = (d: Document): MirrorAnimation => d.animations[1] as MirrorAnimation;
const idle = (d: Document): AuthoredAnimation => d.animations[2] as AuthoredAnimation;
const rig = (d: Document) => {
  if (d.rig === undefined) throw new Error('fixture has a rig');
  return d.rig;
};
const ghost = {
  bone: 'bon_ghost' as BoneId,
  part: 'prt_ghost' as PartId,
  frame: 'frm_ghost' as FrameId,
  layer: 'lay_ghost' as LayerId,
  view: 'viw_ghost' as ViewId,
  variant: 'var_ghost' as VariantId,
  image: 'img_ghost' as ImageId,
};

/** Make the document indexed: palette of 4 (index 0 transparent), every image an IndexedImage. */
function toIndexed(d: Document, images: Images, fill: (img: IndexedImage) => void): void {
  d.meta.colorMode = 'indexed';
  const pal = d.palettes[0];
  if (pal)
    pal.colors = [
      [0, 0, 0, 0],
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ];
  images.forEach((entry, i) => {
    const old = entry[1];
    const img = new IndexedImage(old.width, old.height);
    img.set(1, 1, 1);
    fill(img);
    images[i] = [entry[0], i === 7 ? old : img]; // image 7 is the erase mask
  });
}

const CASES: readonly [FindingCode, 'error' | 'warning', Mutate][] = [
  [
    'SCHEMA',
    'error',
    (d) => {
      d.meta.canvas.w = 1.5;
    },
  ],
  [
    'ID_DUPLICATE',
    'error',
    (d) => {
      idle(d).id = F.run;
    },
  ],
  [
    'ID_COUNTER_BEHIND',
    'warning',
    (d) => {
      d.meta.ids.next = 0;
    },
  ],
  [
    'BONE_PARENT_MISSING',
    'error',
    (d) => {
      const b = rig(d).bones[1];
      if (b) b.parentId = ghost.bone;
    },
  ],
  [
    'BONE_CYCLE',
    'error',
    (d) => {
      const b = rig(d).bones[0];
      if (b) b.parentId = F.boneArm;
    },
  ],
  [
    'BONE_NAME_DUPLICATE',
    'error',
    (d) => {
      const b = rig(d).bones[1];
      if (b) b.name = 'root';
    },
  ],
  [
    'PART_BONE_MISSING',
    'error',
    (d) => {
      const p = rig(d).parts[0];
      if (p) p.boneId = ghost.bone;
    },
  ],
  [
    'PART_LAYER_MISSING',
    'error',
    (d) => {
      const p = rig(d).parts[0];
      if (p) p.layerId = ghost.layer;
    },
  ],
  [
    'PART_LAYER_NOT_PART',
    'error',
    (d) => {
      const p = rig(d).parts[0];
      if (p) p.layerId = F.layBody;
    },
  ],
  [
    'PART_LAYER_SHARED',
    'error',
    (d) => {
      const p = rig(d).parts[0];
      const v = p?.variants[0];
      if (p && v)
        rig(d).parts.push({
          ...p,
          id: 'prt_two' as PartId,
          variants: [{ ...v, id: 'var_two' as VariantId }],
        });
    },
  ],
  [
    'PART_LAYER_NAME_DUPLICATE',
    'error',
    (d) => {
      d.layers.push({
        kind: 'part',
        id: 'lay_two' as LayerId,
        name: 'arm',
        visible: true,
        opacity: 255,
        export: true,
      });
    },
  ],
  [
    'PART_LAYER_UNBOUND',
    'warning',
    (d) => {
      d.layers.push({
        kind: 'part',
        id: 'lay_two' as LayerId,
        name: 'unbound',
        visible: true,
        opacity: 255,
        export: true,
      });
    },
  ],
  [
    'VARIANT_VIEW_MISSING',
    'error',
    (d) => {
      const v = rig(d).parts[0]?.variants[0];
      if (v) v.viewId = ghost.view;
    },
  ],
  [
    'VARIANT_NAME_DUPLICATE',
    'warning',
    (d) => {
      const v = rig(d).parts[0]?.variants[1];
      if (v) v.name = 'a';
    },
  ],
  [
    'VIEW_NAME_DUPLICATE',
    'error',
    (d) => {
      const v = rig(d).views[0];
      if (v) rig(d).views.push({ ...v, id: 'viw_two' as ViewId });
    },
  ],
  [
    'VIEW_BONE_MISSING',
    'error',
    (d) => {
      const v = rig(d).views[0];
      if (v) v.rest[ghost.bone] = { x: 0, y: 0, angle: 0 };
    },
  ],
  [
    'VIEW_PART_MISSING',
    'error',
    (d) => {
      const v = rig(d).views[0];
      if (v) v.defaultZ[ghost.part] = 1;
    },
  ],
  [
    'BONE_KEY_BONE_MISSING',
    'error',
    (d) => {
      const f = run(d).frames[0];
      if (f) f.boneKeys[ghost.bone] = { angle: 1 };
    },
  ],
  [
    'PART_KEY_PART_MISSING',
    'error',
    (d) => {
      const f = run(d).frames[0];
      if (f) f.partKeys[ghost.part] = { z: 1 };
    },
  ],
  [
    'PART_KEY_VARIANT_MISSING',
    'error',
    (d) => {
      const f = run(d).frames[0];
      if (f) f.partKeys[F.part] = { variant: ghost.variant };
    },
  ],
  [
    'OVERRIDE_PART_MISSING',
    'error',
    (d) => {
      const o = run(d).overrides[0];
      if (o) o.target = { partId: ghost.part };
    },
  ],
  [
    'OVERRIDE_FRAME_MISSING',
    'error',
    (d) => {
      const o = mirror(d).overrides[0];
      if (o) o.frameId = F.g0; // a frame of another animation, not of the mirror's source
    },
  ],
  [
    'CEL_FRAME_MISSING',
    'error',
    (d) => {
      const l = d.layers[3];
      if (l?.kind === 'reference')
        l.cels[ghost.frame] = { imageId: F.imgRef, offset: { x: 0, y: 0 }, opacity: 255 };
    },
  ],
  [
    'LINK_TARGET_MISSING',
    'error',
    (d) => {
      const fx = d.layers[2];
      const spark = fx?.kind === 'group' ? fx.children[0] : undefined;
      if (spark?.kind === 'pixel') spark.cels[F.f2] = { linkTo: F.f0 };
    },
  ],
  [
    'LINK_TO_LINK',
    'error',
    (d) => {
      const l = d.layers[0];
      if (l?.kind === 'pixel') l.cels[F.g0] = { linkTo: F.f1 };
    },
  ],
  [
    'LINK_SELF',
    'error',
    (d) => {
      const l = d.layers[0];
      if (l?.kind === 'pixel') l.cels[F.f1] = { linkTo: F.f1 };
    },
  ],
  [
    'ACTIVE_PALETTE_MISSING',
    'error',
    (d) => {
      d.activePaletteId = 'pal_ghost' as never;
    },
  ],
  [
    'SKIN_PALETTE_MISSING',
    'error',
    (d) => {
      d.skins.push({ id: 'skn_one' as never, name: 'team', paletteId: 'pal_ghost' as never });
    },
  ],
  [
    'SKIN_NAME_DUPLICATE',
    'error',
    (d) => {
      d.skins.push(
        { id: 'skn_one' as never, name: 'team', remap: [[1, 0]] },
        { id: 'skn_two' as never, name: 'team', remap: [[1, 0]] },
      );
    },
  ],
  [
    'SKIN_INDEX_RANGE',
    'error',
    (d) => {
      d.skins.push({ id: 'skn_one' as never, name: 'team', remap: [[5, 1]] });
    },
  ],
  [
    'RAMP_NAME_DUPLICATE',
    'error',
    (d) => {
      d.palettes[0]?.ramps.push({ name: 'skin', indices: [1] }, { name: 'skin', indices: [1] });
    },
  ],
  [
    'RAMP_INDEX_RANGE',
    'error',
    (d) => {
      d.palettes[0]?.ramps.push({ name: 'skin', indices: [9] });
    },
  ],
  [
    'MARKER_DEF_DUPLICATE',
    'error',
    (d) => {
      d.markerDefs.push({ name: 'hand_r' });
    },
  ],
  [
    'EVENT_DEF_DUPLICATE',
    'error',
    (d) => {
      d.eventDefs.push({ name: 'step' });
    },
  ],
  [
    'LAYER_NAME_DUPLICATE',
    'warning',
    (d) => {
      const l = d.layers[3];
      if (l) l.name = 'body';
    },
  ],
  [
    'IMAGE_MISSING',
    'error',
    (_d, images) => {
      images.splice(
        images.findIndex(([id]) => id === F.imgSpark),
        1,
      );
    },
  ],
  [
    'IMAGE_ORPHAN',
    'warning',
    (_d, images) => {
      images.push([ghost.image, new TiledImage(2, 2)]);
    },
  ],
  [
    'IMAGE_KIND_MISMATCH',
    'warning',
    (_d, images) => {
      images[0] = [F.imgBody0, new IndexedImage(2, 2)];
    },
  ],
  [
    'INDEX_OUT_OF_RANGE',
    'error',
    (d, images) => {
      toIndexed(d, images, (img) => {
        img.set(0, 0, 9);
      });
    },
  ],
  [
    'TRANSPARENT_INDEX_OPAQUE',
    'error',
    (d, images) => {
      toIndexed(d, images, () => undefined);
      const [id, old] = images[0] as [ImageId, StoredImage];
      images[0] = [id, new IndexedImage(old.width, old.height, 1)];
    },
  ],
  [
    'PALETTE_LOCK_COLOR',
    'warning',
    (d, images) => {
      d.meta.paletteLocked = true;
      const img = new TiledImage(4, 4);
      img.set(0, 0, [1, 2, 3, 255]);
      images[0] = [F.imgBody0, img];
    },
  ],
  [
    'ANIM_KEY_DUPLICATE',
    'error',
    (d) => {
      const a = idle(d);
      a.group = 'run';
      a.direction = 'side';
    },
  ],
  [
    'MIRROR_SOURCE_MISSING',
    'error',
    (d) => {
      mirror(d).mirrorOf = 'anm_ghost' as never;
    },
  ],
  [
    'MIRROR_OF_MIRROR',
    'error',
    (d) => {
      mirror(d).mirrorOf = F.runL;
    },
  ],
  [
    'MIRROR_GROUP_MISMATCH',
    'error',
    (d) => {
      mirror(d).group = 'walk';
    },
  ],
];

describe('validate()', () => {
  it('reports nothing for the clean fixture, on a store, a snapshot and a transaction', () => {
    const store = richStore();
    expect(validate(store)).toEqual([]);
    expect(validate(store.snapshot())).toEqual([]);
    const tx = store.begin('x');
    expect(validate(tx)).toEqual([]);
    tx.cancel();
  });

  it('has a failing fixture for every code', () => {
    expect(CASES.map(([c]) => c).sort()).toEqual([...FINDING_CODES].sort());
  });

  for (const [code, severity, mutate] of CASES) {
    it(`${code} (${severity})`, () => {
      const found = findings(mutate);
      const hit = found.find((f) => f.code === code);
      expect(hit, JSON.stringify(found)).toBeDefined();
      expect(hit?.severity).toBe(severity);
      expect(hit?.path.length).toBeGreaterThan(0);
      expect(hit?.message.length).toBeGreaterThan(0);
      if (code === 'SCHEMA') expect(found.every((f) => f.code === 'SCHEMA')).toBe(true);
    });
  }

  it('flags only the last generated id when the counter is one behind (I4 precision)', () => {
    const next = richDoc().meta.ids.next;
    const found = findings((d) => {
      d.meta.ids.next = next - 1;
    });
    expect(found.map((f) => f.code)).toEqual(['ID_COUNTER_BEHIND']);
    expect(found[0]?.path).toEqual(['animations', 1, 'overrides', 0, 'id']);
  });

  it('accepts an erase mask whatever its index values, and a non-zero transparent index', () => {
    const found = findings((d, images) => {
      toIndexed(d, images, () => undefined);
      const mask = new IndexedImage(4, 4);
      mask.set(0, 0, 200);
      images[7] = [F.imgErase1, mask];
      const pal = d.palettes[0];
      if (pal)
        pal.colors = [
          [255, 0, 0, 255],
          [0, 0, 0, 0],
          [0, 255, 0, 255],
          [0, 0, 255, 255],
        ];
      images.forEach((e, i) => {
        if (i !== 7) images[i] = [e[0], new IndexedImage(e[1].width, e[1].height, 1)];
      });
    });
    expect(found.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('reports a missing active palette in an indexed document', () => {
    const found = findings((d, images) => {
      toIndexed(d, images, () => undefined);
      delete d.activePaletteId;
    });
    expect(found.map((f) => f.code)).toContain('ACTIVE_PALETTE_MISSING');
  });

  it('flags an RGBA mask-less palette-locked document only as warnings', () => {
    const found = findings((d) => {
      d.meta.paletteLocked = true;
    });
    expect(found).toEqual([]);
  });

  it('does not report valid cross-animation links or mirror overrides on the source frame', () => {
    expect(validate(richStore())).toEqual([]);
  });
});
