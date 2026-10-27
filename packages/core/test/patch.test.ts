import { createHash } from 'node:crypto';
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { describe, expect, it } from 'vitest';
import {
  DocumentStore,
  canonicalJson,
  documentCanonical,
  documentHash,
  estimateJsonBytes,
  getAt,
  imageHash,
  invertOp,
  invertOps,
  isSealed,
  jsonEqual,
} from '../src/index.js';
import type { JsonValue, StructuralOp } from '../src/index.js';
import { applyOps, diff } from '../src/patch.js';
import { seal } from '../src/json.js';
import { utf8 } from '../src/hash.js';
import { codeOf, ids, int, makeDoc, makeImages, rng } from './helpers.js';

/** A random JSON tree; objects sometimes carry an `id`, like domain entities. */
function randomJson(r: () => number, depth: number): JsonValue {
  const k = int(r, depth <= 0 ? 4 : 7);
  switch (k) {
    case 0:
      return null;
    case 1:
      return r() < 0.5;
    case 2:
      return int(r, 5);
    case 3:
      return ['a', 'b', 'c', 'é', '😀'][int(r, 5)] ?? 'a';
    case 4:
    case 5: {
      const n = int(r, 5);
      return Array.from({ length: n }, () => randomJson(r, depth - 1));
    }
    default: {
      const o: Record<string, JsonValue> = {};
      if (r() < 0.3) o.id = `id${String(int(r, 3))}`;
      const n = int(r, 4);
      for (let i = 0; i < n; i++)
        o[['x', 'y', 'z', 'w'][int(r, 4)] ?? 'x'] = randomJson(r, depth - 1);
      return o;
    }
  }
}

/** A random edit of `v` (a deep, independent copy is returned). */
function mutate(r: () => number, v: JsonValue, depth: number): JsonValue {
  const c = JSON.parse(JSON.stringify(v)) as JsonValue;
  const edit = (node: JsonValue, d: number): JsonValue => {
    if (node === null || typeof node !== 'object' || d <= 0 || r() < 0.3) {
      return r() < 0.5 ? randomJson(r, 2) : node;
    }
    if (Array.isArray(node)) {
      const arr = [...(node as JsonValue[])];
      const choice = int(r, 4);
      if (choice === 0) arr.splice(int(r, arr.length + 1), 0, randomJson(r, 2));
      else if (choice === 1 && arr.length > 0) arr.splice(int(r, arr.length), 1);
      else if (choice === 2 && arr.length > 1) arr.reverse();
      else if (arr.length > 0) {
        const i = int(r, arr.length);
        arr[i] = edit(arr[i] as JsonValue, d - 1);
      }
      return arr;
    }
    const o = { ...(node as Record<string, JsonValue>) };
    const keys = Object.keys(o);
    const choice = int(r, 3);
    if (choice === 0 || keys.length === 0) o[['x', 'y', 'q'][int(r, 3)] ?? 'q'] = randomJson(r, 2);
    else if (choice === 1) Reflect.deleteProperty(o, keys[int(r, keys.length)] ?? '');
    else {
      const k = keys[int(r, keys.length)] ?? '';
      o[k] = edit(o[k] as JsonValue, d - 1);
    }
    return o;
  };
  return edit(c, depth);
}

