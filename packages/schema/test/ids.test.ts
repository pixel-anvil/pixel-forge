import { describe, expect, it } from 'vitest';
import {
  ID_PREFIXES,
  ID_SCHEMAS,
  ID_SPACE,
  IdState,
  NAME_REGEX,
  createIdGenerator,
  makeId,
  type IdKind,
} from '../src/index.js';

const KINDS = Object.keys(ID_PREFIXES) as IdKind[];
const GENERATED = /^[a-z]{3}_[0-9a-hjkmnp-tv-z]{6}$/;

const sequence = (seed: number, n: number): string[] => {
  const gen = createIdGenerator({ seed, next: 0 });
  return Array.from({ length: n }, () => gen.next('frame'));
};

describe('makeId / createIdGenerator', () => {
  it('is deterministic for a given seed', () => {
    expect(sequence(42, 64)).toEqual(sequence(42, 64));
    expect(makeId('layer', 7, 123)).toBe(makeId('layer', 7, 123));
  });

  it('pins the id format (changing it changes every generated fixture)', () => {
    expect(sequence(0, 3)).toEqual(['frm_m2q99t', 'frm_r8wqxb', 'frm_pn9r62']);
    expect(makeId('layer', 42, 0)).toBe('lay_qzpx4z');
  });

  it('equals a BigInt reference of the documented modular arithmetic', () => {
    const M = 1n << 30n;
    const ref = (seed: number, counter: number): string => {
      const s = BigInt(seed);
      let x = (BigInt(counter) + 0x1b873593n) % M;
      x ^= s;
      x = (x * 0x2c1b3c6dn) % M;
      x ^= x >> 15n;
      x = (x + s) % M;
      x = (x * 0x297a2d39n) % M;
      x ^= x >> 13n;
      return x.toString(32).padStart(6, '0');
    };
    const crockford = (body: string): string =>
      body.replace(/[0-9a-v]/g, (c) => '0123456789abcdefghjkmnpqrstvwxyz'.charAt(parseInt(c, 32)));
    let state = 12345;
    for (let i = 0; i < 500; i++) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      const seed = state % ID_SPACE;
      const counter = (state >>> 2) % ID_SPACE;
      expect(makeId('frame', seed, counter)).toBe(`frm_${crockford(ref(seed, counter))}`);
    }
  });

  it('matches the generator sequence and only the prefix depends on the kind', () => {
    const gen = createIdGenerator({ seed: 9, next: 0 });
    for (let counter = 0; counter < 20; counter++) {
      const kind = KINDS[counter % KINDS.length] ?? 'doc';
      const id = gen.next(kind);
      expect(id).toBe(makeId(kind, 9, counter));
      expect(id.slice(4)).toBe(makeId('doc', 9, counter).slice(4));
    }
  });

  it('gives different sequences for different seeds', () => {
    const a = sequence(0, 16);
    const b = sequence(1, 16);
    const c = sequence(42, 16);
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
    expect(a.filter((id) => b.includes(id)).length).toBeLessThan(2);
  });

  it('never repeats an id under one seed', () => {
    const seen = new Set<string>();
    const n = 200_000;
    for (let counter = 0; counter < n; counter++) seen.add(makeId('frame', 42, counter));
    expect(seen.size).toBe(n);
  });

  it('writes ids that are short, base32, valid names and valid for their kind only', () => {
    for (const kind of KINDS) {
      const id = makeId(kind, 5, 77);
      expect(id).toMatch(GENERATED);
      expect(id).toMatch(NAME_REGEX);
      expect(id.startsWith(`${ID_PREFIXES[kind]}_`)).toBe(true);
      for (const other of KINDS) {
        expect(ID_SCHEMAS[other].safeParse(id).success).toBe(other === kind);
      }
    }
    expect(makeId('image', ID_SPACE - 1, ID_SPACE - 1)).toMatch(GENERATED);
  });

  it('resumes from a saved state', () => {
    const gen = createIdGenerator({ seed: 3, next: 0 });
    const first = [gen.next('bone'), gen.next('bone')];
    const saved = gen.state();
    expect(saved).toEqual({ seed: 3, next: 2 });
    expect(IdState.parse(saved)).toEqual(saved);
    const rest = [gen.next('bone'), gen.next('bone')];
    const resumed = createIdGenerator(saved);
    expect([...first, resumed.next('bone'), resumed.next('bone')]).toEqual([...first, ...rest]);
  });

  it('rejects out-of-range seeds and counters', () => {
    expect(() => makeId('doc', -1, 0)).toThrow(RangeError);
    expect(() => makeId('doc', ID_SPACE, 0)).toThrow(RangeError);
    expect(() => makeId('doc', 1.5, 0)).toThrow(RangeError);
    expect(() => makeId('doc', 0, ID_SPACE)).toThrow(RangeError);
    expect(() => createIdGenerator({ seed: 0, next: -1 })).toThrow(RangeError);
    expect(() => createIdGenerator({ seed: 0, next: ID_SPACE + 1 })).toThrow(RangeError);
    expect(() => createIdGenerator({ seed: -2, next: 0 })).toThrow(RangeError);
  });

  it('throws once the counter is exhausted', () => {
    const gen = createIdGenerator({ seed: 0, next: ID_SPACE - 1 });
    expect(gen.next('frame')).toMatch(GENERATED);
    expect(gen.state().next).toBe(ID_SPACE);
    expect(() => gen.next('frame')).toThrow(RangeError);
  });

  it('accepts hand-written ids and rejects malformed ones', () => {
    expect(ID_SCHEMAS.layer.safeParse('lay_body').success).toBe(true);
    for (const bad of [
      'lay_',
      'lay-abc',
      'LAY_abc',
      'lay_ABC',
      'lay_a_b',
      `lay_${'a'.repeat(25)}`,
      7,
    ]) {
      expect(ID_SCHEMAS.layer.safeParse(bad).success).toBe(false);
    }
  });

  it('validates the persisted state', () => {
    expect(IdState.safeParse({ seed: 0, next: ID_SPACE }).success).toBe(true);
    expect(IdState.safeParse({ seed: ID_SPACE, next: 0 }).success).toBe(false);
    expect(IdState.safeParse({ seed: 0, next: 0.5 }).success).toBe(false);
    expect(IdState.safeParse({ seed: 0, next: 0, extra: 1 }).success).toBe(false);
  });
});
