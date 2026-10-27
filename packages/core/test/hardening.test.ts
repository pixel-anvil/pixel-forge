import { TiledImage } from '@pixel-forge/raster';
import { describe, expect, it } from 'vitest';
import { DocumentStore, documentHash } from '../src/index.js';
import type { ChangeEvent, Transaction } from '../src/index.js';
import { openDraft } from '../src/draft.js';
import { isContainer, seal } from '../src/json.js';
import { codeOf, ids, makeDoc, makeStore, rgba } from './helpers.js';

const RED = [255, 0, 0, 255] as const;

function paint(store: DocumentStore, label: string, x: number, y: number): void {
  store.transact(label, (tx) => {
    tx.writeImage(ids.imgBg, (img) => rgba(img).set(x, y, RED));
  });
}

describe('writeImage re-entrancy', () => {
  const calls: [string, (tx: Transaction, store: DocumentStore) => unknown][] = [
    ['commit', (tx) => tx.commit()],
    [
      'cancel',
      (tx) => {
        tx.cancel();
      },
    ],
    [
      'set',
      (tx) => {
        tx.set(['meta', 'name'], 'x');
      },
    ],
    [
      'insert',
      (tx) => {
        tx.insert(['markerDefs', 0], { name: 'm' });
      },
    ],
    [
      'remove',
      (tx) => {
        tx.remove(['markerDefs', 0]);
      },
    ],
    [
      'update',
      (tx) => {
        tx.update(() => undefined);
      },
    ],
    ['newId', (tx) => tx.newId('frame')],
    ['createImage', (tx) => tx.createImage(new TiledImage(2, 2))],
    [
      'deleteImage',
      (tx) => {
        tx.deleteImage(ids.imgSpark);
      },
    ],
    ['nested writeImage', (tx) => tx.writeImage(ids.imgSpark, () => 0)],
    ['store.begin', (_tx, s) => s.begin('inner')],
    ['store.undo', (_tx, s) => s.undo()],
    ['store.redo', (_tx, s) => s.redo()],
    [
      'store.clearHistory',
      (_tx, s) => {
        s.clearHistory();
      },
    ],
  ];

  it.each(calls)(
    '%s inside the callback throws TX_BUSY and aborts, nothing is published',
    (_n, call) => {
      const store = makeStore();
      paint(store, 'seed', 5, 5); // gives undo something to do
      const hash = documentHash(store);
      const version = store.version;
      const published = store.image(ids.imgBg);
      const events: ChangeEvent[] = [];
      store.subscribe((e) => events.push(e));
      const tx = store.begin('busy');
      let inner: string | undefined;
      // the callback swallows the error; the transaction must still be dead and writeImage must throw
      expect(
        codeOf(() => {
          tx.writeImage(ids.imgBg, (img) => {
            rgba(img).set(1, 1, RED);
            inner = codeOf(() => call(tx, store));
          });
        }),
      ).toBe('TX_BUSY');
      expect(inner).toBe('TX_BUSY');
      expect(tx.isOpen).toBe(false);
      expect(store.transaction).toBeUndefined();
      expect(store.version).toBe(version);
      expect(store.image(ids.imgBg)).toBe(published);
      expect(documentHash(store)).toBe(hash);
      expect(events).toEqual([]);
      expect(codeOf(() => tx.commit())).toBe('TX_CLOSED');
    },
  );

  it('allows reads inside the callback and works normally afterwards', () => {
    const store = makeStore();
    const tx = store.begin('reads');
    tx.writeImage(ids.imgBg, (img) => {
      expect(tx.image(ids.imgBg)).toBe(img);
      expect(tx.doc.meta.name).toBe('test');
      expect(tx.get(['meta', 'name'])).toBe('test');
      expect(tx.imageIds()).toContain(ids.imgBg);
    });
    expect(codeOf(() => tx.writeImage(ids.imgBg, () => 1))).toBeUndefined(); // flag was reset
    tx.set(['meta', 'name'], 'after');
    expect(tx.commit()?.label).toBe('reads');
    // a callback that throws on its own also resets the flag (and aborts as before)
    const tx2 = store.begin('throws');
    expect(
      codeOf(() =>
        tx2.writeImage(ids.imgBg, () => {
          throw new Error('boom');
        }),
      ),
    ).toBe('other');
    expect(tx2.isOpen).toBe(false);
  });
});

