/**
 * The T2.1 oracle: random sequences of structural edits and image writes (tile-crossing writes,
 * composites, image create/delete, id allocation), interleaved with undo, redo, cancel and no-op
 * transactions. A model keeps the hash of every state on the linear history; undo and redo must land
 * exactly on those hashes, and the run must be reproducible from its seed.
 */
import { IndexedImage, TiledImage, composite } from '@pixel-forge/raster';
import type { Rgba } from '@pixel-forge/raster';
import { Document } from '@pixel-forge/schema';
import type { ImageId, LayerId } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { DocumentStore, documentHash } from '../src/index.js';
import type { ChangeEvent, DocumentSnapshot, StoredImage, Transaction } from '../src/index.js';
import { authored, blankFrame, int, makeDoc, makeImages, rng } from './helpers.js';

type R = () => number;

const NAMES = ['hand_r', 'hand_l', 'foot', 'tip'];

function pick<T>(r: R, xs: readonly T[]): T | undefined {
  return xs.length === 0 ? undefined : xs[int(r, xs.length)];
}

function color(r: R): Rgba {
  return r() < 0.15 ? [0, 0, 0, 0] : [int(r, 256), int(r, 256), int(r, 256), 1 + int(r, 255)];
}

function paint(r: R, img: StoredImage): void {
  const mode = int(r, 4);
  if (img instanceof IndexedImage) {
    for (let i = 0; i < 1 + int(r, 20); i++)
      img.set(int(r, img.width), int(r, img.height), int(r, 4) * 85);
    return;
  }
  if (mode === 0) {
    for (let i = 0; i < 1 + int(r, 30); i++)
      img.set(int(r, img.width), int(r, img.height), color(r));
  } else if (mode === 1) {
    // A rectangle that usually crosses tile boundaries (TILE_SIZE = 16).
    const x0 = int(r, img.width);
    const y0 = int(r, img.height);
    const c = color(r);
    for (let y = y0; y < Math.min(img.height, y0 + 1 + int(r, 20)); y++) {
      for (let x = x0; x < Math.min(img.width, x0 + 1 + int(r, 20)); x++) img.set(x, y, c);
    }
  } else if (mode === 2) {
    const src = new TiledImage(1 + int(r, 20), 1 + int(r, 20));
    for (let i = 0; i < 10; i++) src.set(int(r, src.width), int(r, src.height), color(r));
    composite(img, src, {
      x: int(r, img.width) - 4,
      y: int(r, img.height) - 4,
      opacity: int(r, 256),
    });
  } else if (r() < 0.3) {
    img.clear();
  } else {
    img.set(0, 0, img.get(0, 0)); // a no-op write
  }
}

