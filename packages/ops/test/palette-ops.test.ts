// palette.edit, palette.sort, palette.ramp: palette changes that keep the render, refusals that change nothing.
import { documentHash, imageHash, renderFrame } from '@pixel-forge/core';
import type { DocumentStore } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry } from '../src/index.js';
import { HERO_ID, openHero, rejection } from './helpers.js';

/** Gives the document an active palette of its own colours (index 0 transparent) and returns it. */
function addPalette(store: DocumentStore): number {
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
  store.transact('palette', (tx) => {
    const id = tx.newId('palette');
    tx.update((d) => {
      d.palettes.push({ id, name: 'test', colors, ramps: [{ name: 'all', indices: [1, 2, 3] }] });
      d.activePaletteId = id;
    });
  });
  return colors.length;
}

describe('palette ops', () => {
  it('palette.edit creates a palette when there is none, one undo step', async () => {
    const { hero, run } = await openHero();
    const out = await registry.execute(
      'palette.edit',
      {
        doc: HERO_ID,
        name: 'mine',
        edits: [
          { do: 'add', color: '#102030' },
          { do: 'add', color: '#ffffff80' },
        ],
      },
      run,
    );
    expect(out).toMatchObject({ colors: ['#102030', '#ffffff80'], images: 0 });
    expect(hero.store.doc.palettes[0]?.name).toBe('mine');
    expect(hero.store.doc.activePaletteId).toBe(hero.store.doc.palettes[0]?.id);
    expect(hero.store.historyInfo().entries.map((e) => e.label)).toEqual(['AI: palette.edit']);
    hero.store.undo();
    expect(hero.store.doc.palettes).toHaveLength(0);
  });

  it('palette.edit applies edits in order and reports the remap', async () => {
    const { hero, run } = await openHero();
    addPalette(hero.store);
    const n = hero.store.doc.palettes[0]?.colors.length ?? 0;
    const out = (await registry.execute(
      'palette.edit',
      {
        doc: HERO_ID,
        edits: [
          { do: 'move', from: 3, to: 1 },
          { do: 'replace', index: 2, color: '#010203' },
          { do: 'add', color: '#040506', at: 0 },
        ],
      },
      run,
    )) as { colors: string[]; remap: number[] };
    expect(out.colors).toHaveLength(n + 1);
    expect(out.colors[0]).toBe('#040506');
    expect(out.colors[3]).toBe('#010203');
    // old 0 -> 1 (after the add), old 3 -> 2, old 1 -> 3 (moved up, then shifted by the add)
    expect(out.remap.slice(0, 4)).toEqual([1, 3, 4, 2]);
    // ramp "all" [1,2,3] followed the colours
    expect(hero.store.doc.palettes[0]?.ramps[0]?.indices).toEqual([3, 4, 2]);
  });

  it('palette.edit refuses a bad index with the edit number', async () => {
    const { hero, run } = await openHero();
    addPalette(hero.store);
    const hash = documentHash(hero.store);
    const e = await rejection(
      registry.execute(
        'palette.edit',
        {
          doc: HERO_ID,
          edits: [
            { do: 'add', color: '#000000' },
            { do: 'remove', index: 200 },
          ],
        },
        run,
      ),
    );
    expect(e.code).toBe('BAD_INPUT');
    expect(e.message).toContain('edit 1 (remove)');
    expect(documentHash(hero.store)).toBe(hash);
  });

  it('palette.sort needs a palette', async () => {
    const { run } = await openHero();
    const e = await rejection(registry.execute('palette.sort', { doc: HERO_ID, by: 'hue' }, run));
    expect(e).toMatchObject({ code: 'REFUSED', details: { reason: 'no-palette' } });
  });

  it('sorting an indexed document keeps every rendered pixel', async () => {
    const { hero, host, run } = await openHero();
    addPalette(hero.store);
    await registry.execute('doc.setColorMode', { doc: HERO_ID, colorMode: 'indexed' }, run);
    const render = (): string =>
      imageHash(renderFrame(hero.store, { group: 'default' }, 0, { rig: host.renderer }));
    const before = render();
    const old = hero.store.doc.palettes[0]?.colors.map((c) => c.join(',')) ?? [];
    for (const by of ['luma', 'hue', 'luminance', 'chroma'] as const) {
      const out = (await registry.execute(
        'palette.sort',
        { doc: HERO_ID, by, descending: by === 'luma' },
        run,
      )) as { order: number[]; images: number };
      expect(out.images).toBeGreaterThan(5);
      expect(out.order).toHaveLength(old.length);
      expect(render()).toBe(before);
    }
    const now = hero.store.doc.palettes[0]?.colors.map((c) => c.join(',')) ?? [];
    expect([...now].sort()).toEqual([...old].sort());
    expect(now).not.toEqual(old);
    const lint = await registry.execute(
      'lint.run',
      { doc: HERO_ID, enable: ['palette.offPalette'] },
      run,
    );
    expect(lint).toMatchObject({ count: 0 });
    expect(hero.store.historyInfo().entries.at(-1)?.label).toBe('AI: palette.sort');
  });

  it('removing a colour pixels use is refused; an unused one is removed and indices shift', async () => {
    const { hero, host, run } = await openHero();
    const n = addPalette(hero.store);
    await registry.execute('doc.setColorMode', { doc: HERO_ID, colorMode: 'indexed' }, run);
    const hash = documentHash(hero.store);
    const used = await rejection(
      registry.execute('palette.edit', { doc: HERO_ID, edits: [{ do: 'remove', index: 1 }] }, run),
    );
    expect(used).toMatchObject({
      code: 'INVALID_VALUE',
      details: { reason: 'index-removed', index: 1 },
    });
    const transparent = await rejection(
      registry.execute('palette.edit', { doc: HERO_ID, edits: [{ do: 'remove', index: 0 }] }, run),
    );
    expect(transparent.details.reason).toBe('index-removed');
    expect(documentHash(hero.store)).toBe(hash);
    // add an unused colour in front, then remove it again: the render never changes
    const render = (): string =>
      imageHash(renderFrame(hero.store, { group: 'default' }, 0, { rig: host.renderer }));
    const before = render();
    await registry.execute(
      'palette.edit',
      { doc: HERO_ID, edits: [{ do: 'add', color: '#abcdef', at: 1 }] },
      run,
    );
    expect(render()).toBe(before);
    expect(hero.store.doc.palettes[0]?.colors).toHaveLength(n + 1);
    await registry.execute(
      'palette.edit',
      { doc: HERO_ID, edits: [{ do: 'remove', index: 1 }] },
      run,
    );
    expect(render()).toBe(before);
    expect(hero.store.doc.palettes[0]?.colors).toHaveLength(n);
  });

  it('replace recolours indexed pixels; a locked RGBA document gets a warning', async () => {
    const { hero, run } = await openHero();
    addPalette(hero.store);
    await registry.execute('doc.setColorMode', { doc: HERO_ID, paletteLocked: true }, run);
    const out = await registry.execute(
      'palette.edit',
      { doc: HERO_ID, edits: [{ do: 'replace', index: 1, color: '#123456' }] },
      run,
    );
    expect(out).toMatchObject({ warning: expect.stringContaining('palette.offPalette') as string });
  });

  it('refuses to move indices while a palette skin exists, and rewrites remap skins', async () => {
    const { hero, run } = await openHero();
    addPalette(hero.store);
    hero.store.transact('skin', (tx) => {
      const skin = tx.newId('skin');
      tx.update((d) => {
        d.skins.push({ id: skin, name: 'rival', remap: [[1, 2]] });
      });
    });
    await registry.execute(
      'palette.edit',
      { doc: HERO_ID, edits: [{ do: 'move', from: 1, to: 3 }] },
      run,
    );
    // old 1 -> 3, old 2 -> 1, so the pair [1,2] becomes [3,1]
    expect(hero.store.doc.skins[0]).toMatchObject({ remap: [[3, 1]] });
    const hash = documentHash(hero.store);
    const gone = await rejection(
      registry.execute('palette.edit', { doc: HERO_ID, edits: [{ do: 'remove', index: 1 }] }, run),
    );
    expect(gone.details.reason).toBe('skin-uses-index');
    expect(documentHash(hero.store)).toBe(hash);
    hero.store.transact('palette skin', (tx) => {
      const skin = tx.newId('skin');
      const pal = tx.doc.palettes[0]?.id;
      tx.update((d) => {
        if (pal !== undefined) d.skins.push({ id: skin, name: 'team', paletteId: pal });
      });
    });
    const blocked = await rejection(
      registry.execute(
        'palette.edit',
        { doc: HERO_ID, edits: [{ do: 'move', from: 1, to: 2 }] },
        run,
      ),
    );
    expect(blocked.details.reason).toBe('palette-skin');
    // appending moves nothing, so it still works
    await registry.execute(
      'palette.edit',
      { doc: HERO_ID, edits: [{ do: 'add', color: '#ffffff' }] },
      run,
    );
  });

  it('palette.ramp without add only returns the colours and records nothing', async () => {
    const { hero, run } = await openHero();
    const result = await registry.call(
      'palette.ramp',
      { doc: HERO_ID, base: '#c8503c', steps: 5 },
      run,
    );
    expect(result).toMatchObject({
      ok: true,
      output: { colors: ['#34000d', '#87031c', '#c8503c', '#f88253', '#ffc8a8'] },
      doc: { undoEntry: null },
    });
    expect(hero.store.doc.palettes).toHaveLength(0);
  });

  it('palette.ramp add inserts the block, names the ramp and shifts later colours', async () => {
    const { hero, run } = await openHero();
    addPalette(hero.store);
    const n = hero.store.doc.palettes[0]?.colors.length ?? 0;
    const out = (await registry.execute(
      'palette.ramp',
      { doc: HERO_ID, base: '#c8503c', steps: 3, add: true, at: 1, name: 'skin' },
      run,
    )) as { indices: number[]; ramp: string };
    expect(out).toMatchObject({ indices: [1, 2, 3], ramp: 'skin' });
    const pal = hero.store.doc.palettes[0];
    expect(pal?.colors).toHaveLength(n + 3);
    expect(pal?.ramps.map((r) => r.name)).toEqual(['all', 'skin']);
    expect(pal?.ramps[0]?.indices).toEqual([4, 5, 6]);
    expect(hero.store.historyInfo().entries.at(-1)?.label).toBe('AI: palette.ramp');
    const dup = await rejection(
      registry.execute(
        'palette.ramp',
        { doc: HERO_ID, base: '#c8503c', steps: 3, add: true, name: 'skin' },
        run,
      ),
    );
    expect(dup.code).toBe('BAD_INPUT');
    const lone = await rejection(
      registry.execute('palette.ramp', { doc: HERO_ID, base: '#c8503c', steps: 3, name: 'x' }, run),
    );
    expect(lone.code).toBe('BAD_INPUT');
    // a default name never collides
    const auto = (await registry.execute(
      'palette.ramp',
      { doc: HERO_ID, base: '#336699', steps: 2, add: true },
      run,
    )) as { ramp: string };
    expect(auto.ramp).toBe('ramp3');
  });
});