describe('snapshot images are read-only', () => {
  it('has throwing mutators that cannot reach the store', () => {
    const store = makeStore();
    const snap = store.snapshot();
    const m = snap.images as unknown as Map<string, unknown>;
    expect(codeOf(() => m.delete(ids.imgBg))).toBe('BAD_ARGUMENT');
    expect(codeOf(() => m.set('img_x', 1))).toBe('BAD_ARGUMENT');
    expect(
      codeOf(() => {
        m.clear();
      }),
    ).toBe('BAD_ARGUMENT');
    expect(store.image(ids.imgBg)).toBeDefined();
    expect(store.imageIds()).toHaveLength(3);
    expect(snap.images.size).toBe(3);
    expect(snap.images.has(ids.imgBg)).toBe(true);
    expect(snap.images.get(ids.imgBg)).toBe(store.image(ids.imgBg));
    expect([...snap.images.keys()].sort()).toEqual(store.imageIds());
    expect([...snap.images.values()]).toHaveLength(3);
    expect([...snap.images].map(([id]) => id).sort()).toEqual(store.imageIds());
    const seen: string[] = [];
    snap.images.forEach((_img, id, map) => {
      expect(map).toBe(snap.images);
      seen.push(id);
    });
    expect(seen.sort()).toEqual(store.imageIds());
    expect(Object.isFrozen(snap.images)).toBe(true);
  });

  it('a fork shares no mutable state with its source', () => {
    const store = makeStore();
    const snap = store.snapshot();
    const h = documentHash(store);
    const fork = new DocumentStore(snap.doc, { images: snap.images });
    fork.transact('fork edit', (tx) => {
      tx.writeImage(ids.imgBg, (img) => rgba(img).set(2, 2, RED));
      tx.deleteImage(ids.imgSpark);
    });
    paint(store, 'main edit', 9, 9);
    expect(snap.images.get(ids.imgSpark)).toBeDefined();
    expect(fork.image(ids.imgSpark)).toBeUndefined();
    expect(store.image(ids.imgSpark)).toBeDefined();
    expect(documentHash(snap)).toBe(h);
    expect(rgba(store.image(ids.imgBg)).get(2, 2)).toEqual([0, 0, 0, 0]);
    expect(rgba(fork.image(ids.imgBg)).get(9, 9)).toEqual([0, 0, 0, 0]);
  });
});

describe('id counter no-op rule', () => {
  it('allocations alone are a no-op; an explicit edit of meta.ids commits', () => {
    const store = makeStore();
    const next0 = store.doc.meta.ids.next;
    const pure = store.begin('pure');
    pure.newId('frame');
    pure.update((d) => {
      d.meta.ids.next += 0;
    });
    expect(pure.commit()).toBeUndefined();
    expect(store.version).toBe(0);

    paint(store, 'seed', 0, 0);
    const v = store.version;
    const viaSet = store.begin('bump');
    viaSet.set(['meta', 'ids', 'next'], 1000);
    expect(viaSet.commit()?.paths).toEqual([['meta', 'ids', 'next']]);
    expect(store.doc.meta.ids.next).toBe(1000);
    expect(store.version).toBe(v + 1);
    store.undo();
    expect(store.doc.meta.ids.next).toBe(next0);

    const viaDraft = store.begin('bump2');
    viaDraft.update((d) => {
      d.meta.ids.next = 1000;
    });
    expect(viaDraft.commit()).toBeDefined();
    expect(store.doc.meta.ids.next).toBe(1000);
    store.undo();

    const mixed = store.begin('alloc then bump');
    mixed.newId('frame');
    mixed.set(['meta', 'ids', 'next'], next0 + 1); // same value an allocation would give: still explicit
    expect(mixed.commit()).toBeDefined();
    expect(store.doc.meta.ids.next).toBe(next0 + 1);
    store.undo();

    const allocPlusDraft = store.begin('alloc then draft bump');
    allocPlusDraft.newId('frame');
    allocPlusDraft.update((d) => {
      d.meta.ids.next = 500;
    });
    expect(allocPlusDraft.commit()).toBeDefined();
    expect(store.doc.meta.ids.next).toBe(500);
  });
});

