// doc.setColorMode: exact conversion both ways, the palette lock, refusals that change nothing.
import { documentHash, imageHash, renderFrame } from '@pixel-forge/core';
import type { DocumentStore } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { docSetColorMode, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

/** Adds an active palette holding exactly the opaque colours of every stored image (plus alpha 0). */
function addPalette(store: DocumentStore, extra: readonly number[][] = []): number {
  const seen = new Map<string, [number, number, number, number]>();
  for (const id of store.imageIds()) {
    const img = store.image(id) as { toRGBA?: () => { data: Uint8Array } } | undefined;
    const data = img?.toRGBA?.().data;
    if (data === undefined) continue;
    for (let o = 0; o < data.length; o += 4) {
      if (data[o + 3] === 0) continue;
      const c: [number, number, number, number] = [
        data[o] ?? 0,
        data[o + 1] ?? 0,
        data[o + 2] ?? 0,
        data[o + 3] ?? 0,
      ];
      seen.set(c.join(','), c);
    }
  }
  const colors = [[0, 0, 0, 0] as [number, number, number, number], ...seen.values()];
  for (const e of extra) colors.push(e as [number, number, number, number]);
  store.transact('palette', (tx) => {
    const id = tx.newId('palette');
    tx.update((d) => {
      d.palettes.push({ id, name: 'test', colors, ramps: [] });
      d.activePaletteId = id;
    });
  });
  return colors.length;
}

describe('doc.setColorMode', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const none = await rejection(registry.execute('doc.setColorMode', { doc: HERO_ID }, run));
    expect(none.code).toBe('BAD_INPUT');
    const bad = await rejection(
      registry.execute('doc.setColorMode', { doc: HERO_ID, colorMode: 'cmyk' }, run),
    );
    expect(bad.details.issues).toEqual([
      { path: 'colorMode', message: expect.any(String) as string },
    ]);
  });

  it('runs its example (lock to the palette) as one undo step', async () => {
    const { hero, run } = await openHero();
    addPalette(hero.store);
    const before = documentHash(hero.store);
    const out = await registry.execute(
      'doc.setColorMode',
      need(docSetColorMode.examples[0]).input,
      run,
    );
    expect(out).toEqual({ colorMode: 'rgba', paletteLocked: true, converted: 0 });
    expect(hero.store.historyInfo().entries.map((e) => e.label)).toEqual([
      'palette',
      'AI: doc.setColorMode',
    ]);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('converts to indexed and back without changing a rendered pixel', async () => {
    const { hero, host, run } = await openHero();
    addPalette(hero.store);
    const render = (): string =>
      imageHash(renderFrame(hero.store, { group: 'default' }, 0, { rig: host.renderer }));
    const rgba = render();
    const out = (await registry.execute(
      'doc.setColorMode',
      { doc: HERO_ID, colorMode: 'indexed' },
      run,
    )) as { converted: number };
    expect(out.converted).toBeGreaterThan(10);
    expect(hero.store.doc.meta.colorMode).toBe('indexed');
    expect(render()).toBe(rgba);
    const lint = await registry.execute(
      'lint.run',
      { doc: HERO_ID, enable: ['palette.offPalette'] },
      run,
    );
    expect(lint).toMatchObject({ count: 0 });
    await registry.execute('doc.setColorMode', { doc: HERO_ID, colorMode: 'rgba' }, run);
    expect(hero.store.doc.meta.colorMode).toBe('rgba');
    expect(render()).toBe(rgba);
    // no orphan images were left behind
    expect(
      (await registry.execute('lint.run', { doc: HERO_ID }, run)) as { count: number },
    ).toMatchObject({ count: 0 });
  });

  it('refuses without a palette, with a colour the palette lacks, and without transparency', async () => {
    const { hero, run } = await openHero();
    const hash = documentHash(hero.store);
    const noPalette = await rejection(
      registry.execute('doc.setColorMode', { doc: HERO_ID, colorMode: 'indexed' }, run),
    );
    expect(noPalette).toMatchObject({ code: 'REFUSED', details: { reason: 'no-palette' } });
    const lock = await rejection(
      registry.execute('doc.setColorMode', { doc: HERO_ID, paletteLocked: true }, run),
    );
    expect(lock.details.reason).toBe('no-palette');
    // a palette that lacks one hero colour
    addPalette(hero.store);
    hero.store.transact('drop a colour', (tx) => {
      tx.update((d) => {
        d.palettes[0]?.colors.pop();
      });
    });
    const missing = await rejection(
      registry.execute('doc.setColorMode', { doc: HERO_ID, colorMode: 'indexed' }, run),
    );
    expect(missing).toMatchObject({ code: 'INVALID_VALUE', details: { reason: 'not-indexable' } });
    hero.store.transact('no transparency', (tx) => {
      tx.update((d) => {
        const p = d.palettes[0];
        if (p !== undefined) p.colors = p.colors.slice(1);
      });
    });
    const opaque = await rejection(
      registry.execute('doc.setColorMode', { doc: HERO_ID, colorMode: 'indexed' }, run),
    );
    expect(opaque).toMatchObject({ code: 'REFUSED', details: { reason: 'bad-palette' } });
    expect(hero.store.doc.meta.colorMode).toBe('rgba');
    expect(hash).not.toBe(documentHash(hero.store)); // only the palette edits above changed it
  });

  it('records nothing for a no-op', async () => {
    const { hero, run } = await openHero();
    const result = await registry.call(
      'doc.setColorMode',
      { doc: HERO_ID, colorMode: 'rgba', paletteLocked: false },
      run,
    );
    expect(result).toMatchObject({ ok: true, doc: { undoEntry: null } });
    expect(hero.store.historyInfo().entries).toHaveLength(0);
  });
});
