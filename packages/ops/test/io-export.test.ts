// io.export: spritesheet PNG + JSON written atomically through the host file system.
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
      [{ path: '/work/out/hero.gif' }, 'path'],
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
});
