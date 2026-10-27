import { describe, expect, it } from 'vitest';
import { AnimRef, FrameRef } from '../src/index.js';
import { ids } from './fixtures/src/minimal-doc.js';

describe('AnimRef', () => {
  it('accepts {group, direction?} and {id}', () => {
    expect(AnimRef.parse({ group: 'run', direction: 'side' })).toEqual({
      group: 'run',
      direction: 'side',
    });
    expect(AnimRef.parse({ group: 'idle' })).toEqual({ group: 'idle' });
    expect(AnimRef.parse({ id: ids.animRunRight })).toEqual({ id: ids.animRunRight });
  });

  it('rejects mixed, malformed and bare forms', () => {
    for (const bad of [
      { group: 'run', id: ids.animRunRight },
      { group: 'Run' },
      { group: 'run', direction: 'default' },
      { id: ids.frame0 },
      {},
      ids.animRunRight,
    ]) {
      expect(AnimRef.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('FrameRef', () => {
  it('accepts a 0-based index or a frame id', () => {
    expect(FrameRef.parse(0)).toBe(0);
    expect(FrameRef.parse(11)).toBe(11);
    expect(FrameRef.parse(ids.frame1)).toBe(ids.frame1);
  });

  it('rejects negative or fractional indices and other ids', () => {
    for (const bad of [-1, 1.5, Number.NaN, '3', ids.animRunRight]) {
      expect(FrameRef.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});
