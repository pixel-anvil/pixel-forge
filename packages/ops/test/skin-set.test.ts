// skin.set: remap and palette skins, replace, remove, refusals, undo, and what the skin renders.
import { documentHash, renderFrame, validate } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry } from '../src/index.js';
import { FLAT, openFlat } from './grid-fixtures.js';
import { need, rejection } from './helpers.js';

const FRAME = { doc: FLAT.doc, animation: { group: 'idle' }, frame: 0 } as const;
const LEGEND = { R: '#ff0000', G: '#00ff00', B: '#0000ff' };
const TEAM = ['#00000000', '#ffff00', '#ff00ff', '#00ffff'];

async function open() {
  const f = await openFlat({ indexed: true, w: 4, h: 2 });
  await registry.execute(
    'pixels.writeGrid',
    { ...FRAME, rows: ['RGB.', 'RRG.'], legend: LEGEND },
    f.run,
  );
  return f;
}

/** Row 0 of the frame as `r,g,b` per pixel ("." transparent), under a skin or the base. */
const row = (hosted: Awaited<ReturnType<typeof open>>['hosted'], skin?: string): string[] => {
  const img = renderFrame(
    hosted.store,
    { group: 'idle' },
    0,
    skin === undefined ? {} : { skin: { name: skin } },
  );
  const out: string[] = [];
  for (let x = 0; x < 4; x++) {
    const c = img.get(x, 0);
    out.push(c[3] === 0 ? '.' : c.slice(0, 3).join(','));
  }
  return out;
};

describe('skin.set: remap skin', () => {
  it('stores the canonical pairs, renders the swap, keeps the base render', async () => {
    const { hosted, run } = await open();
    const out = await registry.execute(
      'skin.set',
      {
        doc: FLAT.doc,
        skin: 'rival',
        // 1 <-> 3 by index and by colour; the identity pair is dropped; unsorted on purpose.
        map: [
          { from: 3, to: 1 },
          { from: '#ff0000', to: 3 },
          { from: 2, to: 2 },
        ],
      },
      run,
    );
    expect(out).toMatchObject({
      skin: 'rival',
      action: 'created',
      kind: 'remap',
      skins: ['rival'],
    });
    expect(hosted.store.doc.skins).toEqual([
      {
        id: (out as { id: string }).id,
        name: 'rival',
        remap: [
          [1, 3],
          [3, 1],
        ],
      },
    ]);
    expect(row(hosted)).toEqual(['255,0,0', '0,255,0', '0,0,255', '.']);
    expect(row(hosted, 'rival')).toEqual(['0,0,255', '0,255,0', '255,0,0', '.']);
    expect(validate(hosted.store).filter((f) => f.severity === 'error')).toEqual([]);
    expect(hosted.store.historyInfo().entries.at(-1)?.label).toBe('AI: skin.set');
  });

  it('replaces a skin of the same name (same id and place), then removes it; undo restores', async () => {
    const { hosted, run } = await open();
    const set = (map: { from: number; to: number }[], skin = 'rival') =>
      registry.execute('skin.set', { doc: FLAT.doc, skin, map }, run);
    const first = (await set([{ from: 1, to: 2 }])) as { id: string };
    await set([{ from: 1, to: 2 }], 'other');
    const before = documentHash(hosted.store);
    const again = await set([{ from: 2, to: 3 }]);
    expect(again).toMatchObject({ id: first.id, action: 'updated', skins: ['rival', 'other'] });
    expect(need(hosted.store.doc.skins[0])).toMatchObject({ id: first.id, remap: [[2, 3]] });
    const gone = await registry.execute(
      'skin.set',
      { doc: FLAT.doc, skin: first.id, remove: true },
      run,
    );
    expect(gone).toMatchObject({ action: 'removed', skin: 'rival', skins: ['other'] });
    await registry.execute('doc.undo', { doc: FLAT.doc }, run);
    await registry.execute('doc.undo', { doc: FLAT.doc }, run);
    expect(documentHash(hosted.store)).toBe(before);
  });

  it('refuses bad input and leaves the document unchanged', async () => {
    const { hosted, run } = await open();
    const before = documentHash(hosted.store);
    const call = (input: Record<string, unknown>) =>
      rejection(registry.execute('skin.set', { doc: FLAT.doc, ...input }, run));
    const map = [{ from: 1, to: 2 }];
    expect((await call({ skin: 'base', map })).code).toBe('BAD_INPUT');
    expect((await call({ skin: 'Bad Name', map })).code).toBe('BAD_INPUT');
    expect((await call({ skin: 'a' })).code).toBe('BAD_INPUT');
    expect((await call({ skin: 'a', map, remove: true })).code).toBe('BAD_INPUT');
    expect((await call({ skin: 'a', map: [{ from: 1, to: 9 }] })).code).toBe('BAD_INPUT');
    const twice = await call({
      skin: 'a',
      map: [
        { from: 1, to: 2 },
        { from: 1, to: 3 },
      ],
    });
    expect(twice.message).toMatch(/mapped twice/);
    const clear = await call({ skin: 'a', map: [{ from: 0, to: 1 }] });
    expect(clear.details).toMatchObject({ reason: 'transparent' });
    expect((await call({ skin: 'a', map: [{ from: '#123456', to: 1 }] })).code).toBe('BAD_INPUT');
    expect((await call({ skin: 'nope', remove: true })).code).toBe('NOT_FOUND');
    expect(documentHash(hosted.store)).toBe(before);
  });

  it('needs an active palette', async () => {
    const { run } = await openFlat({ w: 4, h: 2 });
    const bad = await rejection(
      registry.execute('skin.set', { doc: FLAT.doc, skin: 'a', map: [{ from: 1, to: 2 }] }, run),
    );
    expect(bad).toMatchObject({ code: 'REFUSED', details: { reason: 'no-palette' } });
  });

  it('warns when the source colour is shadowed by an earlier equal colour', async () => {
    const { hosted, run } = await open();
    await registry.execute(
      'palette.edit',
      { doc: FLAT.doc, edits: [{ do: 'add', color: '#ff0000' }] },
      run,
    );
    const out = (await registry.execute(
      'skin.set',
      { doc: FLAT.doc, skin: 'a', map: [{ from: 4, to: 3 }] },
      run,
    )) as { warnings?: string[] };
    expect(out.warnings?.[0]).toMatch(/same colour as index 1/);
    expect(hosted.store.doc.skins).toHaveLength(1);
  });
});

