// override.import: the edited PNG of a frame becomes overrides; the render then equals the PNG.
import { decodePng, encodePng } from '@pixel-forge/png';
import { describe, expect, it } from 'vitest';
import { registry } from '../src/index.js';
import { HERO_ID, openHero, rejection, stepLabels } from './helpers.js';

const FRAME = { doc: HERO_ID, animation: { group: 'default' }, frame: 0 } as const;

/** Exports frame 0 at scale 1 (the sheet is exactly the frame) and returns its pixels. */
async function exported(
  run: Parameters<typeof registry.execute>[2],
  fs: { readFile(p: string): Promise<Uint8Array> },
) {
  await registry.execute(
    'io.export',
    { doc: HERO_ID, path: '/work/out/base.png', animations: [{ group: 'default' }] },
    run,
  );
  return decodePng(await fs.readFile('/work/out/base.png'));
}

describe('override.import', () => {
  it('round trip: edit 3 px of the exported frame, import, and the render equals the edited PNG', async () => {
    const { hero, fs, run } = await openHero();
    const png = await exported(run, fs);
    const edited = new Uint8Array(png.data);
    const spots = [
      [26, 4],
      [27, 4],
      [26, 5],
    ] as const;
    for (const [x, y] of spots) edited.set([255, 0, 255, 255], (y * png.width + x) * 4);
    fs.seed('/work/out/edited.png', encodePng({ ...png, data: edited }));

    const out = (await registry.execute(
      'override.import',
      { ...FRAME, file: '/work/out/edited.png' },
      run,
    )) as { changed: number; overrides: string[]; animation: string; frameIndex: number };
    expect(out).toMatchObject({ changed: 3, animation: 'default', frameIndex: 0 });
    expect(out.overrides.length).toBeGreaterThan(0);
    expect(stepLabels(hero).at(-1)).toBe('AI: override.import');

    const after = await exported(run, fs);
    expect([...after.data]).toEqual([...edited]);
  });

  it('writes nothing when the PNG equals the render (transparent RGB is ignored)', async () => {
    const { hero, fs, run } = await openHero();
    const png = await exported(run, fs);
    const same = new Uint8Array(png.data);
    for (let i = 0; i < same.length; i += 4) {
      if (same[i + 3] === 0) same.set([9, 9, 9], i);
    }
    fs.seed('/work/out/same.png', encodePng({ ...png, data: same }));
    const before = stepLabels(hero).length;
    const out = await registry.execute(
      'override.import',
      { ...FRAME, file: '/work/out/same.png' },
      run,
    );
    expect(out).toMatchObject({ changed: 0, overrides: [], newlyStale: [] });
    expect(stepLabels(hero)).toHaveLength(before);
  });

  it('refuses a PNG of the wrong size, a missing file and a file that is not a PNG', async () => {
    const { fs, run } = await openHero();
    fs.seed(
      '/work/out/small.png',
      encodePng({ width: 2, height: 2, kind: 'rgba', data: new Uint8Array(16) }),
    );
    const small = await rejection(
      registry.execute('override.import', { ...FRAME, file: '/work/out/small.png' }, run),
    );
    expect(small).toMatchObject({ code: 'REFUSED', details: { reason: 'bad-size' } });
    const missing = await rejection(
      registry.execute('override.import', { ...FRAME, file: '/work/out/none.png' }, run),
    );
    expect(missing.code).toBe('IO_FAILED');
    fs.seed('/work/out/junk.png', new Uint8Array([1, 2, 3]));
    const junk = await rejection(
      registry.execute('override.import', { ...FRAME, file: '/work/out/junk.png' }, run),
    );
    expect(junk.code).toBe('BAD_FILE');
  });
});
