// io.export: spritesheet PNG + JSON written atomically through the host file system.
import { decodeGif } from '@pixel-forge/io';
import { decodePng } from '@pixel-forge/png';
import { describe, expect, it, vi } from 'vitest';
import { ioExport, registry } from '../src/index.js';
import { HERO_ID, need, openHero, issues, rejection } from './helpers.js';

const readJson = async (fs: { readFile(p: string): Promise<Uint8Array> }, path: string) =>
  JSON.parse(new TextDecoder().decode(await fs.readFile(path))) as {
    frames: Record<
      string,
      { frame: { x: number; y: number; w: number; h: number }; duration: number }
    >;
    meta: {
      image: string;
      size: { w: number; h: number };
      frameTags: { name: string; from: number; to: number }[];
    };
  };

describe('io.export', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await openHero();
    const cases: [Record<string, unknown>, string][] = [
      [{ path: '/work/out/hero.jpg' }, 'path'],
      [{ path: '/work/out/hero.png', scale: 17 }, 'scale'],
      [{ path: '/work/out/hero.png', layout: 'diagonal' }, 'layout'],
    ];
    for (const [extra, path] of cases) {
      const bad = await rejection(registry.execute('io.export', { doc: HERO_ID, ...extra }, run));
      expect(bad.code).toBe('BAD_INPUT');
      expect(issues(bad)[0]?.path).toBe(path);
    }
  });

  it('runs its example: a 2x sheet of the rigged hero, PNG and JSON, no temp files left, no undo step', async () => {
    const { hero, fs, run } = await openHero();
    const out = await registry.execute('io.export', need(ioExport.examples[0]).input, run);
    expect(out).toEqual(need(ioExport.examples[0]).output);
    const png = await fs.readFile('/work/out/hero.png');
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const json = await readJson(fs, '/work/out/hero.json');
    expect(json.meta).toMatchObject({ image: 'hero.png', size: { w: 96, h: 96 } });
    expect(json.meta.frameTags.map((t) => t.name)).toEqual(['default']);
    expect(Object.keys(json.frames)).toEqual(['default 0']);
    expect((await fs.readdir('/work/out')).map((e) => e.name)).toEqual(['hero.json', 'hero.png']);
    expect(hero.store.historyInfo().entries).toHaveLength(0);
  });

  it('lays out animations in rows or packed, with mirrors, and honours the animation filter', async () => {
    const { fs, run } = await openHero();
    await registry.execute(
      'anim.create',
      { doc: HERO_ID, group: 'run', frames: 3, durationMs: 50 },
      run,
    );
    await registry.execute(
      'rig.mirrorAnimation',
      { doc: HERO_ID, source: { group: 'run' }, direction: 'left' },
      run,
    );
    const rows = await registry.execute('io.export', { doc: HERO_ID, path: '/work/rows.png' }, run);
    expect(rows).toMatchObject({ size: { w: 144, h: 144 }, frames: 7 });
    const rowJson = await readJson(fs, '/work/rows.json');
    expect(rowJson.meta.frameTags.map((t) => t.name)).toEqual(['default', 'run', 'run/left']);
    expect(rowJson.frames['run 2']).toMatchObject({
      frame: { x: 96, y: 48, w: 48, h: 48 },
      duration: 50,
    });
    const packed = await registry.execute(
      'io.export',
      { doc: HERO_ID, path: '/work/packed.png', layout: 'packed', animations: [{ group: 'run' }] },
      run,
    );
    expect(packed).toMatchObject({ size: { w: 96, h: 96 }, frames: 3, animations: ['run'] });
  });

  it('refuses unknown skins and animations, and paths outside the roots; a failed write leaves no file', async () => {
    const { fs, run } = await openHero();
    const skin = await rejection(
      registry.execute('io.export', { doc: HERO_ID, path: '/work/s.png', skin: 'rival' }, run),
    );
    expect(skin.code).toBe('REFUSED');
    const anim = await rejection(
      registry.execute(
        'io.export',
        { doc: HERO_ID, path: '/work/a.png', animations: [{ group: 'x' }] },
        run,
      ),
    );
    expect(anim).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'animation' } });
    const outside = await rejection(
      registry.execute('io.export', { doc: HERO_ID, path: '/tmp/a.png' }, run),
    );
    expect(outside.code).toBe('NOT_ALLOWED');
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk full'));
    const failed = await rejection(
      registry.execute('io.export', { doc: HERO_ID, path: '/work/f.png' }, run),
    );
    expect(failed.code).toBe('IO_FAILED');
    expect(await fs.exists('/work/f.png')).toBe(false);
    expect(await fs.exists('/work/f.png.tmp-0')).toBe(false);
  });

  it('allSkins writes one sheet per skin with the same layout; base keeps the plain name', async () => {
    const { fs, run } = await openHero();
    const doc = HERO_ID;
    await registry.execute(
      'palette.edit',
      {
        doc,
        edits: [
          { do: 'add', color: '#e8be96' },
          { do: 'add', color: '#3c6ebe' },
        ],
      },
      run,
    );
    await registry.execute(
      'skin.set',
      { doc, skin: 'rival', map: [{ from: '#e8be96', to: '#3c6ebe' }] },
      run,
    );
    await registry.execute('skin.set', { doc, skin: 'team', colors: ['#112233', '#445566'] }, run);
    const out = (await registry.execute(
      'io.export',
      { doc, path: '/work/out/all.png', allSkins: true },
      run,
    )) as { png: string; sheets: { skin: string; png: string; json: string }[] };
    expect(out.png).toBe('/work/out/all.png');
    expect(out.sheets).toEqual([
      { skin: 'base', png: '/work/out/all.png', json: '/work/out/all.json' },
      { skin: 'rival', png: '/work/out/all.rival.png', json: '/work/out/all.rival.json' },
      { skin: 'team', png: '/work/out/all.team.png', json: '/work/out/all.team.json' },
    ]);
    const imgs = await Promise.all(
      out.sheets.map(async (s) => decodePng(await fs.readFile(s.png))),
    );
    const base = need(imgs[0]);
    for (const img of imgs) expect([img.width, img.height]).toEqual([base.width, base.height]);
    expect(imgs.slice(1).every((img) => Buffer.compare(img.data, base.data) !== 0)).toBe(true);
    // Same layout: the JSON differs only in meta.image.
    const [b, r] = await Promise.all([
      readJson(fs, '/work/out/all.json'),
      readJson(fs, '/work/out/all.rival.json'),
    ]);
    expect(b.meta.image).toBe('all.png');
    expect(r.meta.image).toBe('all.rival.png');
    expect(r.frames).toEqual(b.frames);
    // Without allSkins: unchanged single sheet, no "sheets"; "skin" and allSkins together are refused.
    const one = await registry.execute('io.export', { doc, path: '/work/one.png' }, run);
    expect(one).not.toHaveProperty('sheets');
    const both = await rejection(
      registry.execute(
        'io.export',
        { doc, path: '/work/x.png', allSkins: true, skin: 'rival' },
        run,
      ),
    );
    expect(both.code).toBe('BAD_INPUT');
    expect(await fs.exists('/work/x.png')).toBe(false);
  });

  it('writes an animated GIF: one animation, its durations and loop, no JSON, atomically', async () => {
    const { fs, run } = await openHero();
    await registry.execute(
      'anim.create',
      { doc: HERO_ID, group: 'run', frames: 3, durationMs: 50 },
      run,
    );
    const out = await registry.execute(
      'io.export',
      { doc: HERO_ID, path: '/work/out/run.gif', animations: [{ group: 'run' }], scale: 2 },
      run,
    );
    expect(out).toEqual({
      gif: '/work/out/run.gif',
      size: { w: 96, h: 96 },
      frames: 3,
      animations: ['run'],
    });
    const gif = decodeGif(await fs.readFile('/work/out/run.gif'));
    expect([gif.width, gif.height, gif.frames.length, gif.loopCount]).toEqual([96, 96, 3, 0]);
    expect(gif.frames.map((f) => f.durationMs)).toEqual([50, 50, 50]);
    expect((await fs.readdir('/work/out')).map((e) => e.name)).toEqual(['run.gif']);
  });

  it('refuses a GIF of several animations or with allSkins', async () => {
    const { fs, run } = await openHero();
    await registry.execute('anim.create', { doc: HERO_ID, group: 'run', frames: 2 }, run);
    const several = await rejection(
      registry.execute('io.export', { doc: HERO_ID, path: '/work/a.gif' }, run),
    );
    expect(several.code).toBe('BAD_INPUT');
    const two = await rejection(
      registry.execute(
        'io.export',
        { doc: HERO_ID, path: '/work/a.gif', animations: [{ group: 'run' }, { group: 'default' }] },
        run,
      ),
    );
    expect(two.code).toBe('BAD_INPUT');
    const skins = await rejection(
      registry.execute(
        'io.export',
        { doc: HERO_ID, path: '/work/a.gif', animations: [{ group: 'run' }], allSkins: true },
        run,
      ),
    );
    expect(skins.code).toBe('BAD_INPUT');
    expect(await fs.exists('/work/a.gif')).toBe(false);
  });
});
