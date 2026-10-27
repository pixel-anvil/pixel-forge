import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { Document, makeId } from '@pixel-forge/schema';
import type { ImageId } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import {
  CoreError,
  DEFAULT_MEMORY_CAP,
  DocumentStore,
  documentHash,
  estimatePatchBytes,
} from '../src/index.js';
import type { ChangeEvent } from '../src/index.js';
import {
  authored,
  blankFrame,
  codeOf,
  ids,
  makeDoc,
  makeImages,
  makeStore,
  rgba,
} from './helpers.js';

const RED = [255, 0, 0, 255] as const;
const TILE = 16 * 16 * 4;
const TILE_IDX = 16 * 16;

describe('DocumentStore basics', () => {
  it('starts at version 0 with a frozen document, sorted image ids and an empty history', () => {
    const store = makeStore();
    expect(store.version).toBe(0);
    expect(Object.isFrozen(store.doc)).toBe(true);
    expect(Object.isFrozen(store.doc.layers[0])).toBe(true);
    expect(Object.isFrozen(store.doc.palettes[0]?.colors[1])).toBe(true);
    expect(store.imageIds()).toEqual([...makeImages().map(([id]) => id)].sort());
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
    expect(store.undo()).toBeUndefined();
    expect(store.redo()).toBeUndefined();
    const info = store.historyInfo();
    expect(info).toMatchObject({ entries: [], applied: 0, bytes: 0, cap: DEFAULT_MEMORY_CAP });
    expect(Document.safeParse(store.doc).success).toBe(true);
  });

  it('copies the input document and caller images (later caller edits do not leak in)', () => {
    const doc = makeDoc();
    const images = makeImages();
    const store = new DocumentStore(doc, { images });
    const h = documentHash(store);
    doc.meta.name = 'changed';
    rgba(images[0]?.[1]).set(5, 5, RED);
    expect(Object.isFrozen(doc)).toBe(false);
    expect(store.doc.meta.name).toBe('test');
    expect(documentHash(store)).toBe(h);
  });

  it('forks from a snapshot in O(1): sealed document and published images are shared', () => {
    const store = makeStore();
    const snap = store.snapshot();
    const fork = new DocumentStore(snap.doc, { images: snap.images });
    expect(fork.doc).toBe(store.doc);
    expect(fork.image(ids.imgBg)).toBe(store.image(ids.imgBg));
    fork.transact('paint fork', (tx) =>
      tx.writeImage(ids.imgBg, (img) => rgba(img).set(1, 1, RED)),
    );
    expect(store.image(ids.imgBg)?.equals(fork.image(ids.imgBg) as TiledImage)).toBe(false);
    expect(documentHash(store)).toBe(documentHash(snap));
  });

  it('rejects bad constructor input', () => {
    expect(codeOf(() => new DocumentStore([] as unknown as Document))).toBe('BAD_VALUE');
    expect(codeOf(() => new DocumentStore({ a: undefined } as unknown as Document))).toBe(
      'BAD_VALUE',
    );
    expect(
      codeOf(
        () =>
          new DocumentStore(makeDoc(), {
            images: [[ids.imgBg, {} as unknown as TiledImage]],
          }),
      ),
    ).toBe('BAD_ARGUMENT');
    const img = new TiledImage(2, 2);
    expect(
      codeOf(
        () =>
          new DocumentStore(makeDoc(), {
            images: [
              [ids.imgBg, img],
              [ids.imgBg, img],
            ],
          }),
      ),
    ).toBe('IMAGE_EXISTS');
    expect(codeOf(() => makeStore({ memoryCap: -1 }))).toBe('BAD_ARGUMENT');
    expect(codeOf(() => makeStore({ memoryCap: Number.NaN }))).toBe('BAD_ARGUMENT');
  });
});

