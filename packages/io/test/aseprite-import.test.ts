import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DocumentStore,
  applySkeletonTemplate,
  bindParts,
  canonicalJson,
  documentHash,
  renderFrame,
  setPivot,
  validate,
} from '@pixel-forge/core';
import { decodePng } from '@pixel-forge/png';
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { humanoidSide } from '@pixel-forge/rig';
import { SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type { BoneId, Cel, Document, ImageId, Layer, PixelLayer } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import {
  createDocumentFromAseprite,
  importAsepriteTx,
  reimportAseprite,
  reimportAsepriteTx,
} from '../src/index.js';
import { file, frame, layer, linkCel, newPalette, tagsChunk, zCel } from './aseprite-builder.js';
import { need } from './helpers.js';

const dir = fileURLToPath(new URL('../../../fixtures/aseprite/', import.meta.url));
const load = (name: string): Uint8Array => new Uint8Array(readFileSync(`${dir}${name}.aseprite`));
interface Expected {
  frames: { duration: number }[];
  meta: { frameTags: { name: string; from: number; to: number; direction: string }[] };
}
const expectedOf = (name: string): Expected =>
  JSON.parse(readFileSync(`${dir}${name}.expected.json`, 'utf8')) as Expected;
const oracle = (fixture: string, layerName: string, f: number): Uint8Array =>
  decodePng(
    new Uint8Array(
      readFileSync(`${dir}${fixture}/${layerName.replace(/[:#@]/g, '~')}-${String(f)}.png`),
    ),
  ).data;

function emptyDoc(w: number, h: number, colorMode: 'rgba' | 'indexed' = 'rgba'): DocumentStore {
  const gen = createIdGenerator({ seed: 7, next: 0 });
  const doc: Document = {
    meta: {
      id: gen.next('doc'),
      name: 'target',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w, h },
      origin: { x: Math.floor(w / 2), y: h - 1 },
      pixelsPerUnit: 16,
      colorMode,
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
  return new DocumentStore(doc);
}

/** An empty document with the humanoid side skeleton (bones `upper_arm_r`, `hand_r`..., view `side`). */
function rigDoc(w: number, h: number): DocumentStore {
  const store = emptyDoc(w, h);
  store.transact('rig', (tx) => {
    applySkeletonTemplate(
      tx,
      humanoidSide({ height: Math.max(8, h - 1), origin: { x: Math.floor(w / 2), y: h - 1 } }),
    );
  });
  return store;
}

const bodyLayer = (store: DocumentStore, name = 'body'): PixelLayer =>
  need(
    flatLayers(store.doc.layers as Layer[]).find((l) => l.name === name && l.kind === 'pixel'),
  ) as PixelLayer;

function flatLayers(layers: readonly Layer[]): Layer[] {
  return layers.flatMap((l) => (l.kind === 'group' ? [l, ...flatLayers(l.children)] : [l]));
}

const authored = (store: DocumentStore, group: string) => {
  const a = store.doc.animations.find((x) => x.group === group);
  if (!a || !('frames' in a)) throw new Error(`no animation ${group}`);
  return a;
};
const errors = (store: DocumentStore) => validate(store).filter((f) => f.severity === 'error');

/** SHA-256 of the rig plus every key of every frame: the "rig data". */
function rigHash(store: DocumentStore): string {
  const keys = store.doc.animations.map((a) =>
    'frames' in a ? a.frames.map((f) => ({ id: f.id, b: f.boneKeys, p: f.partKeys })) : null,
  );
  return createHash('sha256')
    .update(canonicalJson({ rig: store.doc.rig ?? null, keys }))
    .digest('hex');
}

const solid = (w: number, h: number, c: readonly [number, number, number, number]): number[] =>
  Array.from({ length: w * h }, () => c).flat();

// ---- synthetic edited files -----------------------------------------------------------------------------

interface Spec {
  /** Frames of the `run` tag (frames 0..runLen-1); `idle` follows. */
  runLen: number;
  bodyColor?: readonly [number, number, number, number];
  partColor?: readonly [number, number, number, number];
  /** Part cel box `[x, y, w, h]`. */
  partBox?: readonly [number, number, number, number];
  extraVariant?: boolean;
  durations?: number[];
}

/** 8x8 file: layers `body`, `part:upper_arm_r` (identical cel in every frame), optional `part:upper_arm_r@alt`; tags `run`, `idle`. */
function synth(s: Spec): Uint8Array {
  const n = s.runLen + 1;
  const body = s.bodyColor ?? [200, 0, 0, 255];
  const part = s.partColor ?? [0, 200, 0, 255];
  const [px, py, pw, ph] = s.partBox ?? [2, 2, 3, 3];
  const frames: number[][] = [];
  for (let f = 0; f < n; f++) {
    const chunks: number[][] = [];
    if (f === 0) {
      chunks.push(layer('body'), layer('part:upper_arm_r'));
      if (s.extraVariant === true) chunks.push(layer('part:upper_arm_r@alt'));
      chunks.push(
        tagsChunk([
          { name: 'run', from: 0, to: s.runLen - 1 },
          { name: 'idle', from: s.runLen, to: s.runLen },
        ]),
      );
    }
    // the body changes per frame so no two cels are equal
    chunks.push(zCel(2, 2, solid(2, 2, [body[0] + f, body[1], body[2], body[3]]), { layer: 0 }));
    chunks.push(zCel(pw, ph, solid(pw, ph, part), { layer: 1, x: px, y: py }));
    if (s.extraVariant === true)
      chunks.push(zCel(2, 2, solid(2, 2, [0, 0, 200, 255]), { layer: 2, x: 5, y: 5 }));
    frames.push(frame(chunks, { duration: s.durations?.[f] ?? 100 }));
  }
  return file(frames, { width: 8, height: 8 });
}

/** A document with the rig, `synth` imported, plus authored keys and a pivot on the matched items. */
function authoredDoc() {
  const store = rigDoc(8, 8);
  const report = store.transact('import', (tx) => importAsepriteTx(tx, synth({ runLen: 3 })));
  const rig = need(store.doc.rig);
  const part = need(rig.parts[0]);
  const variant = need(part.variants[0]);
  store.transact('author', (tx) => {
    setPivot(tx, part.id, variant.id, { x: 3, y: 4 });
    tx.update((d) => {
      const run = d.animations.find((a) => a.group === 'run');
      if (!run || !('frames' in run)) return;
      const shoulder = need(d.rig?.bones.find((b) => b.name === 'upper_arm_r')).id;
      const f1 = need(run.frames[1]);
      f1.boneKeys[shoulder] = { angle: 30 };
      f1.partKeys[part.id] = { z: 5 };
      f1.markers.hand = { x: 1, y: 1 };
      f1.events.push('step');
    });
  });
  return { store, report, part, variant };
}

describe('mapping: tags and untagged frames', () => {
  it('each tag becomes an animation, untagged frames go to default (oracle: Aseprite CLI JSON)', () => {
    const { store, report } = createDocumentFromAseprite(load('tags_overlap'));
    const exp = expectedOf('tags_overlap');
    expect(store.doc.animations.map((a) => a.group)).toEqual(['run', 'turn', 'default']);
    for (const t of exp.meta.frameTags) {
      const a = authored(store, t.name);
      expect(a.frames.map((f) => f.durationMs)).toEqual(
        exp.frames.slice(t.from, t.to + 1).map((f) => f.duration),
      );
      expect(a.loop).toBe(t.direction === 'pingpong' ? 'pingpong' : 'loop');
      // pixels equal Aseprite's per-frame output
      a.frames.forEach((_, i) => {
        const got = renderFrame(store, { group: t.name }, i).toRGBA().data;
        expect(Array.from(got)).toEqual(Array.from(oracle('tags_overlap', 'body', t.from + i)));
      });
    }
    const def = authored(store, 'default');
    expect(def.frames).toHaveLength(1);
    expect(def.frames[0]?.durationMs).toBe(exp.frames[6]?.duration);
    expect(Array.from(renderFrame(store, { group: 'default' }, 0).toRGBA().data)).toEqual(
      Array.from(oracle('tags_overlap', 'body', 6)),
    );
    expect(errors(store)).toEqual([]);
    expect(report.animations.map((a) => [a.group, a.tag, a.frames])).toEqual([
      ['run', 'run', 4],
      ['turn', 'turn', 3],
      ['default', undefined, 1],
    ]);
  });

  it('has no default animation when every frame is tagged; reverse and pingpong_reverse reverse the frames', () => {
    const bytes = file(
      [
        frame(
          [
            layer('body'),
            tagsChunk([
              { name: 'back', from: 0, to: 1, dir: 1 },
              { name: 'pp', from: 2, to: 2, dir: 3 },
            ]),
            zCel(1, 1, [1, 1, 1, 255]),
          ],
          { duration: 10 },
        ),
        frame([zCel(1, 1, [2, 2, 2, 255])], { duration: 20 }),
        frame([zCel(1, 1, [3, 3, 3, 255])], { duration: 30 }),
      ],
      { width: 2, height: 2 },
    );
    const { store } = createDocumentFromAseprite(bytes);
    expect(store.doc.animations.map((a) => a.group)).toEqual(['back', 'pp']);
    expect(authored(store, 'back').frames.map((f) => f.durationMs)).toEqual([20, 10]);
    expect(authored(store, 'pp').loop).toBe('pingpong');
  });
});

describe('mapping: overlapping tags', () => {
  it('a frame in two tags appears in both; the later occurrence links to the first (one hop)', () => {
    const { store } = createDocumentFromAseprite(load('tags_overlap'));
    const run = authored(store, 'run');
    const turn = authored(store, 'turn');
    // Aseprite frame 3 is run[3] (first occurrence) and turn[0]
    const cels = bodyLayer(store).cels as Record<string, Cel>;
    const owner = need(cels[need(run.frames[3]).id]);
    expect('imageId' in owner).toBe(true);
    expect(cels[need(turn.frames[0]).id]).toEqual({ linkTo: need(run.frames[3]).id });
    // every other frame owns its pixels: 7 drawings in total
    expect(Object.values(cels).filter((c) => 'imageId' in c)).toHaveLength(7);
    expect(errors(store)).toEqual([]);
    // both occurrences render identically
    expect(Array.from(renderFrame(store, { group: 'turn' }, 0).toRGBA().data)).toEqual(
      Array.from(renderFrame(store, { group: 'run' }, 3).toRGBA().data),
    );
  });
});

describe('mapping: Aseprite linked cels', () => {
  it('resolve to their source cel (oracle: per-frame PNGs)', () => {
    const { store } = createDocumentFromAseprite(load('linked_cels'));
    const def = authored(store, 'default');
    const ids = def.frames.map((f) => f.id);
    const cels = bodyLayer(store).cels as Record<string, Cel>;
    expect(cels[need(ids[1])]).toEqual({ linkTo: ids[0] });
    expect(cels[need(ids[3])]).toEqual({ linkTo: ids[0] });
    expect('imageId' in need(cels[need(ids[2])])).toBe(true);
    def.frames.forEach((_, i) => {
      expect(Array.from(renderFrame(store, { group: 'default' }, i).toRGBA().data)).toEqual(
        Array.from(oracle('linked_cels', 'body', i)),
      );
    });
    expect(errors(store)).toEqual([]);
  });

  it('a linked cel whose source frame is in a later tag still links to the source, never to a link', () => {
    // frames 0..2; frame 1 is a link to frame 0; tags A = 1..2, B = 0..1 (frame 1 is in both)
    const bytes = file(
      [
        frame([
          layer('body'),
          tagsChunk([
            { name: 'a', from: 1, to: 2 },
            { name: 'b', from: 0, to: 1 },
          ]),
          zCel(1, 1, [9, 0, 0, 255]),
        ]),
        frame([linkCel(0)]),
        frame([zCel(1, 1, [0, 9, 0, 255])]),
      ],
      { width: 2, height: 2 },
    );
    const { store } = createDocumentFromAseprite(bytes);
    const a = authored(store, 'a');
    const b = authored(store, 'b');
    const cels = bodyLayer(store).cels as Record<string, Cel>;
    expect(cels[need(a.frames[0]).id]).toEqual({ linkTo: need(b.frames[0]).id });
    expect(cels[need(b.frames[1]).id]).toEqual({ linkTo: need(b.frames[0]).id });
    expect(errors(store)).toEqual([]);
  });
});

describe('mapping: part layers', () => {
  it('part: layers become parts and variants when the rig has the bone and view', () => {
    const store = rigDoc(16, 16);
    const report = store.transact('import', (tx) => importAsepriteTx(tx, load('layers_parts')));
    const rig = need(store.doc.rig);
    const boneOf = (name: string): BoneId => need(rig.bones.find((b) => b.name === name)).id;
    const names = rig.parts.map((p) => rig.bones.find((b) => b.id === p.boneId)?.name).sort();
    expect(names).toEqual(['hand_r', 'lower_arm_r', 'upper_arm_r']);
    const lower = need(rig.parts.find((p) => p.boneId === boneOf('lower_arm_r')));
    expect(need(lower.variants[0]).name).toBe('45');
    const hand = need(rig.parts.find((p) => p.boneId === boneOf('hand_r')));
    expect(need(rig.views.find((v) => v.id === need(hand.variants[0]).viewId)).name).toBe('side');
    const upper = need(rig.parts.find((p) => p.boneId === boneOf('upper_arm_r')));
    expect(need(upper.variants[0]).name).toBe('default');
    // the part layers keep their place in the group `arm`, named after the bone
    const arm = need(flatLayers(store.doc.layers as Layer[]).find((l) => l.name === 'arm'));
    expect(arm.kind === 'group' && arm.children.map((c) => [c.kind, c.name])).toEqual([
      ['part', 'upper_arm_r'],
      ['part', 'lower_arm_r'],
      ['part', 'hand_r'],
    ]);
    expect(
      need(flatLayers(store.doc.layers as Layer[]).find((l) => l.name === 'lower_arm_r')).opacity,
    ).toBe(128);
    // pixels: the variant image is the layer drawing on the canvas (oracle PNG of frame 0)
    const img = need(store.image(need(upper.variants[0]).imageId));
    expect(img).toBeInstanceOf(TiledImage);
    expect(Array.from((img as TiledImage).toRGBA().data)).toEqual(
      Array.from(oracle('layers_parts', 'part:upper_arm_r', 0)),
    );
    expect(report.parts.bound).toHaveLength(3);
    expect(report.parts.unbound).toEqual([]);
    expect(errors(store)).toEqual([]);
  });

  it('without a rig the part layers stay pixel layers and are reported with their raw names', () => {
    const { store, report } = createDocumentFromAseprite(load('layers_parts'));
    expect(report.parts.bound).toEqual([]);
    expect(report.parts.unbound.map((u) => [u.source, u.reason])).toEqual([
      ['part:upper_arm_r', 'unknown-bone'],
      ['part:lower_arm_r@45', 'unknown-bone'],
      ['part:hand_r#side', 'unknown-bone'],
    ]);
    // hidden layers are imported hidden and not exported
    const hidden = need(
      flatLayers(store.doc.layers as Layer[]).find((l) => l.name === 'hidden_guide'),
    );
    expect([hidden.visible, hidden.export]).toEqual([false, false]);
    // a later bindParts with the reported raw names finishes the job
    store.transact('rig', (tx) => {
      applySkeletonTemplate(tx, humanoidSide({ height: 15, origin: { x: 8, y: 15 } }));
    });
    const rawNames = Object.fromEntries(report.parts.unbound.map((u) => [u.layerId, u.source]));
    const bound = store.transact('bind', (tx) => bindParts(tx, { byOverlap: false, rawNames }));
    expect(bound.bound).toHaveLength(3);
  });
});

describe('mapping: palette', () => {
  it('becomes the active palette of a document that has none (indexed file, oracle: README)', () => {
    const { store, report } = createDocumentFromAseprite(load('indexed_palette'));
    expect(store.doc.meta.colorMode).toBe('indexed');
    const pal = need(store.doc.palettes[0]);
    expect(pal.colors).toHaveLength(16);
    expect(pal.colors[0]?.[3]).toBe(0); // entry 0 is fully transparent
    expect(store.doc.activePaletteId).toBe(pal.id);
    expect(report.palette).toEqual({
      id: pal.id,
      name: 'aseprite',
      action: 'active',
      isActive: true,
    });
    // the image uses index (x + y) mod 16 on the 8x8 canvas
    const cel = Object.values(bodyLayer(store).cels)[0];
    const img = store.image(
      need(cel && 'imageId' in cel ? cel.imageId : undefined),
    ) as IndexedImage;
    expect(img).toBeInstanceOf(IndexedImage);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) expect(img.get(x, y)).toBe((x + y) % 16);
    expect(errors(store)).toEqual([]);
  });

  it('is added (not active) and reported when the document already has an active palette', () => {
    const store = emptyDoc(16, 16);
    store.transact('palette', (tx) => {
      const id = tx.newId('palette');
      tx.update((d) => {
        d.palettes.push({ id, name: 'mine', colors: [[1, 2, 3, 255]], ramps: [] });
        d.activePaletteId = id;
      });
    });
    const active = store.doc.activePaletteId;
    const report = store.transact('import', (tx) => importAsepriteTx(tx, load('layers_parts')));
    expect(store.doc.palettes).toHaveLength(2);
    expect(store.doc.activePaletteId).toBe(active);
    expect(report.palette).toMatchObject({ action: 'added', isActive: false });
    // importing the same palette again reuses it
    const again = reimportAseprite(store, load('layers_parts'));
    expect(again.palette).toMatchObject({ action: 'existing', isActive: false });
    expect(store.doc.palettes).toHaveLength(2);
  });
});

describe('re-import: matching by name', () => {
  it('layers are matched by name: ids kept, pixels replaced in the same image, others untouched', () => {
    const { store } = authoredDoc();
    store.transact('extra', (tx) => {
      const id = tx.newId('layer');
      tx.update((d) => {
        d.layers.push({
          kind: 'pixel',
          id,
          name: 'extra',
          visible: true,
          opacity: 255,
          export: true,
          cels: {},
        });
      });
    });
    const before = bodyLayer(store);
    const run0 = need(authored(store, 'run').frames[0]).id;
    const imageBefore = (need(before.cels[run0]) as { imageId: ImageId }).imageId;
    const layerCount = flatLayers(store.doc.layers as Layer[]).length;
    const report = reimportAseprite(store, synth({ runLen: 3, bodyColor: [10, 20, 30, 255] }));
    const after = bodyLayer(store);
    expect(after.id).toBe(before.id);
    const cel = need(after.cels[run0]) as { imageId: ImageId };
    expect(cel.imageId).toBe(imageBefore);
    expect(
      Array.from(
        need(store.image(cel.imageId) as TiledImage)
          .toRGBA()
          .data.slice(0, 4),
      ),
    ).toEqual([10, 20, 30, 255]);
    expect(flatLayers(store.doc.layers as Layer[])).toHaveLength(layerCount);
    expect(report.layersNotInSource).toEqual(['extra']);
    expect(report.layers.find((l) => l.name === 'body')?.action).toBe('matched');
    expect(errors(store)).toEqual([]);
  });

  it('parts are matched by name; a pixel edit of a part leaves the hash of the rig data unchanged', () => {
    const { store, part, variant } = authoredDoc();
    const hash = rigHash(store);
    const report = reimportAseprite(
      store,
      synth({ runLen: 3, partColor: [250, 250, 0, 255], partBox: [1, 3, 5, 2] }),
    );
    expect(rigHash(store)).toBe(hash);
    const p = need(store.doc.rig?.parts.find((x) => x.id === part.id));
    expect(need(p.variants[0]).id).toBe(variant.id);
    expect(need(p.variants[0]).imageId).toBe(variant.imageId);
    const img = need(store.image(variant.imageId) as TiledImage);
    expect(Array.from(img.get(1, 3))).toEqual([250, 250, 0, 255]);
    expect(Array.from(img.get(2, 2))).toEqual([0, 0, 0, 0]); // the old box is gone
    expect(report.parts.updated).toEqual([
      { partId: part.id, variantId: variant.id, source: 'part:upper_arm_r', inPlace: true },
    ]);
    expect(report.parts.bound).toEqual([]);
    expect(errors(store)).toEqual([]);
  });

  it('a part layer that is new in the file is bound as a new variant of the matched part', () => {
    const { store, part } = authoredDoc();
    const hash = rigHash(store);
    const report = reimportAseprite(store, synth({ runLen: 3, extraVariant: true }));
    const p = need(store.doc.rig?.parts.find((x) => x.id === part.id));
    expect(p.variants.map((v) => v.name)).toEqual(['default', 'alt']);
    expect(report.parts.bound.map((b) => [b.partId, b.merged])).toEqual([[part.id, true]]);
    expect(rigHash(store)).not.toBe(hash); // a variant was added
    expect(need(p.variants[0]).pivot).toEqual({ x: 3, y: 4 }); // the matched variant is untouched
    expect(errors(store)).toEqual([]);
  });

  it('re-importing an unchanged file changes nothing', () => {
    const { store } = authoredDoc();
    const hash = documentHash(store);
    const version = store.version;
    const report = reimportAseprite(store, synth({ runLen: 3 }));
    expect(documentHash(store)).toBe(hash);
    expect(store.version).toBe(version);
    expect(report.addedFrames).toEqual([]);
    expect(report.removedFrames).toEqual([]);
    expect(report.images.created).toBe(0);
    expect(report.images.rewritten).toBe(0);
  });
});

describe('re-import: matching frames by (tag, index)', () => {
  it('matched frames keep their ids and keys; bindings, pivots and keys of matched items are kept', () => {
    const { store, part, variant } = authoredDoc();
    const run = authored(store, 'run');
    const ids = run.frames.map((f) => f.id);
    const key = run.frames[1];
    const rigBefore = canonicalJson(store.doc.rig ?? null);
    reimportAseprite(
      store,
      synth({ runLen: 3, durations: [40, 50, 60, 70], bodyColor: [1, 2, 3, 255] }),
    );
    const after = authored(store, 'run');
    expect(after.frames.map((f) => f.id)).toEqual(ids);
    expect(after.frames[1]).toMatchObject({
      boneKeys: key?.boneKeys,
      partKeys: { [part.id]: { z: 5 } },
      markers: { hand: { x: 1, y: 1 } },
      events: ['step'],
    });
    expect(after.frames.map((f) => f.durationMs)).toEqual([40, 50, 60]); // durations follow the file
    expect(canonicalJson(store.doc.rig ?? null)).toBe(rigBefore); // bindings and pivots
    expect(need(store.doc.rig?.parts[0]?.variants[0]).pivot).toEqual({ x: 3, y: 4 });
    expect(need(store.doc.rig?.parts[0]?.variants[0]).id).toBe(variant.id);
  });

  it('added frames are appended without keys and reported', () => {
    const { store } = authoredDoc();
    const ids = authored(store, 'run').frames.map((f) => f.id);
    const report = reimportAseprite(store, synth({ runLen: 5 }));
    const run = authored(store, 'run');
    expect(run.frames).toHaveLength(5);
    expect(run.frames.slice(0, 3).map((f) => f.id)).toEqual(ids);
    for (const f of run.frames.slice(3)) {
      expect(f.boneKeys).toEqual({});
      expect(f.partKeys).toEqual({});
      expect(f.markers).toEqual({});
      expect(f.events).toEqual([]);
    }
    expect(report.addedFrames).toEqual([
      { animation: 'run', index: 3, frameId: need(run.frames[3]).id },
      { animation: 'run', index: 4, frameId: need(run.frames[4]).id },
    ]);
    // the new frames got cels (body is a plain layer)
    const cels = bodyLayer(store).cels as Record<string, Cel>;
    expect(need(cels[need(run.frames[4]).id])).toBeDefined();
    expect(errors(store)).toEqual([]);
  });

  it('removed frames drop their keys, overrides and cels, and appear in the report', () => {
    const { store, part } = authoredDoc();
    const run = authored(store, 'run');
    const gone = need(run.frames[2]).id;
    const kept = need(run.frames[0]).id;
    const goneCel = need((bodyLayer(store).cels as Record<string, Cel>)[gone]) as {
      imageId: ImageId;
    };
    store.transact('author more', (tx) => {
      const shoulder = need(tx.doc.rig?.bones.find((b) => b.name === 'upper_arm_r')).id;
      const img = tx.createImage(new TiledImage(2, 2));
      const hash = 'a'.repeat(64);
      tx.update((d) => {
        const a = d.animations.find((x) => x.group === 'run');
        if (!a || !('frames' in a)) return;
        const f2 = need(a.frames[2]);
        f2.boneKeys[shoulder] = { angle: 10 };
        f2.boneKeys[need(d.rig?.bones.find((b) => b.name === 'hand_r')).id] = { angle: 5 };
        f2.partKeys[part.id] = { visible: false };
        a.overrides.push({
          id: tx.newId('override'),
          frameId: gone,
          target: 'final',
          anchor: { x: 0, y: 0 },
          set: img,
          baseHash: hash,
        });
        a.overrides.push({
          id: tx.newId('override'),
          frameId: kept,
          target: 'final',
          anchor: { x: 0, y: 0 },
          set: img,
          baseHash: hash,
        });
      });
    });
    const report = reimportAseprite(store, synth({ runLen: 2 }));
    const after = authored(store, 'run');
    expect(after.frames).toHaveLength(2);
    expect(after.frames.map((f) => f.id)).not.toContain(gone);
    expect(after.overrides.map((o) => o.frameId)).toEqual([kept]);
    expect(report.removedFrames).toEqual([
      { animation: 'run', index: 2, frameId: gone, boneKeys: 2, partKeys: 1, overrides: 1 },
    ]);
    expect(report.addedFrames).toEqual([]);
    expect((bodyLayer(store).cels as Record<string, Cel>)[gone]).toBeUndefined();
    expect(store.image(goneCel.imageId)).toBeUndefined(); // the orphaned image is deleted
    expect(report.images.deleted).toBe(1);
    expect(errors(store)).toEqual([]);
    // undo restores the frame, keys, override and image
    store.undo();
    expect(authored(store, 'run').frames).toHaveLength(3);
    expect(store.image(goneCel.imageId)).toBeDefined();
  });

  it('reports animations and tags that appear or vanish, and rejects a different canvas', () => {
    const { store } = authoredDoc();
    const bytes = file(
      [
        frame([
          layer('body'),
          tagsChunk([{ name: 'fresh', from: 0, to: 0 }]),
          zCel(1, 1, [5, 5, 5, 255]),
        ]),
      ],
      { width: 8, height: 8 },
    );
    const report = reimportAseprite(store, bytes);
    expect(report.animationsNotInSource.sort()).toEqual(['idle', 'run']);
    expect(report.animations).toMatchObject([{ group: 'fresh', action: 'created' }]);
    expect(store.doc.animations.map((a) => a.group)).toContain('run');
    expect(() =>
      store.transact('bad', (tx) =>
        reimportAsepriteTx(tx, file([frame([layer('body')])], { width: 4, height: 4 })),
      ),
    ).toThrow(/canvas/);
  });
});

describe('re-import: edge cases', () => {
  it('links from layers outside the file are materialised when their target frame is removed', () => {
    const { store } = authoredDoc();
    const run = authored(store, 'run');
    const [f0, , f2] = run.frames.map((f) => f.id);
    store.transact('extra layer', (tx) => {
      const id = tx.newId('layer');
      const img = tx.createImage(
        TiledImage.fromRGBA({ width: 1, height: 1, data: Uint8Array.of(9, 9, 9, 255) }),
      );
      tx.update((d) => {
        d.layers.push({
          kind: 'pixel',
          id,
          name: 'extra',
          visible: true,
          opacity: 255,
          export: true,
          cels: {
            [need(f2)]: { imageId: img, offset: { x: 0, y: 0 }, opacity: 255 },
            [need(f0)]: { linkTo: need(f2) },
          },
        });
      });
    });
    reimportAseprite(store, synth({ runLen: 2 }));
    const extra = bodyLayer(store, 'extra');
    const cel = need(extra.cels[need(f0)]);
    expect('imageId' in cel).toBe(true);
    expect(extra.cels[need(f2)]).toBeUndefined();
    expect(errors(store)).toEqual([]);
  });

  it('a name that belongs to a layer of another kind is skipped and reported', () => {
    const store = emptyDoc(8, 8);
    store.transact('group', (tx) => {
      const id = tx.newId('layer');
      tx.update((d) => {
        d.layers.push({
          kind: 'group',
          id,
          name: 'body',
          visible: true,
          opacity: 255,
          export: true,
          children: [],
        });
      });
    });
    const report = reimportAseprite(store, synth({ runLen: 3 }));
    expect(report.skippedLayers.map((s) => s.name)).toEqual(['body']);
    expect(errors(store)).toEqual([]);
  });

  it('part layers whose drawing differs between frames use the first frame, with a warning', () => {
    const { report } = createDocumentFromAseprite(load('layers_parts'));
    expect(report.warnings.filter((w) => w.includes('differs between frames'))).toHaveLength(3);
  });
});

describe('colour modes', () => {
  it('an indexed file goes into an RGBA document as RGBA pixels (oracle PNG)', () => {
    const store = emptyDoc(8, 8);
    store.transact('import', (tx) => importAsepriteTx(tx, load('indexed_palette')));
    expect(Array.from(renderFrame(store, { group: 'default' }, 0).toRGBA().data)).toEqual(
      Array.from(oracle('indexed_palette', 'body', 0)),
    );
    expect(store.doc.activePaletteId).toBeDefined();
  });

  it('an RGBA file cannot go into an indexed document; the canvas must match', () => {
    const idx = createDocumentFromAseprite(load('indexed_palette')).store;
    expect(() => idx.transact('bad', (tx) => importAsepriteTx(tx, load('tags_overlap')))).toThrow(
      /indexed/,
    );
    const rgba = emptyDoc(4, 4);
    expect(() => rgba.transact('bad', (tx) => importAsepriteTx(tx, load('tags_overlap')))).toThrow(
      /canvas/,
    );
  });

  it('re-importing an indexed file rewrites indexed images in place', () => {
    const { store } = createDocumentFromAseprite(load('indexed_palette'));
    const hash = documentHash(store);
    const report = reimportAseprite(store, load('indexed_palette'));
    expect(documentHash(store)).toBe(hash);
    expect(report.palette?.action).toBe('existing');
    expect(report.images.unchanged).toBe(1);
  });
});

describe('import into an existing document', () => {
  it('suffixes clashing layer names and refuses an existing animation', () => {
    const store = emptyDoc(8, 8);
    store.transact('one', (tx) => importAsepriteTx(tx, synth({ runLen: 3 })));
    expect(() => store.transact('two', (tx) => importAsepriteTx(tx, synth({ runLen: 3 })))).toThrow(
      /already exists/,
    );
    const bytes = file([frame([layer('body'), zCel(1, 1, [5, 5, 5, 255])])], {
      width: 8,
      height: 8,
    });
    const report = store.transact('three', (tx) => importAsepriteTx(tx, bytes));
    expect(report.renamed).toEqual([{ kind: 'layer', from: 'body', to: 'body_2' }]);
    expect(errors(store)).toEqual([]);
  });

  it('is deterministic: the same bytes give the same document', () => {
    const a = createDocumentFromAseprite(load('tags_overlap')).store;
    const b = createDocumentFromAseprite(load('tags_overlap')).store;
    expect(documentHash(a)).toBe(documentHash(b));
  });

  it('reports tilemap layers as skipped, renames invalid layer and tag names', () => {
    const bytes = file(
      [
        frame([
          layer('Hero Body!'),
          layer('tiles', { type: 2 }),
          tagsChunk([{ name: 'Walk Cycle', from: 0, to: 0 }]),
          zCel(1, 1, [1, 2, 3, 255]),
          newPalette(2, 0, [{ rgba: [0, 0, 0, 255] }, { rgba: [255, 255, 255, 255] }]),
        ]),
      ],
      { width: 2, height: 2 },
    );
    const { store, report } = createDocumentFromAseprite(bytes);
    expect(report.skippedLayers.map((s) => s.name)).toEqual(['tiles']);
    expect(report.renamed).toEqual([
      { kind: 'layer', from: 'Hero Body!', to: 'hero_body_' },
      { kind: 'animation', from: 'Walk Cycle', to: 'walk_cycle' },
    ]);
    expect(store.doc.layers.map((l) => l.name)).toEqual(['hero_body_']);
    expect(store.doc.animations.map((a) => a.group)).toEqual(['walk_cycle']);
    expect(errors(store)).toEqual([]);
  });
});