describe('root replacement', () => {
  it.each([[5], ['x'], [null], [[]], [true]])('set([], %j) is BAD_VALUE and aborts', (value) => {
    const store = makeStore();
    const tx = store.begin('root');
    expect(
      codeOf(() => {
        tx.set([], value);
      }),
    ).toBe('BAD_VALUE');
    expect(tx.isOpen).toBe(false);
    expect(store.version).toBe(0);
    expect(store.transaction).toBeUndefined();
    expect(store.doc.meta.name).toBe('test');
  });

  it('still accepts an object root', () => {
    const store = makeStore();
    const next = makeDoc();
    next.meta.name = 'ok';
    store.transact('root', (tx) => {
      tx.set([], next);
    });
    expect(store.doc.meta.name).toBe('ok');
  });
});

describe('eviction by distance from the current position', () => {
  /** `smalls` name edits, then `larges` strokes on distinct tiles of a big image. */
  function build(smalls: number, larges: number) {
    const s = new DocumentStore(makeDoc(), {
      images: [[ids.imgBg, new TiledImage(800, 800)]],
    });
    for (let i = 0; i < smalls; i++) {
      s.transact(`small${String(i)}`, (tx) => {
        tx.set(['meta', 'name'], `n${String(i)}`);
      });
    }
    for (let i = 0; i < larges; i++) {
      s.transact(`large${String(i)}`, (tx) => {
        tx.writeImage(ids.imgBg, (img) => rgba(img).set(16 * i, 0, RED));
      });
    }
    return s;
  }

  it('undo 50 large strokes, lower the cap: far redo entries go first, undo depth is kept', () => {
    const s = build(10, 50);
    for (let i = 0; i < 50; i++) s.undo();
    expect(s.historyInfo().applied).toBe(10);
    const rows = s.historyInfo().entries;
    const smallBytes = rows.slice(0, 10).reduce((n, e) => n + e.tileBytes + e.structBytes, 0);
    const largeBytes = rows[10] ? rows[10].tileBytes + rows[10].structBytes : 0;
    s.setMemoryCap(smallBytes + 10.5 * largeBytes);
    const info = s.historyInfo();
    expect(info.applied).toBe(10); // every small undo step survives
    const redo = info.entries.filter((e) => !e.applied).map((e) => e.label);
    expect(redo).toEqual(Array.from({ length: 10 }, (_v, i) => `large${String(i)}`)); // next redo first
    expect(info.bytes).toBeLessThanOrEqual(info.cap);
    // lowering it further trims both ends toward the current position, the nearest redo stays
    s.setMemoryCap(smallBytes + 5.5 * largeBytes);
    const tight = s.historyInfo();
    expect(tight.bytes).toBeLessThanOrEqual(tight.cap);
    const left = tight.entries.filter((e) => !e.applied).map((e) => e.label);
    expect(left[0]).toBe('large0');
    for (let i = 0; i < left.length; i++) expect(s.redo()?.label).toBe(`large${String(i)}`);
    expect(s.redo()).toBeUndefined();
    for (let i = 0; i < tight.applied + left.length; i++) expect(s.undo()).toBeDefined();
    expect(s.undo()).toBeUndefined();
  });

  it('when the undo end is farther, it is evicted first and the near redo entries stay', () => {
    const s = build(0, 40);
    s.undo();
    s.undo();
    const rows = s.historyInfo().entries;
    const each = (rows[0]?.tileBytes ?? 0) + (rows[0]?.structBytes ?? 0);
    s.setMemoryCap(each * 4.5);
    const info = s.historyInfo();
    // 38 undo steps away versus 2 redo steps: the undo end is trimmed, down to 2 applied entries
    expect(info.entries.map((e) => [e.label, e.applied])).toEqual([
      ['large36', true],
      ['large37', true],
      ['large38', false],
      ['large39', false],
    ]);
    expect(info.bytes).toBeLessThanOrEqual(info.cap);
    expect(s.redo()?.label).toBe('large38');
    expect(s.redo()?.label).toBe('large39');
  });

  it('never evicts the newest applied entry; the cap covers both sides', () => {
    const s = build(3, 3);
    s.undo();
    s.undo();
    s.setMemoryCap(0);
    expect(s.historyInfo().entries.map((e) => [e.label, e.applied])).toEqual([['large0', true]]);
    expect(s.canRedo).toBe(false);
    const t = build(0, 2);
    t.undo();
    t.undo(); // nothing applied: a lone redo side is evictable
    t.setMemoryCap(0);
    expect(t.historyInfo().entries).toEqual([]);
  });
});