describe('skin.set: palette skin', () => {
  it('makes its own palette from colors, renders index for index, updates it in place', async () => {
    const { hosted, run } = await open();
    const out = await registry.execute(
      'skin.set',
      { doc: FLAT.doc, skin: 'team', colors: TEAM },
      run,
    );
    expect(out).toMatchObject({ kind: 'palette', action: 'created' });
    const pal = need(hosted.store.doc.palettes.find((p) => p.name === 'skin:team'));
    expect(need(hosted.store.doc.skins[0])).toMatchObject({ name: 'team', paletteId: pal.id });
    expect(hosted.store.doc.activePaletteId).toBe(FLAT.pal);
    expect(row(hosted, 'team')).toEqual(['255,255,0', '255,0,255', '0,255,255', '.']);
    await registry.execute(
      'skin.set',
      { doc: FLAT.doc, skin: 'team', colors: [...TEAM.slice(0, 3), '#101010'] },
      run,
    );
    expect(hosted.store.doc.palettes.filter((p) => p.name === 'skin:team')).toHaveLength(1);
    expect(row(hosted, 'team')[2]).toBe('16,16,16');
    await registry.execute('skin.set', { doc: FLAT.doc, skin: 'team', remove: true }, run);
    expect(hosted.store.doc.palettes.map((p) => p.name)).toEqual(['Base']);
  });

  it('uses another palette of the document by name or id, never the active one', async () => {
    const { hosted, run } = await open();
    await registry.execute('skin.set', { doc: FLAT.doc, skin: 'a', colors: TEAM }, run);
    const pal = need(hosted.store.doc.palettes.find((p) => p.name === 'skin:a'));
    const out = await registry.execute(
      'skin.set',
      { doc: FLAT.doc, skin: 'b', palette: pal.id },
      run,
    );
    expect(out).toMatchObject({ kind: 'palette', skins: ['a', 'b'] });
    // The palette is shared now: removing "a" keeps it.
    await registry.execute('skin.set', { doc: FLAT.doc, skin: 'a', remove: true }, run);
    expect(hosted.store.doc.palettes).toHaveLength(2);
    expect(row(hosted, 'b')[0]).toBe('255,255,0');
    const same = await rejection(
      registry.execute('skin.set', { doc: FLAT.doc, skin: 'c', palette: 'Base' }, run),
    );
    expect(same.code).toBe('BAD_INPUT');
    const none = await rejection(
      registry.execute('skin.set', { doc: FLAT.doc, skin: 'c', palette: 'ghost' }, run),
    );
    expect(none.code).toBe('NOT_FOUND');
  });

  it('refuses a wrong count and a skin colour that erases an opaque colour', async () => {
    const { hosted, run } = await open();
    const before = documentHash(hosted.store);
    const short = await rejection(
      registry.execute('skin.set', { doc: FLAT.doc, skin: 'a', colors: TEAM.slice(0, 3) }, run),
    );
    expect(short.code).toBe('BAD_INPUT');
    const erase = await rejection(
      registry.execute(
        'skin.set',
        { doc: FLAT.doc, skin: 'a', colors: [TEAM[0], '#ffff0000', TEAM[2], TEAM[3]] },
        run,
      ),
    );
    expect(erase).toMatchObject({ code: 'REFUSED', details: { reason: 'transparent' } });
    expect(documentHash(hosted.store)).toBe(before);
  });

  it('keeps E5.2: a palette skin refuses index moves (palette.sort)', async () => {
    const { run } = await open();
    await registry.execute('skin.set', { doc: FLAT.doc, skin: 'a', colors: TEAM }, run);
    const bad = await rejection(
      registry.execute('palette.sort', { doc: FLAT.doc, by: 'luminance', descending: true }, run),
    );
    expect(bad.details).toMatchObject({ reason: 'palette-skin' });
  });
});
