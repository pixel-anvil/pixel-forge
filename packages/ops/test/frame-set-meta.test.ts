// frame.setMeta: duration, markers (merge), events (replace), root motion; defs are registered.
import { documentHash, validate } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { frameSetMeta, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection, stepLabels } from './helpers.js';

const base = { doc: HERO_ID, animation: { group: 'default' }, frame: 0 };

describe('frame.setMeta', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await openHero();
    const cases: [Record<string, unknown>, string][] = [
      [{ durationMs: 0 }, 'durationMs'],
      [{ rootMotion: { dx: 1.5, dy: 0 } }, 'rootMotion.dx'],
      [{ events: ['Footstep'] }, 'events.0'],
      [{ markers: { hand: { x: 1 } } }, 'markers.hand.y'],
    ];
    for (const [extra, path] of cases) {
      const bad = await rejection(registry.execute('frame.setMeta', { ...base, ...extra }, run));
      expect(bad.code).toBe('BAD_INPUT');
      expect(bad.details.issues).toEqual([{ path, message: expect.any(String) as string }]);
    }
    const empty = await rejection(registry.execute('frame.setMeta', base, run));
    expect(empty.code).toBe('BAD_INPUT');
    const twice = await rejection(
      registry.execute('frame.setMeta', { ...base, events: ['a', 'a'] }, run),
    );
    expect(twice.details.issues).toEqual([
      { path: 'events', message: expect.any(String) as string },
    ]);
  });

  it('runs its example as one undo step', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const out = await registry.execute('frame.setMeta', need(frameSetMeta.examples[0]).input, run);
    expect(out).toMatchObject({ frameIndex: 0, changed: ['durationMs', 'events'] });
    const anim = hero.store.doc.animations[0];
    const frame = anim !== undefined && 'frames' in anim ? anim.frames[0] : undefined;
    expect(frame).toMatchObject({ durationMs: 200, events: ['footstep'] });
    expect(hero.store.doc.eventDefs).toEqual([{ name: 'footstep' }]);
    expect(stepLabels(hero)).toEqual(['AI: frame.setMeta']);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('merges markers by name, replaces events, sets root motion; a no-op records nothing', async () => {
    const { hero, run } = await openHero();
    const set = (extra: Record<string, unknown>) =>
      registry.call('frame.setMeta', { ...base, ...extra }, run);
    const frame = () => {
      const a = hero.store.doc.animations[0];
      return need(a !== undefined && 'frames' in a ? a.frames[0] : undefined);
    };
    await set({
      markers: { hand_r: { x: 30, y: 20 }, foot: { x: 5, y: 47 } },
      rootMotion: { dx: 3, dy: -1 },
    });
    await set({ markers: { hand_r: { x: 31, y: 20 }, foot: null }, events: ['a', 'b'] });
    expect(frame()).toMatchObject({
      markers: { hand_r: { x: 31, y: 20 } },
      events: ['a', 'b'],
      rootMotion: { dx: 3, dy: -1 },
    });
    expect(Object.keys(frame().markers)).toEqual(['hand_r']);
    expect(hero.store.doc.markerDefs.map((m) => m.name)).toEqual(['foot', 'hand_r']);
    const same = await set({ markers: { hand_r: { x: 31, y: 20 } }, events: ['a', 'b'] });
    expect(same).toMatchObject({ ok: true, output: { changed: [] }, doc: { undoEntry: null } });
    await set({ events: [] });
    expect(frame().events).toEqual([]);
    expect(validate(hero.store).filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('refuses a mirror animation and an unknown frame', async () => {
    const { run } = await openHero();
    await registry.execute(
      'rig.mirrorAnimation',
      { doc: HERO_ID, source: { group: 'default' }, direction: 'left' },
      run,
    );
    const mirror = await rejection(
      registry.execute(
        'frame.setMeta',
        { ...base, animation: { group: 'default', direction: 'left' }, durationMs: 50 },
        run,
      ),
    );
    expect(mirror).toMatchObject({ code: 'REFUSED', details: { reason: 'mirror-animation' } });
    const frame = await rejection(
      registry.execute('frame.setMeta', { ...base, frame: 9, durationMs: 5 }, run),
    );
    expect(frame).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'frame' } });
  });
});