/** One random edit inside `tx`. Keeps the document schema-valid. */
function randomEdit(r: R, tx: Transaction): void {
  const choice = int(r, 12);
  switch (choice) {
    case 0:
      tx.update((d) => {
        const f = pick(r, authored(d).frames);
        if (f) f.durationMs = 1 + int(r, 500);
      });
      return;
    case 1: {
      tx.update((d) => {
        const frames = authored(d).frames;
        frames.splice(int(r, frames.length + 1), 0, blankFrame(tx.newId('frame'), 1 + int(r, 300)));
      });
      return;
    }
    case 2:
      tx.update((d) => {
        const frames = authored(d).frames;
        if (frames.length < 2) return;
        const [gone] = frames.splice(int(r, frames.length), 1);
        if (gone === undefined) return;
        for (const layer of d.layers) {
          const all = layer.kind === 'group' ? layer.children : [layer];
          for (const l of all) {
            if (l.kind !== 'pixel') continue;
            Reflect.deleteProperty(l.cels, gone.id);
            for (const [k, cel] of Object.entries(l.cels)) {
              if ('linkTo' in cel && cel.linkTo === gone.id) Reflect.deleteProperty(l.cels, k);
            }
          }
        }
      });
      return;
    case 3:
      tx.update((d) => {
        const frames = authored(d).frames;
        const i = int(r, frames.length);
        const j = int(r, frames.length);
        const a = frames[i];
        const b = frames[j];
        if (a && b) {
          frames[i] = b;
          frames[j] = a;
        }
      });
      return;
    case 4:
      tx.update((d) => {
        const f = pick(r, authored(d).frames);
        const name = pick(r, NAMES) ?? 'tip';
        if (!f) return;
        if (r() < 0.3) Reflect.deleteProperty(f.markers, name);
        else f.markers[name] = { x: int(r, 40), y: int(r, 36) };
      });
      return;
    case 5: {
      const defs = tx.doc.eventDefs;
      if (defs.length > 0 && r() < 0.4) tx.remove(['eventDefs', int(r, defs.length)]);
      else tx.insert(['eventDefs', int(r, defs.length + 1)], { name: `ev${String(int(r, 9))}` });
      return;
    }
    case 6:
      tx.set(['meta', 'name'], r() < 0.3 ? tx.doc.meta.name : `doc ${String(int(r, 99))}`);
      return;
    case 7: {
      const id = pick(r, tx.imageIds());
      if (id)
        tx.writeImage(id, (img) => {
          paint(r, img);
        });
      return;
    }
    case 8: {
      // A new layer with a new image.
      const img =
        r() < 0.8 ? new TiledImage(1 + int(r, 40), 1 + int(r, 36)) : new IndexedImage(20, 20);
      paint(r, img);
      const imageId = tx.createImage(img);
      if (r() < 0.5)
        tx.writeImage(imageId, (w) => {
          paint(r, w);
        });
      tx.update((d) => {
        const frame = pick(r, authored(d).frames);
        if (!frame) return;
        d.layers.splice(int(r, d.layers.length + 1), 0, {
          kind: 'pixel',
          id: tx.newId('layer'),
          name: `l${String(int(r, 999))}`,
          visible: r() < 0.8,
          opacity: int(r, 256),
          export: true,
          cels: {
            [frame.id]: { imageId, offset: { x: int(r, 9) - 4, y: int(r, 9) - 4 }, opacity: 255 },
          },
        });
      });
      return;
    }
    case 9: {
      // Delete a top-level pixel layer and the images only it used (written first, sometimes).
      const layers = tx.doc.layers;
      const i = int(r, layers.length);
      const layer = layers[i];
      if (layer?.kind !== 'pixel') return;
      const imgs = new Set<ImageId>();
      for (const cel of Object.values(layer.cels)) if ('imageId' in cel) imgs.add(cel.imageId);
      tx.remove(['layers', i]);
      for (const id of [...imgs].sort()) {
        if (tx.image(id) === undefined) continue;
        if (r() < 0.3)
          tx.writeImage(id, (w) => {
            paint(r, w);
          });
        tx.deleteImage(id);
      }
      return;
    }
    case 10:
      tx.update((d) => {
        if (d.activePaletteId === undefined) {
          const p = d.palettes[0];
          if (p) d.activePaletteId = p.id;
        } else {
          delete d.activePaletteId;
        }
      });
      return;
    default:
      tx.update((d) => {
        const p = d.palettes[0];
        if (!p) return;
        if (r() < 0.5 && p.colors.length < 32)
          p.colors.push([int(r, 256), int(r, 256), int(r, 256), 255]);
        else {
          const c = pick(r, p.colors);
          if (c) c[int(r, 4)] = int(r, 256);
        }
      });
  }
}

interface RunResult {
  hashes: string[];
  final: string;
  ids: number;
  stats: {
    commits: number;
    noops: number;
    cancels: number;
    undos: number;
    redos: number;
    tiles: number;
  };
}