describe('immutability at commit and for listeners', () => {
  it('commit re-checks the published base image (IMAGE_MUTATED) and aborts', () => {
    const store = makeStore();
    const tx = store.begin('x');
    tx.writeImage(ids.imgBg, (img) => rgba(img).set(1, 1, RED));
    rgba(store.image(ids.imgBg)).set(2, 2, RED); // forbidden mutation of the published base
    expect(codeOf(() => tx.commit())).toBe('IMAGE_MUTATED');
    expect(tx.isOpen).toBe(false);
    expect(store.transaction).toBeUndefined();
    expect(store.version).toBe(0);

    const del = store.begin('del');
    del.deleteImage(ids.imgSpark);
    rgba(store.image(ids.imgSpark)).set(0, 0, RED);
    expect(codeOf(() => del.commit())).toBe('IMAGE_MUTATED');
    expect(store.version).toBe(0);
  });

  it('event patches hand out copies: a listener cannot corrupt history or the live image', () => {
    const store = makeStore();
    const hash0 = documentHash(store);
    let tilesEvent: ChangeEvent | undefined;
    store.subscribe((e) => {
      tilesEvent ??= e;
      for (const p of e.patch.images) {
        if (p.kind === 'tiles') {
          for (const side of [p.before, p.after]) {
            for (const s of side) s.data?.fill(0xee); // scribble on whatever we are given
          }
        } else {
          const copy = p.image;
          if (copy instanceof TiledImage) copy.set(0, 0, RED);
        }
      }
    });
    paint(store, 'a', 1, 1);
    const hash1 = documentHash(store);
    expect(rgba(store.image(ids.imgBg)).get(1, 1)).toEqual(RED);
    store.transact('create', (tx) => {
      tx.createImage(new TiledImage(4, 4));
    });
    const hash2 = documentHash(store);
    store.undo();
    store.undo();
    expect(documentHash(store)).toBe(hash0);
    store.redo();
    expect(documentHash(store)).toBe(hash1);
    store.redo();
    expect(documentHash(store)).toBe(hash2);
    const p = tilesEvent?.patch.images[0];
    expect(p?.kind).toBe('tiles');
    if (p?.kind === 'tiles') {
      expect(p.before).toBe(p.before); // the list of views is stable
      expect(p.after[0]?.data).not.toBe(p.after[0]?.data); // each read is a fresh copy
      expect(p.after[0]?.data).toEqual(p.after[0]?.data);
      expect(Object.isFrozen(p.after)).toBe(true);
    }
  });
});

describe('listener re-entrancy', () => {
  it('store changes inside a listener throw TX_BUSY; every listener sees the event version', () => {
    const store = makeStore();
    paint(store, 'seed', 0, 0);
    const codes: (string | undefined)[] = [];
    const versions: number[] = [];
    store.subscribe((e) => {
      versions.push(store.version - e.version);
      codes.push(
        codeOf(() => store.begin('x')),
        codeOf(() => store.transact('x', () => 1)),
        codeOf(() => store.undo()),
        codeOf(() => store.redo()),
        codeOf(() => {
          store.clearHistory();
        }),
        codeOf(() => {
          store.setMemoryCap(1);
        }),
      );
    });
    store.subscribe((e) => versions.push(store.version - e.version));
    paint(store, 'a', 1, 1);
    store.undo();
    expect(codes.every((c) => c === 'TX_BUSY')).toBe(true);
    expect(codes).toHaveLength(12);
    expect(versions).toEqual([0, 0, 0, 0]);
    expect(store.version).toBe(3);
    expect(store.transaction).toBeUndefined();
    expect(store.historyInfo().cap).toBeGreaterThan(1);
    paint(store, 'b', 2, 2); // the store is usable again
    expect(store.version).toBe(4);
  });

  it('a listener error reaches only the caller of the change that produced the event', () => {
    const store = makeStore();
    store.subscribe((e) => {
      if (e.version === 1) throw new Error('only v1');
    });
    expect(() => {
      paint(store, 'a', 1, 1);
    }).toThrow('only v1');
    expect(() => {
      paint(store, 'b', 2, 2);
    }).not.toThrow();
    expect(() => store.undo()).not.toThrow();
    expect(store.version).toBe(3);
  });
});