describe('diff / applyOps / invert (property)', () => {
  it('apply(diff(a, b)) = b and apply(invert) = a, for 3000 random trees', () => {
    const r = rng(1234);
    for (let i = 0; i < 3000; i++) {
      const a = seal(randomJson(r, 4));
      const b = seal(mutate(r, a, 4));
      const ops: StructuralOp[] = [];
      diff(a, b, [], ops);
      if (jsonEqual(a, b)) expect(ops).toEqual([]);
      const forward = applyOps(a, ops, true);
      expect(jsonEqual(forward, b)).toBe(true);
      expect(isSealed(forward) || forward === null || typeof forward !== 'object').toBe(true);
      const back = applyOps(forward, invertOps(ops), true);
      expect(jsonEqual(back, a)).toBe(true);
      expect(canonicalJson(back)).toBe(canonicalJson(a));
    }
  });

  it('a single insertion or deletion is one operation; id changes replace whole elements', () => {
    const a = seal([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const ops: StructuralOp[] = [];
    diff(a, seal([{ id: 1 }, { id: 9 }, { id: 2 }, { id: 3 }]), [], ops);
    expect(ops).toEqual([{ op: 'add', path: [1], after: { id: 9 } }]);
    ops.length = 0;
    diff(a, seal([{ id: 1 }, { id: 3 }]), [], ops);
    expect(ops).toEqual([{ op: 'remove', path: [1], before: { id: 2 } }]);
    ops.length = 0;
    diff(a, seal([{ id: 1 }, { id: 2, x: 5 }, { id: 3 }]), [], ops);
    expect(ops).toEqual([{ op: 'add', path: [1, 'x'], after: 5 }]);
    ops.length = 0;
    diff(seal([{ id: 1 }, { id: 2 }]), seal([{ id: 2 }, { id: 1 }]), [], ops);
    expect(ops.map((o) => o.op)).toEqual(['replace', 'replace']);
    ops.length = 0;
    diff(seal({ a: [1] }), seal({ a: { 0: 1 } }), [], ops);
    expect(ops).toEqual([{ op: 'replace', path: ['a'], before: [1], after: { 0: 1 } }]);
    ops.length = 0;
    diff(seal([1, 2, 3, 4]), seal([1, 4]), [], ops);
    expect(ops).toEqual([
      { op: 'remove', path: [1], before: 2 },
      { op: 'remove', path: [1], before: 3 },
    ]);
  });

  it('inverts each kind of operation', () => {
    expect(invertOp({ op: 'add', path: ['a'], after: 1 })).toEqual({
      op: 'remove',
      path: ['a'],
      before: 1,
    });
    expect(invertOp({ op: 'remove', path: ['a'], before: 1 })).toEqual({
      op: 'add',
      path: ['a'],
      after: 1,
    });
    expect(invertOp({ op: 'replace', path: [], before: 1, after: 2 })).toEqual({
      op: 'replace',
      path: [],
      before: 2,
      after: 1,
    });
  });

  it('strict application detects conflicts', () => {
    const root = seal({ a: 1, list: [1, 2], o: { k: 'v' } });
    const conflict = (ops: StructuralOp[]) => codeOf(() => applyOps(root, ops, true));
    expect(conflict([{ op: 'replace', path: ['a'], before: 2, after: 3 }])).toBe('PATCH_CONFLICT');
    expect(conflict([{ op: 'add', path: ['a'], after: 3 }])).toBe('PATCH_CONFLICT');
    expect(conflict([{ op: 'remove', path: ['zz'], before: 3 }])).toBe('PATCH_CONFLICT');
    expect(conflict([{ op: 'remove', path: ['list', 0], before: 9 }])).toBe('PATCH_CONFLICT');
    expect(conflict([{ op: 'remove', path: ['list', 5], before: 9 }])).toBe('PATCH_CONFLICT');
    expect(conflict([{ op: 'add', path: ['list', 'x'], after: 9 }])).toBe('PATCH_CONFLICT');
    expect(conflict([{ op: 'add', path: ['o', 0], after: 9 }])).toBe('PATCH_CONFLICT');
    expect(conflict([{ op: 'add', path: ['a', 'b'], after: 9 }])).toBe('PATCH_CONFLICT');
    expect(conflict([{ op: 'add', path: [], after: 9 }])).toBe('PATCH_CONFLICT');
    expect(conflict([{ op: 'replace', path: [], before: 9, after: 9 }])).toBe('PATCH_CONFLICT');
    expect(codeOf(() => applyOps(seal(5), [{ op: 'add', path: ['a'], after: 9 }], false))).toBe(
      'BAD_PATH',
    );
    expect(applyOps(root, [{ op: 'replace', path: [], before: root, after: 7 }], true)).toBe(7);
    // Containers on the path are copied once per call, and everything else is shared.
    const out = applyOps(
      root,
      [
        { op: 'add', path: ['list', 2], after: 3 },
        { op: 'add', path: ['list', 3], after: 4 },
      ],
      true,
    ) as { list: number[]; o: object };
    expect(out.list).toEqual([1, 2, 3, 4]);
    expect(out.o).toBe((root as { o: object }).o);
    expect(Object.isFrozen(out.list)).toBe(true);
  });
});

describe('json helpers', () => {
  it('seal freezes deeply, reuses sealed nodes and rejects non-JSON', () => {
    const inner = seal({ x: [1, 2] });
    const outer = seal({ inner, y: 'z' }) as { inner: unknown };
    expect(outer.inner).toBe(inner);
    expect(isSealed(outer)).toBe(true);
    expect(isSealed({})).toBe(false);
    expect(seal(Object.create(null) as object)).toEqual({});
    expect(codeOf(() => seal(1n))).toBe('BAD_VALUE');
    expect(codeOf(() => seal(undefined))).toBe('BAD_VALUE');
  });

  it('jsonEqual ignores key order; canonicalJson sorts keys', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
    expect(jsonEqual([1, 2], [1, 3])).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
    expect(jsonEqual([1], [1, 2])).toBe(false);
    expect(jsonEqual(1, '1')).toBe(false);
    expect(canonicalJson({ b: 1, a: [true, null, 'x"y'] })).toBe('{"a":[true,null,"x\\"y"],"b":1}');
  });

  it('getAt reads own properties only', () => {
    const v = seal({ a: [10, { b: 2 }] });
    expect(getAt(v, ['a', 1, 'b'])).toBe(2);
    expect(getAt(v, ['a', 5])).toBeUndefined();
    expect(getAt(v, ['a', 'length'])).toBeUndefined();
    expect(getAt(v, ['constructor'])).toBeUndefined();
    expect(getAt(v, ['a', 0, 'x'])).toBeUndefined();
    expect(getAt(v, [])).toBe(v);
  });

  it('estimates JSON sizes with the documented formula', () => {
    expect(estimateJsonBytes(null)).toBe(8);
    expect(estimateJsonBytes('abc')).toBe(22);
    expect(estimateJsonBytes([1, true])).toBe(16 + 16 + 16);
    const o = seal({ ab: 'c' });
    expect(estimateJsonBytes(o)).toBe(16 + 16 + 4 + 18);
    expect(estimateJsonBytes(o)).toBe(16 + 16 + 4 + 18); // memoised
  });
});

describe('documentHash', () => {
  it('is SHA-256 of the canonical text, independent of key order and tile allocation', () => {
    const a = new DocumentStore(makeDoc(), { images: makeImages() });
    const reordered = JSON.parse(
      JSON.stringify(makeDoc(), (_k, v: unknown) =>
        v !== null && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    ) as ReturnType<typeof makeDoc>;
    const images = makeImages();
    const bg = images[0]?.[1] as TiledImage;
    bg.set(30, 30, [1, 1, 1, 1]);
    bg.set(30, 30, [0, 0, 0, 0]); // an allocated but empty tile
    const b = new DocumentStore(reordered, { images });
    expect(Object.keys(b.doc)[0]).not.toBe(Object.keys(a.doc)[0]);
    expect(documentHash(b)).toBe(documentHash(a));
    const text = documentCanonical(a);
    expect(documentHash(a)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    expect(text).toContain(`"${ids.imgMask}":{"hash":"`);
    expect(text).toContain('"kind":"indexed"');
  });

  it('changes with any pixel, any JSON value, and the image kind', () => {
    const base = documentHash(new DocumentStore(makeDoc(), { images: makeImages() }));
    const images = makeImages();
    (images[1]?.[1] as TiledImage).set(0, 7, [0, 0, 0, 1]);
    expect(documentHash(new DocumentStore(makeDoc(), { images }))).not.toBe(base);
    const doc = makeDoc();
    doc.meta.pixelsPerUnit = 17;
    expect(documentHash(new DocumentStore(doc, { images: makeImages() }))).not.toBe(base);
    const rgbaMask = makeImages().map(([id, img]): [typeof id, TiledImage | IndexedImage] =>
      id === ids.imgMask ? [id, new TiledImage(20, 20)] : [id, img],
    );
    expect(documentHash(new DocumentStore(makeDoc(), { images: rgbaMask }))).not.toBe(base);
    const idx = new IndexedImage(4, 4, 2);
    expect(imageHash(idx)).toBe(imageHash(idx)); // memoised
    expect(imageHash(idx)).not.toBe(imageHash(new IndexedImage(4, 4, 3)));
  });

  it('throws IMAGE_MISSING for a view that lists an absent image', () => {
    const store = new DocumentStore(makeDoc(), { images: makeImages() });
    const view = { doc: store.doc, imageIds: () => [ids.imgBg], image: () => undefined };
    expect(codeOf(() => documentHash(view))).toBe('IMAGE_MISSING');
  });

  it('utf8 matches TextEncoder, including astral and lone surrogates', () => {
    for (const s of ['', 'abc', 'é', '€', '😀', 'a\ud800b', '\udc00', 'x\ud83d', '߿ࠀ￿']) {
      expect([...utf8(s)]).toEqual([...new TextEncoder().encode(s)]);
    }
  });
});