/** Runs `steps` random actions on a fresh store and checks every undo/redo against the model. */
function run(seed: number, steps: number): RunResult {
  const r = rng(seed);
  const store = new DocumentStore(makeDoc(), { images: makeImages(), memoryCap: Infinity });
  const events: ChangeEvent[] = [];
  store.subscribe((e) => events.push(e));
  const model: { hash: string; snap: DocumentSnapshot }[] = [
    { hash: documentHash(store), snap: store.snapshot() },
  ];
  let cursor = 0;
  const stats = { commits: 0, noops: 0, cancels: 0, undos: 0, redos: 0, tiles: 0 };
  const trace: string[] = [model[0]?.hash ?? ''];
  const check = () => {
    expect(documentHash(store)).toBe(model[cursor]?.hash);
    expect(events.at(-1)?.version ?? 0).toBe(store.version);
  };

  for (let step = 0; step < steps; step++) {
    const action = r();
    if (action < 0.6) {
      const before = {
        hash: documentHash(store),
        version: store.version,
        entries: store.historyInfo().entries.length,
      };
      const tx = store.begin(`step ${String(step)}`);
      for (let i = 0, n = 1 + int(r, 3); i < n; i++) randomEdit(r, tx);
      if (r() < 0.1) {
        tx.cancel();
        stats.cancels++;
        expect(documentHash(store)).toBe(before.hash);
        expect(store.version).toBe(before.version);
        continue;
      }
      const ev = tx.commit();
      if (ev === undefined) {
        stats.noops++;
        expect(documentHash(store)).toBe(before.hash);
        expect(store.version).toBe(before.version);
        expect(store.historyInfo().entries.length).toBe(before.entries);
        continue;
      }
      stats.commits++;
      stats.tiles += ev.patch.images.filter((p) => p.kind === 'tiles' && p.after.length > 1).length;
      model.length = cursor + 1;
      model.push({ hash: documentHash(store), snap: store.snapshot() });
      cursor++;
      expect(store.canRedo).toBe(false);
    } else if (action < 0.8) {
      const ev = store.undo();
      if (cursor === 0) expect(ev).toBeUndefined();
      else {
        expect(ev?.kind).toBe('undo');
        stats.undos++;
        cursor--;
      }
    } else {
      const ev = store.redo();
      if (cursor === model.length - 1) expect(ev).toBeUndefined();
      else {
        expect(ev?.kind).toBe('redo');
        stats.redos++;
        cursor++;
      }
    }
    check();
    trace.push(documentHash(store));
  }

  // Snapshots never change.
  for (const m of model) expect(documentHash(m.snap)).toBe(m.hash);
  // Redo to the end, then undo everything, then redo everything.
  while (store.redo()) cursor++;
  expect(cursor).toBe(model.length - 1);
  const final = documentHash(store);
  expect(final).toBe(model.at(-1)?.hash);
  while (store.undo()) {
    cursor--;
    check();
  }
  expect(documentHash(store)).toBe(model[0]?.hash);
  expect(store.doc).toEqual(makeDoc());
  while (store.redo()) {
    cursor++;
    check();
  }
  expect(documentHash(store)).toBe(final);
  expect(Document.safeParse(store.doc).success).toBe(true);
  // Every image referenced by the document exists.
  const referenced = new Set<string>();
  const walk = (layers: typeof store.doc.layers): void => {
    for (const l of layers) {
      if (l.kind === 'group') walk(l.children);
      else if (l.kind === 'pixel')
        for (const cel of Object.values(l.cels)) if ('imageId' in cel) referenced.add(cel.imageId);
    }
  };
  walk(store.doc.layers);
  for (const id of referenced) expect(store.image(id as ImageId)).toBeDefined();
  // Versions are consecutive.
  expect(events.map((e) => e.version)).toEqual(events.map((_, i) => i + 1));
  return { hashes: trace, final, ids: store.doc.meta.ids.next, stats };
}

describe('store property test (seeded)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`seed ${String(seed)}: undo all -> initial hash, redo all -> final hash, interleaved`, () => {
      const { stats } = run(seed, 160);
      // The run exercised every path: commits, no-ops, cancels, undo, redo, multi-tile writes.
      expect(stats.commits).toBeGreaterThan(40);
      expect(stats.undos).toBeGreaterThan(10);
      expect(stats.redos).toBeGreaterThan(5);
      expect(stats.cancels + stats.noops).toBeGreaterThan(0);
      expect(stats.tiles).toBeGreaterThan(0);
    });
  }

  it('is deterministic: the same seed gives the same states, hashes and ids', () => {
    const a = run(99, 120);
    const b = run(99, 120);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.final).toBe(a.final);
    expect(b.ids).toBe(a.ids);
    expect(run(100, 120).final).not.toBe(a.final);
  });

  it('a re-run after undo allocates the same ids and reaches the same hash', () => {
    const store = new DocumentStore(makeDoc(), { images: makeImages() });
    const op = (seed: number): LayerId[] => {
      const r = rng(seed);
      return store.transact('op', (tx) => {
        for (let i = 0; i < 4; i++) randomEdit(r, tx);
        randomEdit(rng(5), tx);
        const id = tx.newId('layer');
        tx.update((d) => {
          d.layers.push({
            kind: 'part',
            id,
            name: 'probe',
            visible: true,
            opacity: 255,
            export: true,
          });
        });
        return [id];
      });
    };
    const first = op(7);
    const h = documentHash(store);
    store.undo();
    expect(op(7)).toEqual(first);
    expect(documentHash(store)).toBe(h);
  });
});