describe('transactions', () => {
  it('commit applies the change, bumps the version once and records one labelled entry', () => {
    const store = makeStore();
    const before = store.doc;
    const tx = store.begin('Set duration');
    expect(store.transaction).toBe(tx);
    tx.update((d) => {
      (authored(d).frames[0] as { durationMs: number }).durationMs = 120;
    });
    expect(tx.doc.animations[0]).not.toBe(before.animations[0]);
    expect(store.doc).toBe(before); // nothing published before commit
    const ev = tx.commit();
    expect(tx.isOpen).toBe(false);
    expect(store.transaction).toBeUndefined();
    expect(store.version).toBe(1);
    expect(ev).toMatchObject({ kind: 'commit', version: 1, label: 'Set duration', entryId: 1 });
    expect(ev?.paths).toEqual([['animations', 0, 'frames', 0, 'durationMs']]);
    expect(ev?.patch.ops).toEqual([
      {
        op: 'replace',
        path: ['animations', 0, 'frames', 0, 'durationMs'],
        before: 100,
        after: 120,
      },
    ]);
    // Structural sharing: untouched sub-trees are the same objects.
    expect(store.doc.layers).toBe(before.layers);
    expect(store.doc.meta).toBe(before.meta);
    expect(store.doc.animations[0] && 'frames' in store.doc.animations[0]).toBe(true);
    expect(store.historyInfo().entries).toEqual([
      expect.objectContaining({ id: 1, label: 'Set duration', applied: true }),
    ]);
  });

  it('a transaction that changes nothing commits nothing (no entry, no version, no event)', () => {
    const store = makeStore();
    const events: ChangeEvent[] = [];
    store.subscribe((e) => events.push(e));
    const h = documentHash(store);
    // Same value, write-then-revert, same pixel, and a pixel set and erased back.
    const tx = store.begin('noop');
    tx.set(['meta', 'name'], 'test');
    tx.update((d) => {
      d.meta.name = 'x';
    });
    tx.update((d) => {
      d.meta.name = 'test';
    });
    tx.writeImage(ids.imgBg, (img) => {
      rgba(img).set(0, 0, [10, 20, 30, 255]);
      rgba(img).set(30, 30, RED);
      rgba(img).set(30, 30, [0, 0, 0, 0]);
    });
    const id = tx.createImage(new TiledImage(4, 4));
    tx.deleteImage(id);
    expect(tx.commit()).toBeUndefined();
    expect(store.version).toBe(0);
    expect(store.canUndo).toBe(false);
    expect(events).toEqual([]);
    expect(documentHash(store)).toBe(h);
    // The id counter moved inside the transaction, but no allocated id was kept: not a change.
    expect(store.doc.meta.ids.next).toBe(makeDoc().meta.ids.next);
    // An allocated id that is stored somewhere does count.
    const tx2 = store.begin('keeps an id');
    const keep = tx2.createImage(new TiledImage(4, 4));
    expect(tx2.commit()?.imageIds).toEqual([keep]);
  });

  it('cancel leaves no trace: same objects, same hash, same version, counter not advanced', () => {
    const store = makeStore();
    const doc = store.doc;
    const bg = store.image(ids.imgBg);
    const h = documentHash(store);
    const tx = store.begin('to cancel');
    const firstId = tx.newId('layer');
    tx.update((d) => {
      d.meta.name = 'gone';
    });
    tx.writeImage(ids.imgBg, (img) => rgba(img).set(2, 2, RED));
    tx.createImage(new TiledImage(3, 3));
    tx.deleteImage(ids.imgSpark);
    tx.cancel();
    tx.cancel(); // idempotent
    expect(tx.isOpen).toBe(false);
    expect(store.doc).toBe(doc);
    expect(store.image(ids.imgBg)).toBe(bg);
    expect(store.image(ids.imgSpark)).toBeDefined();
    expect(store.version).toBe(0);
    expect(documentHash(store)).toBe(h);
    expect(store.canUndo).toBe(false);
    const again = store.begin('again');
    expect(again.newId('layer')).toBe(firstId);
    again.cancel();
  });

  it('does not nest: begin, undo, redo and clearHistory throw TX_ACTIVE while a transaction is open', () => {
    const store = makeStore();
    const tx = store.begin('outer');
    expect(codeOf(() => store.begin('inner'))).toBe('TX_ACTIVE');
    expect(codeOf(() => store.undo())).toBe('TX_ACTIVE');
    expect(codeOf(() => store.redo())).toBe('TX_ACTIVE');
    expect(
      codeOf(() => {
        store.clearHistory();
      }),
    ).toBe('TX_ACTIVE');
    expect(codeOf(() => store.transact('inner', () => 1))).toBe('TX_ACTIVE');
    tx.cancel();
    expect(codeOf(() => store.begin(''))).toBe('BAD_ARGUMENT');
  });

  it('a closed transaction throws TX_CLOSED on every call', () => {
    const store = makeStore();
    const tx = store.begin('t');
    tx.set(['meta', 'name'], 'n');
    tx.commit();
    for (const f of [
      () => tx.doc,
      () => tx.get(['meta']),
      () => {
        tx.set(['meta', 'name'], 'x');
      },
      () => {
        tx.insert(['eventDefs', 0], { name: 'a' });
      },
      () => {
        tx.remove(['eventDefs', 0]);
      },
      () => {
        tx.update(() => undefined);
      },
      () => tx.newId('frame'),
      () => tx.image(ids.imgBg),
      () => tx.imageIds(),
      () => tx.createImage(new TiledImage(1, 1)),
      () => tx.writeImage(ids.imgBg, () => 0),
      () => {
        tx.deleteImage(ids.imgBg);
      },
      () => tx.commit(),
    ]) {
      expect(codeOf(f)).toBe('TX_CLOSED');
    }
  });

  it('any error aborts the transaction', () => {
    const store = makeStore();
    const tx = store.begin('fails');
    tx.set(['meta', 'name'], 'edited');
    expect(
      codeOf(() => {
        tx.remove(['nope', 'deeper']);
      }),
    ).toBe('BAD_PATH');
    expect(tx.isOpen).toBe(false);
    expect(store.transaction).toBeUndefined();
    expect(store.doc.meta.name).toBe('test');
    const tx2 = store.begin('fails in a callback');
    expect(
      codeOf(() =>
        tx2.writeImage(ids.imgBg, () => {
          throw new Error('boom');
        }),
      ),
    ).toBe('other');
    expect(tx2.isOpen).toBe(false);
  });

  it('transact commits, returns the result, cancels on throw and rejects async callbacks', () => {
    const store = makeStore();
    const r = store.transact('rename', (tx) => {
      tx.set(['meta', 'name'], 'hero');
      return 42;
    });
    expect(r).toBe(42);
    expect(store.version).toBe(1);
    expect(() =>
      store.transact('throws', (tx) => {
        tx.set(['meta', 'name'], 'lost');
        throw new Error('nope');
      }),
    ).toThrow('nope');
    expect(store.doc.meta.name).toBe('hero');
    expect(store.transaction).toBeUndefined();
    expect(codeOf(() => store.transact('async', () => Promise.resolve(1)))).toBe('TX_ASYNC');
    expect(store.transaction).toBeUndefined();
    // A callback that commits (or cancels) itself is not committed twice.
    store.transact('self-commit', (tx) => {
      tx.set(['meta', 'name'], 'self');
      tx.commit();
    });
    expect(store.version).toBe(2);
    store.transact('self-cancel', (tx) => {
      tx.set(['meta', 'name'], 'never');
      tx.cancel();
    });
    expect(store.doc.meta.name).toBe('self');
  });

  it('path helpers: set, insert, remove, get, root replace and their errors', () => {
    const store = makeStore();
    const tx = store.begin('paths');
    tx.set(['meta', 'name'], 'renamed');
    tx.set(['directionFallback', 'up'], ['up', 'side']);
    tx.insert(['eventDefs', 1], { name: 'land' });
    tx.insert(['eventDefs', 0], { name: 'jump' });
    tx.remove(['markerDefs', 0]);
    tx.remove(['activePaletteId']);
    tx.set(['palettes', 0, 'colors', 1], [0, 255, 0, 255]);
    expect(tx.get(['eventDefs'])).toEqual([{ name: 'jump' }, { name: 'step' }, { name: 'land' }]);
    expect(tx.get(['missing', 'path'])).toBeUndefined();
    expect(tx.get(['meta', 'name', 'x'])).toBeUndefined();
    const ops = tx.commit()?.patch.ops ?? [];
    expect(ops[0]).toEqual({ op: 'remove', path: ['activePaletteId'], before: ids.pal });
    expect(ops[1]).toEqual({ op: 'add', path: ['directionFallback', 'up'], after: ['up', 'side'] });
    expect(ops).toContainEqual({
      op: 'remove',
      path: ['markerDefs', 0],
      before: { name: 'hand_r' },
    });
    expect(ops).toContainEqual({
      op: 'replace',
      path: ['meta', 'name'],
      before: 'test',
      after: 'renamed',
    });
    expect(store.undo()?.kind).toBe('undo');
    expect(store.doc).toEqual(makeDoc());

    const cases: [string, (tx: ReturnType<DocumentStore['begin']>) => void][] = [
      [
        'BAD_PATH',
        (t) => {
          t.set(['eventDefs', 5], { name: 'x' });
        },
      ],
      [
        'BAD_PATH',
        (t) => {
          t.set(['meta', 'name', 'deeper'], 1);
        },
      ],
      [
        'BAD_PATH',
        (t) => {
          t.set(['meta', -1], 1);
        },
      ],
      [
        'BAD_PATH',
        (t) => {
          t.set(['meta', 1.5], 1);
        },
      ],
      [
        'BAD_PATH',
        (t) => {
          t.set(['__proto__'], 1);
        },
      ],
      [
        'BAD_PATH',
        (t) => {
          t.set('meta' as unknown as string[], 1);
        },
      ],
      [
        'BAD_PATH',
        (t) => {
          t.set(['eventDefs', 'x'], 1);
        },
      ],
      [
        'BAD_PATH',
        (t) => {
          t.insert(['meta', 'x'], 1);
        },
      ],
      [
        'BAD_PATH',
        (t) => {
          t.insert(['eventDefs', 9], 1);
        },
      ],
      [
        'BAD_PATH',
        (t) => {
          t.remove([]);
        },
      ],
      [
        'BAD_PATH',
        (t) => {
          t.remove(['eventDefs', 3]);
        },
      ],
      ['BAD_PATH', (t) => t.get([true as unknown as string])],
      [
        'BAD_VALUE',
        (t) => {
          t.set(['meta', 'name'], undefined);
        },
      ],
      [
        'BAD_VALUE',
        (t) => {
          t.set(['meta', 'name'], Number.NaN);
        },
      ],
      [
        'BAD_VALUE',
        (t) => {
          t.set(['meta', 'name'], () => 1);
        },
      ],
      [
        'BAD_VALUE',
        (t) => {
          t.set(['meta', 'name'], new Map());
        },
      ],
      [
        'BAD_VALUE',
        (t) => {
          t.set(['meta', 'name'], { [Symbol('s')]: 1 });
        },
      ],
      [
        'BAD_VALUE',
        (t) => {
          t.set(['meta', 'name'], JSON.parse('{"__proto__": 1}'));
        },
      ],
      [
        'BAD_VALUE',
        (t) => {
          const holes: unknown[] = [1];
          holes[2] = 3;
          t.set(['meta', 'name'], holes);
        },
      ],
    ];
    for (const [code, f] of cases) {
      const t = store.begin('bad');
      expect(
        codeOf(() => {
          f(t);
        }),
        String(f),
      ).toBe(code);
      expect(t.isOpen).toBe(false);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const t = store.begin('cyclic');
    expect(
      codeOf(() => {
        t.set(['meta', 'name'], cyclic);
      }),
    ).toBe('BAD_VALUE');
  });

  it('replaces the root with set([])', () => {
    const store = makeStore();
    const next = makeDoc();
    next.meta.name = 'root';
    store.transact('root', (tx) => {
      tx.set([], next);
    });
    expect(store.doc.meta.name).toBe('root');
    expect(store.historyInfo().entries).toHaveLength(1);
    store.undo();
    expect(store.doc.meta.name).toBe('test');
  });
});

describe('ids (meta.ids)', () => {
  it('allocates ids from the counter; undo + re-run and redo reproduce the same ids', () => {
    const store = makeStore();
    const seed = store.doc.meta.ids.seed;
    const n0 = store.doc.meta.ids.next;
    const addFrame = (): string =>
      store.transact('Insert frame', (tx) => {
        const id = tx.newId('frame');
        tx.update((d) => {
          authored(d).frames.push(blankFrame(id));
        });
        return id;
      });
    const id1 = addFrame();
    expect(id1).toBe(makeId('frame', seed, n0));
    expect(store.doc.meta.ids.next).toBe(n0 + 1);
    const h1 = documentHash(store);
    store.undo();
    expect(store.doc.meta.ids.next).toBe(n0);
    store.redo();
    expect(documentHash(store)).toBe(h1);
    store.undo();
    expect(addFrame()).toBe(id1); // same op after undo -> same id
    expect(documentHash(store)).toBe(h1);
  });

  it('newId inside an update recipe advances the draft counter', () => {
    const store = makeStore();
    const n0 = store.doc.meta.ids.next;
    const got: string[] = [];
    store.transact('two layers', (tx) => {
      tx.update((d) => {
        for (let i = 0; i < 2; i++) {
          const id = tx.newId('layer');
          got.push(id);
          d.layers.push({
            kind: 'part',
            id,
            name: `p${String(i)}`,
            visible: true,
            opacity: 255,
            export: true,
          });
        }
      });
    });
    expect(new Set(got).size).toBe(2);
    expect(store.doc.meta.ids.next).toBe(n0 + 2);
    expect(got[0]).toBe(makeId('layer', store.doc.meta.ids.seed, n0));
  });

  it('throws ID_EXHAUSTED at 2^30', () => {
    const doc = makeDoc();
    doc.meta.ids.next = 0x40000000;
    const store = new DocumentStore(doc);
    const tx = store.begin('ids');
    expect(codeOf(() => tx.newId('frame'))).toBe('ID_EXHAUSTED');
    expect(tx.isOpen).toBe(false);
  });
});

describe('images in transactions', () => {
  it('writes, creates and deletes images; undo and redo restore them', () => {
    const store = makeStore();
    const h0 = documentHash(store);
    const bg0 = store.image(ids.imgBg);
    let created = '' as ImageId;
    const ev = store.transact('Paint', (tx) => {
      tx.writeImage(ids.imgBg, (img) => {
        rgba(img).set(15, 15, RED); // tile (0,0)
        rgba(img).set(16, 16, RED); // tile (1,1): a tile-crossing stroke
      });
      created = tx.createImage(
        TiledImage.fromRGBA({
          width: 2,
          height: 1,
          data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        }),
      );
      expect(tx.image(created)?.width).toBe(2);
      expect(tx.imageIds()).toContain(created);
      tx.deleteImage(ids.imgSpark);
      expect(tx.image(ids.imgSpark)).toBeUndefined();
      expect(tx.imageIds()).not.toContain(ids.imgSpark);
      expect(store.image(ids.imgSpark)).toBeDefined(); // committed state untouched until commit
      return tx.commit();
    });
    expect(ev?.imageIds).toEqual([ids.imgBg, ids.imgSpark, created].sort());
    const tiles = ev?.patch.images.find((p) => p.kind === 'tiles');
    expect(tiles?.kind === 'tiles' && tiles.after.map((s) => [s.tx, s.ty])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(Object.isFrozen(ev?.patch)).toBe(true);
    expect(store.image(ids.imgBg)).not.toBe(bg0); // a new published instance
    expect(bg0?.get(15, 15)).toEqual([0, 0, 0, 0]); // the old one is unchanged
    expect(rgba(store.image(ids.imgBg)).get(16, 16)).toEqual(RED);
    expect(store.image(ids.imgSpark)).toBeUndefined();
    const h1 = documentHash(store);
    store.undo();
    expect(documentHash(store)).toBe(h0);
    expect(store.image(created)).toBeUndefined();
    expect(store.image(ids.imgSpark)).toBeDefined();
    store.redo();
    expect(documentHash(store)).toBe(h1);
  });

  it('writes indexed images and supports composite-style bulk writes', () => {
    const store = makeStore();
    store.transact('Mask', (tx) => {
      tx.writeImage(ids.imgMask, (img) => {
        if (!(img instanceof IndexedImage)) throw new Error('indexed');
        for (let x = 0; x < 20; x++) img.set(x, 15, 255);
      });
    });
    const mask = store.image(ids.imgMask) as IndexedImage;
    expect(mask.get(19, 15)).toBe(255);
    expect(store.historyInfo().tileBytes).toBe(3 * TILE_IDX); // old (0,0), new (0,0), new (1,0)
    store.transact('Clear', (tx) => {
      tx.writeImage(ids.imgMask, (img) => {
        img.clear();
      });
    });
    expect(store.image(ids.imgMask)?.tileCount).toBe(0);
    store.undo();
    expect((store.image(ids.imgMask) as IndexedImage).get(1, 1)).toBe(255);
  });

  it('reports image errors', () => {
    const store = makeStore();
    const missing = makeId('image', 1, 1);
    expect(codeOf(() => store.begin('a').writeImage(missing, () => 0))).toBe('IMAGE_MISSING');
    expect(
      codeOf(() => {
        store.begin('b').deleteImage(missing);
      }),
    ).toBe('IMAGE_MISSING');
    expect(codeOf(() => store.begin('c').createImage({} as TiledImage))).toBe('BAD_ARGUMENT');
    const tx = store.begin('d');
    tx.deleteImage(ids.imgBg);
    expect(codeOf(() => tx.writeImage(ids.imgBg, () => 0))).toBe('IMAGE_MISSING');
    const tx2 = store.begin('e');
    tx2.deleteImage(ids.imgBg);
    expect(
      codeOf(() => {
        tx2.deleteImage(ids.imgBg);
      }),
    ).toBe('IMAGE_MISSING');
    expect(codeOf(() => store.begin('f').writeImage(ids.imgBg, () => Promise.resolve()))).toBe(
      'TX_ASYNC',
    );
    // A counter that collides with an imported id.
    const doc = makeDoc();
    const clash = makeId('image', doc.meta.ids.seed, doc.meta.ids.next);
    const s2 = new DocumentStore(doc, { images: [[clash, new TiledImage(1, 1)]] });
    expect(codeOf(() => s2.begin('g').createImage(new TiledImage(1, 1)))).toBe('IMAGE_EXISTS');
  });

  it('detects a published image mutated outside a transaction (IMAGE_MUTATED)', () => {
    const store = makeStore();
    store.transact('paint', (tx) => tx.writeImage(ids.imgBg, (img) => rgba(img).set(1, 1, RED)));
    const published = rgba(store.image(ids.imgBg));
    published.set(2, 2, RED); // forbidden
    expect(codeOf(() => store.begin('w').writeImage(ids.imgBg, () => 0))).toBe('IMAGE_MUTATED');
    expect(
      codeOf(() => {
        store.begin('d').deleteImage(ids.imgBg);
      }),
    ).toBe('IMAGE_MUTATED');
    const doc = store.doc;
    expect(codeOf(() => store.undo())).toBe('IMAGE_MUTATED');
    expect(store.doc).toBe(doc); // undo left the store unchanged
    expect(store.version).toBe(1);
  });
});

describe('history', () => {
  it('undo/redo walk the linear stack; a new commit clears the redo side', () => {
    const store = makeStore();
    const name = (n: string) => {
      store.transact(`name ${n}`, (tx) => {
        tx.set(['meta', 'name'], n);
      });
    };
    name('a');
    name('b');
    name('c');
    expect(store.undo()?.label).toBe('name c');
    expect(store.undo()?.label).toBe('name b');
    expect(store.doc.meta.name).toBe('a');
    expect(store.canRedo).toBe(true);
    expect(store.historyInfo().entries.map((e) => [e.label, e.applied])).toEqual([
      ['name a', true],
      ['name b', false],
      ['name c', false],
    ]);
    expect(store.redo()?.label).toBe('name b');
    name('d');
    expect(store.canRedo).toBe(false);
    expect(store.historyInfo().entries.map((e) => e.label)).toEqual(['name a', 'name b', 'name d']);
    expect(store.historyInfo().entries.map((e) => e.id)).toEqual([1, 2, 4]);
    store.clearHistory();
    expect(store.canUndo).toBe(false);
    expect(store.historyInfo().bytes).toBe(0);
    expect(store.doc.meta.name).toBe('d');
  });

  it('counts tile bytes exactly: distinct buffers, each counted once across entries', () => {
    const doc = makeDoc();
    const empty = new TiledImage(64, 64);
    const s = new DocumentStore(doc, {
      images: [
        [ids.imgBg, empty],
        [ids.imgMask, new IndexedImage(32, 32)],
      ],
    });
    const paint = (label: string, f: (img: TiledImage) => void) => {
      s.transact(label, (tx) => {
        tx.writeImage(ids.imgBg, (img) => {
          f(rgba(img));
        });
      });
    };
    paint('t1', (img) => img.set(0, 0, RED)); // new tile (0,0): after only
    expect(s.historyInfo().tileBytes).toBe(TILE);
    paint('t2', (img) => {
      img.set(20, 0, RED);
      img.set(0, 20, RED);
    }); // two new tiles
    expect(s.historyInfo().tileBytes).toBe(3 * TILE);
    paint('t3', (img) => img.set(1, 0, RED)); // tile (0,0) again: before = t1's after buffer
    expect(s.historyInfo().tileBytes).toBe(4 * TILE);
    s.transact('t4', (tx) =>
      tx.writeImage(ids.imgMask, (img) => (img as IndexedImage).set(0, 0, 3)),
    );
    expect(s.historyInfo().tileBytes).toBe(4 * TILE + TILE_IDX);
    const three = new TiledImage(32, 32);
    three.set(0, 0, RED);
    three.set(16, 0, RED);
    three.set(0, 16, RED);
    const created = s.transact('t5', (tx) => tx.createImage(three));
    expect(s.historyInfo().tileBytes).toBe(7 * TILE + TILE_IDX);
    s.transact('t6', (tx) => {
      tx.deleteImage(created);
    }); // same buffers as t5: +0
    const info = s.historyInfo();
    expect(info.tileBytes).toBe(7 * TILE + TILE_IDX);
    expect(info.entries.map((e) => e.tileBytes)).toEqual([
      TILE,
      2 * TILE,
      2 * TILE,
      TILE_IDX,
      3 * TILE,
      3 * TILE,
    ]);
    expect(info.bytes).toBe(info.tileBytes + info.structBytes);
    expect(info.structBytes).toBe(info.entries.reduce((n, e) => n + e.structBytes, 0));
    // Undo and redo move entries but hold the same buffers.
    s.undo();
    s.undo();
    s.redo();
    expect(s.historyInfo().tileBytes).toBe(7 * TILE + TILE_IDX);
    // A new commit drops the redo side (t6) but t5 still holds the image's buffers.
    s.transact('t7', (tx) => {
      tx.set(['meta', 'name'], 'x');
    });
    expect(s.historyInfo().tileBytes).toBe(7 * TILE + TILE_IDX);
    s.undo();
    s.undo();
    s.transact('t8', (tx) => {
      tx.set(['meta', 'name'], 'y');
    }); // drops t7 and t5
    expect(s.historyInfo().tileBytes).toBe(4 * TILE + TILE_IDX);
  });

  it('estimates structural bytes with the documented formula', () => {
    const store = makeStore();
    const ev2 = store.transact('name', (tx) => {
      tx.set(['meta', 'name'], 'abcd');
      return tx.commit();
    });
    // 64 + (8 + 2*4) + (8 + 2*4) + (16 + 2*4) + (16 + 2*4)
    const expected = 64 + 16 + 16 + 24 + 24;
    expect(ev2 && estimatePatchBytes(ev2.patch)).toBe(expected);
    expect(store.historyInfo().structBytes).toBe(expected);
  });

  it('evicts the oldest entries over the cap and never the newest', () => {
    const s = new DocumentStore(makeDoc(), {
      images: [[ids.imgBg, new TiledImage(64, 64)]],
      memoryCap: 0,
    });
    const paint = (label: string, x: number, y: number) =>
      s.transact(label, (tx) => tx.writeImage(ids.imgBg, (img) => rgba(img).set(x, y, RED)));
    paint('t1', 0, 0);
    expect(s.historyInfo().entries.map((e) => e.label)).toEqual(['t1']); // kept although over the cap
    paint('t2', 20, 0);
    expect(s.historyInfo().entries.map((e) => e.label)).toEqual(['t2']);
    paint('t3', 1, 0); // before = t1's buffer, which t1's eviction no longer holds
    const info = s.historyInfo();
    expect(info.entries.map((e) => e.label)).toEqual(['t3']);
    expect(info.tileBytes).toBe(2 * TILE);
    expect(s.undo()?.label).toBe('t3');
    expect(s.canUndo).toBe(false);
    expect(rgba(s.image(ids.imgBg)).get(1, 0)).toEqual([0, 0, 0, 0]);
    expect(rgba(s.image(ids.imgBg)).get(0, 0)).toEqual(RED);

    const big = makeStore();
    for (let i = 0; i < 5; i++) {
      big.transact(`p${String(i)}`, (tx) =>
        tx.writeImage(ids.imgBg, (img) => rgba(img).set((i * 16) % 40, 0, RED)),
      );
    }
    const all = big.historyInfo();
    const last = all.entries.at(-1);
    big.setMemoryCap((last?.tileBytes ?? 0) + (last?.structBytes ?? 0) + 2 * TILE);
    expect(big.historyInfo().entries.length).toBeLessThan(5);
    expect(big.historyInfo().entries.at(-1)?.label).toBe('p4');
    expect(big.historyInfo().bytes).toBeLessThanOrEqual(big.historyInfo().cap);
    const three = makeStore();
    for (const n of ['q1', 'q2', 'q3'])
      three.transact(n, (tx) => {
        tx.set(['meta', 'name'], n);
      });
    three.undo();
    three.setMemoryCap(0); // the cap covers both sides; only the newest applied entry must stay
    const after = three.historyInfo();
    expect(after.entries.map((e) => [e.label, e.applied])).toEqual([['q2', true]]);
    expect(three.undo()?.label).toBe('q2');
    expect(three.doc.meta.name).toBe('q1');
    expect(
      codeOf(() => {
        big.setMemoryCap(-5);
      }),
    ).toBe('BAD_ARGUMENT');
    big.setMemoryCap(Infinity);
    expect(big.historyInfo().cap).toBe(Infinity);
  });
});

describe('events', () => {
  it('fire synchronously after commit, undo and redo with the right versions and patches', () => {
    const store = makeStore();
    const seen: ChangeEvent[] = [];
    const unsubscribe = store.subscribe((e) => {
      expect(store.version).toBe(e.version); // emitted after the state change
      seen.push(e);
    });
    store.transact('a', (tx) => {
      tx.set(['meta', 'name'], 'a');
    });
    store.undo();
    store.redo();
    expect(seen.map((e) => [e.kind, e.version, e.label, e.entryId])).toEqual([
      ['commit', 1, 'a', 1],
      ['undo', 2, 'a', 1],
      ['redo', 3, 'a', 1],
    ]);
    expect(seen[1]?.patch.ops).toEqual([
      { op: 'replace', path: ['meta', 'name'], before: 'a', after: 'test' },
    ]);
    expect(seen[2]?.patch).toBe(seen[0]?.patch);
    unsubscribe();
    unsubscribe();
    store.transact('b', (tx) => {
      tx.set(['meta', 'name'], 'b');
    });
    expect(seen).toHaveLength(3);
    expect(codeOf(() => store.subscribe(1 as unknown as () => void))).toBe('BAD_ARGUMENT');
  });

  it('delivers each event to every listener in subscription order; unsubscribing mid-event is safe', () => {
    const store = makeStore();
    const order: string[] = [];
    store.subscribe((e) => order.push(`A${String(e.version)}`));
    let unsubB: () => void = () => undefined;
    unsubB = store.subscribe((e) => {
      order.push(`B${String(e.version)}`);
      if (e.version === 2) unsubB();
    });
    store.subscribe((e) => order.push(`C${String(e.version)}`));
    for (const n of ['F', 'G', 'H']) {
      store.transact(n, (tx) => {
        tx.set(['meta', 'name'], n);
      });
    }
    expect(order).toEqual(['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'C3']);
  });

  it('runs every listener even if some throw, then rethrows (the change is applied)', () => {
    const store = makeStore();
    let ran = 0;
    store.subscribe(() => {
      throw new Error('one');
    });
    store.subscribe(() => ran++);
    expect(() => {
      store.transact('x', (tx) => {
        tx.set(['meta', 'name'], 'x');
      });
    }).toThrow('one');
    expect(ran).toBe(1);
    expect(store.version).toBe(1);
    expect(store.transaction).toBeUndefined();
    store.subscribe(() => {
      throw new Error('two');
    });
    expect(() => store.undo()).toThrow(AggregateError);
    expect(store.version).toBe(2);
    expect(ran).toBe(2);
  });
});

describe('snapshots', () => {
  it('are O(1) views that never change afterwards', () => {
    const store = makeStore();
    const snap = store.snapshot();
    const h = documentHash(snap);
    store.transact('paint', (tx) => {
      tx.writeImage(ids.imgBg, (img) => rgba(img).set(3, 3, RED));
      tx.deleteImage(ids.imgSpark);
      tx.set(['meta', 'name'], 'later');
    });
    store.undo();
    store.redo();
    expect(snap.version).toBe(0);
    expect(snap.doc.meta.name).toBe('test');
    expect(snap.image(ids.imgSpark)).toBeDefined();
    expect(snap.imageIds()).toContain(ids.imgSpark);
    expect(snap.images.size).toBe(3);
    expect(documentHash(snap)).toBe(h);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => {
      (snap.doc.meta as { name: string }).name = 'mutated';
    }).toThrow(TypeError);
  });
});

describe('CoreError', () => {
  it('carries a code and details', () => {
    const e = new CoreError('BAD_PATH', 'm', { path: ['a'] });
    expect(e).toBeInstanceOf(Error);
    expect([e.name, e.code, e.message, e.details]).toEqual([
      'CoreError',
      'BAD_PATH',
      'm',
      { path: ['a'] },
    ]);
  });
});