describe('structural sharing of the image map', () => {
  it('reuses the map and the sorted ids unless images are created or deleted', () => {
    const store = makeStore();
    const ids0 = store.imageIds();
    const view0 = store.snapshot().images;
    store.transact('doc only', (tx) => {
      tx.set(['meta', 'name'], 'n');
    });
    expect(store.imageIds()).toBe(ids0);
    expect(store.snapshot().images).toBe(view0); // no image change: same map
    store.undo();
    store.redo();
    expect(store.imageIds()).toBe(ids0);
    expect(store.snapshot().images).toBe(view0);

    paint(store, 'pixels', 3, 3);
    expect(store.imageIds()).toBe(ids0); // same ids: cache kept
    expect(store.snapshot().images).not.toBe(view0); // but the image instance changed
    store.undo();
    expect(store.imageIds()).toBe(ids0);

    store.transact('create', (tx) => {
      tx.createImage(new TiledImage(2, 2));
    });
    expect(store.imageIds()).not.toBe(ids0);
    expect(store.imageIds()).toHaveLength(4);
    const ids1 = store.imageIds();
    store.undo();
    expect(store.imageIds()).not.toBe(ids1);
    expect(store.imageIds()).toEqual(ids0);
    store.transact('delete', (tx) => {
      tx.deleteImage(ids.imgMask);
    });
    expect(store.imageIds()).toHaveLength(2);
  });
});

describe('draft enumeration is read-only', () => {
  it('keys, descriptors, in and for-in create no copies and no child drafts', () => {
    const base = seal(makeDoc());
    if (!isContainer(base)) throw new Error('root');
    const session = openDraft<ReturnType<typeof makeDoc>>(base);
    const d = session.draft;
    expect(Object.keys(d)).toEqual(Object.keys(base));
    const forIn: string[] = [];
    for (const k in d) forIn.push(k);
    expect(forIn).toEqual(Object.keys(base));
    expect('meta' in d).toBe(true);
    expect(Reflect.ownKeys(d)).toEqual(Reflect.ownKeys(base));
    const desc = Object.getOwnPropertyDescriptor(d, 'meta');
    expect(desc?.enumerable).toBe(true);
    expect(Object.isFrozen(desc?.value)).toBe(true); // the sealed node itself, not a draft
    expect(Object.keys(d.layers)).toEqual(['0', '1']);
    expect(session.stats).toEqual({ copies: 0, childDrafts: 2 }); // root + layers (read via get)
    expect(session.finish()).toBe(base);
  });

  it('scalar-only entries and spread of an unmodified node copy nothing', () => {
    const base = seal(makeDoc());
    if (!isContainer(base)) throw new Error('root');
    const session = openDraft<ReturnType<typeof makeDoc>>(base);
    const d = session.draft;
    expect(Object.entries(d.meta.ids).length).toBe(2);
    expect({ ...d.meta.canvas }).toEqual({ w: 40, h: 36 });
    expect(session.stats.copies).toBe(0);
    expect(session.finish()).toBe(base);
  });

  it('a transaction that only scans commits nothing and keeps node identity', () => {
    const store = makeStore();
    const doc = store.doc;
    const tx = store.begin('scan');
    tx.update((d) => {
      for (const l of d.layers) Object.keys(l);
      Object.keys(d.meta);
      JSON.stringify(Object.entries(d.meta.ids));
    });
    expect(tx.doc).toBe(doc);
    expect(tx.commit()).toBeUndefined();
    expect(store.doc.layers).toBe(doc.layers);
  });

  it('reads before a write keep working: children parked before the copy are merged', () => {
    const base = seal(makeDoc());
    if (!isContainer(base)) throw new Error('root');
    const session = openDraft<ReturnType<typeof makeDoc>>(base);
    const d = session.draft;
    const meta = d.meta;
    expect(d.meta).toBe(meta); // stable draft identity while unmodified
    Object.keys(d);
    meta.canvas.w = 99; // write through a child that was read before the parent was copied
    expect(d.meta).toBe(meta);
    d.meta.name = 'z';
    const out = session.finish() as unknown as ReturnType<typeof makeDoc>;
    expect(out.meta.canvas).toEqual({ w: 99, h: 36 });
    expect(out.meta.name).toBe('z');
    expect(out.layers).toBe((base as unknown as ReturnType<typeof makeDoc>).layers);
  });
});
