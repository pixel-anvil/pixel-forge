import { TiledImage } from '@pixel-forge/raster';
import type { Document } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { documentHash } from '../src/index.js';
import type { Transaction } from '../src/index.js';
import { authored, blankFrame, codeOf, ids, makeDoc, makeStore } from './helpers.js';

/** Runs `recipe` in its own transaction and returns the committed structural ops. */
function opsOf(recipe: (d: Document, tx: Transaction) => void) {
  const store = makeStore();
  const before = store.doc;
  const ev = store.transact('t', (tx) => {
    tx.update((d) => {
      recipe(d, tx);
    });
    return tx.commit();
  });
  return { store, before, ops: ev?.patch.ops ?? [] };
}

describe('update recipes (copy-on-write drafts)', () => {
  it('copies only the written path and shares everything else', () => {
    const { store, before, ops } = opsOf((d) => {
      d.meta.name = 'shared';
    });
    expect(ops).toEqual([
      { op: 'replace', path: ['meta', 'name'], before: 'test', after: 'shared' },
    ]);
    expect(store.doc.meta).not.toBe(before.meta);
    expect(store.doc.meta.canvas).toBe(before.meta.canvas);
    expect(store.doc.layers).toBe(before.layers);
    expect(store.doc.animations).toBe(before.animations);
  });

  it('reads without writing change nothing and keep identity', () => {
    const store = makeStore();
    const doc = store.doc;
    const tx = store.begin('read only');
    tx.update((d) => {
      expect(d.layers.length).toBe(2);
      expect(d.layers.map((l) => l.name)).toEqual(['bg', 'fx']);
      expect(Array.isArray(d.layers)).toBe(true);
      expect(d.layers instanceof Array).toBe(true);
      expect('meta' in d).toBe(true);
      expect('nope' in d).toBe(false);
      expect(Object.keys(d.meta)).toEqual(Object.keys(doc.meta));
      expect(JSON.stringify(d)).toBe(JSON.stringify(doc));
      expect({ ...d.meta.canvas }).toEqual({ w: 40, h: 36 });
      expect([...d.markerDefs]).toEqual([{ name: 'hand_r' }]);
      expect(Object.getOwnPropertyDescriptor(d.markerDefs, 'length')?.value).toBe(1);
      expect(Object.getOwnPropertyDescriptor(d.meta, 'missing')).toBeUndefined();
      d.meta.name = 'test'; // same value: no write
      const l0 = d.layers[0];
      if (l0 !== undefined) d.layers[0] = l0; // same draft: no write
    });
    expect(tx.doc).toBe(doc);
    expect(tx.commit()).toBeUndefined();
  });

  it('one insertion, deletion or move gives minimal operations', () => {
    const frame = blankFrame(ids.frame0); // placeholder id, replaced below
    const ins = opsOf((d, tx) => {
      authored(d).frames.splice(1, 0, { ...frame, id: tx.newId('frame') });
    });
    expect(ins.ops.map((o) => [o.op, o.path])).toEqual([
      ['add', ['animations', 0, 'frames', 1]],
      ['replace', ['meta', 'ids', 'next']],
    ]);
    const del = opsOf((d) => {
      authored(d).frames.splice(0, 1);
    });
    expect(del.ops).toEqual([
      {
        op: 'remove',
        path: ['animations', 0, 'frames', 0],
        before:
          del.before.animations[0] && 'frames' in del.before.animations[0]
            ? del.before.animations[0].frames[0]
            : null,
      },
    ]);
    // Reordering frames replaces whole elements (their ids differ) and keeps the frame objects.
    const rev = opsOf((d) => {
      authored(d).frames.reverse();
    });
    expect(rev.ops.map((o) => [o.op, o.path])).toEqual([
      ['replace', ['animations', 0, 'frames', 0]],
      ['replace', ['animations', 0, 'frames', 1]],
    ]);
    const a0 = rev.store.doc.animations[0];
    const b0 = rev.before.animations[0];
    expect(a0 && 'frames' in a0 && b0 && 'frames' in b0 && a0.frames[0] === b0.frames[1]).toBe(
      true,
    );
    const sorted = opsOf((d) => {
      authored(d).frames.sort((x, y) => y.durationMs - x.durationMs);
    });
    expect(sorted.ops).toHaveLength(2);
    const pushed = opsOf((d) => {
      d.eventDefs.push({ name: 'land' });
      authored(d).frames[1]?.events.push('step');
    });
    expect(pushed.ops.map((o) => [o.op, o.path])).toEqual([
      ['add', ['animations', 0, 'frames', 1, 'events', 0]],
      ['add', ['eventDefs', 1]],
    ]);
  });

  it('deletes optional keys and record entries', () => {
    const { ops, store } = opsOf((d) => {
      delete d.activePaletteId;
      const bg = d.layers[0];
      if (bg?.kind === 'pixel') Reflect.deleteProperty(bg.cels, ids.frame1);
      delete (d.meta as unknown as Record<string, unknown>).notThere;
    });
    expect(ops.map((o) => [o.op, o.path])).toEqual([
      ['remove', ['activePaletteId']],
      ['remove', ['layers', 0, 'cels', ids.frame1]],
    ]);
    expect('activePaletteId' in store.doc).toBe(false);
  });

  it('assigning new plain values (also holding drafts) seals them; aliasing keeps value semantics', () => {
    const { store } = opsOf((d) => {
      const raw = { name: 'jump' };
      d.eventDefs.push(raw);
      raw.name = 'jump2'; // still a raw value until the recipe ends: the edit is kept
      d.markerDefs.push(d.markerDefs[0] ?? { name: 'x' }); // the same draft at two places
      const m = d.markerDefs[0];
      if (m !== undefined) m.description = 'right hand';
      d.directionFallback = { up: ['up', 'side'] };
    });
    expect(store.doc.eventDefs[1]).toEqual({ name: 'jump2' });
    expect(Object.isFrozen(store.doc.eventDefs[1])).toBe(true);
    expect(store.doc.markerDefs).toEqual([
      { name: 'hand_r', description: 'right hand' },
      { name: 'hand_r', description: 'right hand' },
    ]);
    expect(store.doc.directionFallback).toEqual({ up: ['up', 'side'] });
  });

  it('newId and image calls work inside a recipe; other tx calls throw TX_BUSY and abort', () => {
    const store = makeStore();
    store.transact('inside', (tx) => {
      tx.update((d) => {
        const imageId = tx.createImage(new TiledImage(2, 2));
        tx.writeImage(imageId, (img) => (img as TiledImage).set(0, 0, [1, 2, 3, 4]));
        const layerId = tx.newId('layer');
        d.layers.push({
          kind: 'pixel',
          id: layerId,
          name: 'extra',
          visible: true,
          opacity: 255,
          export: true,
          cels: { [ids.frame0]: { imageId, offset: { x: 0, y: 0 }, opacity: 255 } },
        });
      });
    });
    expect(store.doc.layers).toHaveLength(3);
    const busy: ((tx: Transaction) => void)[] = [
      (tx) => {
        tx.set(['meta', 'name'], 'x');
      },
      (tx) => {
        tx.insert(['eventDefs', 0], { name: 'x' });
      },
      (tx) => {
        tx.remove(['eventDefs', 0]);
      },
      (tx) => {
        tx.update(() => undefined);
      },
      (tx) => tx.commit(),
    ];
    for (const call of busy) {
      const tx = store.begin('busy');
      const caught: string[] = [];
      expect(
        codeOf(() => {
          tx.update((d) => {
            d.meta.name = 'never';
            // Even a recipe that swallows the error aborts the transaction.
            caught.push(
              codeOf(() => {
                call(tx);
              }) ?? '',
            );
          });
        }),
      ).toBe('TX_BUSY');
      expect(caught).toEqual(['TX_BUSY']);
      expect(tx.isOpen).toBe(false);
    }
    expect(store.doc.meta.name).toBe('test');
  });

  it('rejects non-JSON edits with BAD_VALUE and aborts, even when the recipe catches the error', () => {
    const store = makeStore();
    const h = documentHash(store);
    const bad: ((d: Document) => void)[] = [
      (d) => {
        (d.meta as unknown as Record<string, unknown>).name = undefined;
      },
      (d) => {
        (d.layers as unknown as Record<string, unknown>).foo = 1;
      },
      (d) => {
        (d.meta as unknown as Record<symbol, unknown>)[Symbol('s')] = 1;
      },
      (d) => {
        (d.meta as unknown as Record<string, unknown>).__proto__ = {};
      },
      (d) => {
        Object.freeze(d.meta);
      },
      (d) => {
        Object.setPrototypeOf(d.meta, null);
      },
      (d) => {
        Object.defineProperty(d.meta, 'x', { get: () => 1 });
      },
    ];
    for (const f of bad) {
      const tx = store.begin('bad');
      expect(
        codeOf(() => {
          tx.update((d) => {
            try {
              f(d);
            } catch {
              // swallowed on purpose
            }
          });
        }),
      ).toBe('BAD_VALUE');
      expect(tx.isOpen).toBe(false);
    }
    // Errors found when sealing the result.
    const atFinish: ((d: Document) => void)[] = [
      (d) => {
        (d.markerDefs as unknown[])[3] = { name: 'hole' };
      },
      (d) => {
        const meta = d.meta as unknown as Record<string, unknown>;
        meta.self = d.meta;
      },
      (d) => {
        (d.meta as unknown as Record<string, unknown>).when = new Date(0);
      },
      (d) => {
        (d.meta as unknown as Record<string, unknown>).n = Number.POSITIVE_INFINITY;
      },
      (d) => {
        d.markerDefs.length = 3;
      },
    ];
    for (const f of atFinish) {
      const tx = store.begin('bad at finish');
      expect(
        codeOf(() => {
          tx.update(f);
        }),
      ).toBe('BAD_VALUE');
      expect(tx.isOpen).toBe(false);
    }
    expect(documentHash(store)).toBe(h);
  });

  it('defineProperty with a plain value is an assignment', () => {
    const { store } = opsOf((d) => {
      Object.defineProperty(d.meta, 'name', {
        value: 'defined',
        writable: true,
        enumerable: true,
        configurable: true,
      });
    });
    expect(store.doc.meta.name).toBe('defined');
  });

  it('revokes drafts when the recipe returns, and rejects async recipes', () => {
    const store = makeStore();
    let leaked: { name: string } | undefined;
    store.transact('leak', (tx) => {
      tx.update((d) => {
        leaked = d.meta;
      });
    });
    expect(() => leaked?.name).toThrow(TypeError);
    const tx = store.begin('async');
    expect(
      codeOf(() => {
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- testing the TX_ASYNC guard
        tx.update(() => Promise.resolve());
      }),
    ).toBe('TX_ASYNC');
    expect(tx.isOpen).toBe(false);
  });

  it('a recipe that throws leaves the working copy unchanged and aborts', () => {
    const store = makeStore();
    const tx = store.begin('throws');
    tx.set(['meta', 'name'], 'kept?');
    expect(() => {
      tx.update((d) => {
        d.meta.name = 'half';
        throw new Error('stop');
      });
    }).toThrow('stop');
    expect(tx.isOpen).toBe(false);
    expect(store.doc).toEqual(makeDoc());
  });
});
