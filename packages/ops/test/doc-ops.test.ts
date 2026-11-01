// doc.open and doc.summary on the synthetic hero, through the memory host.
import { MemoryFileSystem, fixedClock } from '@pixel-forge/io';
import { describe, expect, it } from 'vitest';
import { createMemoryHost, docOpen, normalizePath, registry } from '../src/index.js';
import { HERO_BYTES, HERO_ID, HERO_PATH, heroHost, need, openHero, rejection } from './helpers.js';

describe('doc.open', () => {
  it('opens the hero and returns its example output', async () => {
    const { host } = heroHost();
    const out = await registry.execute('doc.open', need(docOpen.examples[0]).input, { host });
    expect(out).toEqual(need(docOpen.examples[0]).output);
    const hosted = need(host.get(HERO_ID));
    expect(hosted).toMatchObject({ path: HERO_PATH, savedVersion: 0 });
    expect(hosted.file?.doc.meta.id).toBe(HERO_ID);
  });

  it('returns the same document when the path is already open', async () => {
    const { host, run } = await openHero();
    const again = await registry.call('doc.open', { path: '/work/./sub/../hero.pxf' }, run);
    expect(again).toMatchObject({ ok: true, output: { doc: HERO_ID, alreadyOpen: true } });
    expect(host.list()).toHaveLength(1);
  });

  it('gives two parallel opens of one path the same document', async () => {
    const { host } = heroHost();
    const run = { host };
    const [a, b, c] = await Promise.all([
      registry.execute('doc.open', { path: HERO_PATH }, run),
      registry.execute('doc.open', { path: '/work/./hero.pxf' }, run),
      registry.execute('doc.open', { path: HERO_PATH }, run),
    ]);
    expect(a).toMatchObject({ doc: HERO_ID, alreadyOpen: false });
    expect(b).toMatchObject({ doc: HERO_ID, alreadyOpen: true, warnings: [] });
    expect(c).toMatchObject({ doc: HERO_ID, alreadyOpen: true });
    expect(host.list()).toHaveLength(1);
    // a failed open does not poison the path
    const { host: h2, fs } = heroHost();
    fs.seed('/work/junk.pxf', new Uint8Array([1]));
    const both = await Promise.allSettled([
      registry.execute('doc.open', { path: '/work/junk.pxf' }, { host: h2 }),
      registry.execute('doc.open', { path: '/work/junk.pxf' }, { host: h2 }),
    ]);
    expect(both.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    fs.seed('/work/junk.pxf', HERO_BYTES);
    await expect(
      registry.execute('doc.open', { path: '/work/junk.pxf' }, { host: h2 }),
    ).resolves.toMatchObject({ alreadyOpen: false });
  });

  it('maps missing files, bad files, paths outside the roots and id clashes', async () => {
    const { host, fs } = heroHost();
    fs.seed('/work/junk.pxf', new Uint8Array([1, 2, 3]));
    fs.seed('/work/copy.pxf', HERO_BYTES);
    const run = { host };
    expect(
      (await rejection(registry.execute('doc.open', { path: '/work/none.pxf' }, run))).code,
    ).toBe('IO_FAILED');
    expect(
      await rejection(registry.execute('doc.open', { path: '/work/junk.pxf' }, run)),
    ).toMatchObject({
      code: 'BAD_FILE',
      details: { cause: { error: 'IoError', code: 'BAD_PXF' } },
    });
    expect(
      (await rejection(registry.execute('doc.open', { path: '/etc/hero.pxf' }, run))).code,
    ).toBe('NOT_ALLOWED');
    expect(
      (await rejection(registry.execute('doc.open', { path: '/work/../etc/x.pxf' }, run))).code,
    ).toBe('NOT_ALLOWED');
    expect((await rejection(registry.execute('doc.open', { path: 'hero.pxf' }, run))).code).toBe(
      'BAD_INPUT',
    );
    await registry.execute('doc.open', { path: HERO_PATH }, run);
    expect(
      await rejection(registry.execute('doc.open', { path: '/work/copy.pxf' }, run)),
    ).toMatchObject({
      code: 'CONFLICT',
      details: { doc: HERO_ID, openPath: HERO_PATH },
    });
  });
});

describe('memory host', () => {
  it('normalises paths', () => {
    expect(normalizePath('/a//b/./c/../d')).toBe('/a/b/d');
    expect(normalizePath('/../a')).toBe('/a');
    expect(normalizePath('a/../../b')).toBe('../b');
    expect(normalizePath('./')).toBe('.');
  });

  it('accepts any path without roots, rejects relative roots, closes documents', async () => {
    const fs = new MemoryFileSystem();
    fs.seed('/any/hero.pxf', HERO_BYTES);
    const host = createMemoryHost({ fs, clock: fixedClock('2026-01-01T00:00:00Z') });
    expect(host.resolvePath('rel/x.pxf')).toBe('rel/x.pxf');
    expect(() => host.resolvePath('')).toThrow(/empty path/);
    await registry.execute('doc.open', { path: '/any/hero.pxf' }, { host });
    const hosted = need(host.get(HERO_ID));
    expect(host.byPath('/any/hero.pxf')).toBe(hosted);
    await expect(host.adopt({ store: hosted.store, path: '/any/other.pxf' })).rejects.toMatchObject(
      {
        code: 'CONFLICT',
      },
    );
    expect(await host.close(HERO_ID)).toBe(true);
    expect(await host.close(HERO_ID)).toBe(false);
    await host.adopt({ store: hosted.store });
    expect(need(host.get(HERO_ID))).toMatchObject({ path: undefined, savedVersion: undefined });
    expect(() =>
      createMemoryHost({ fs, clock: fixedClock('2026-01-01T00:00:00Z'), roots: ['work'] }),
    ).toThrow(/absolute/);
    const rooted = createMemoryHost({
      fs,
      clock: fixedClock('2026-01-01T00:00:00Z'),
      roots: ['/'],
    });
    expect(rooted.resolvePath('/x/y')).toBe('/x/y');
  });

  it('refuses a second document on an open path', async () => {
    const { host, hero } = await openHero();
    await host.close(HERO_ID);
    const other = { ...hero.store.doc, meta: { ...hero.store.doc.meta, id: 'doc_other' } };
    const { DocumentStore } = await import('@pixel-forge/core');
    await host.adopt({ store: hero.store, path: HERO_PATH });
    await expect(
      host.adopt({ store: new DocumentStore(other as never), path: HERO_PATH }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { doc: HERO_ID },
    });
  });
});

describe('doc.summary', () => {
  it('summarises the hero', async () => {
    const { run } = await openHero();
    const out = (await registry.execute('doc.summary', { doc: HERO_ID }, run)) as Record<
      string,
      unknown
    >;
    expect(out).toMatchObject({
      doc: HERO_ID,
      name: 'hero',
      path: HERO_PATH,
      version: 0,
      dirty: false,
      canUndo: false,
      canvas: { w: 48, h: 48 },
      origin: { x: 24, y: 47 },
      colorMode: 'rgba',
      palette: null,
      skins: [],
      animations: [
        {
          label: 'default',
          group: 'default',
          direction: null,
          loop: expect.any(String) as string,
          frames: 1,
          durationMs: 100,
          mirrorOf: null,
          overrides: 0,
        },
      ],
    });
    const rig = out.rig as {
      bones: { name: string; parent: string | null }[];
      parts: { name: string; bone: string; variants: string[] }[];
      views: unknown[];
    };
    expect(rig.bones[0]).toMatchObject({ name: 'root', parent: null });
    expect(rig.bones.find((b) => b.name === 'torso')?.parent).toBe('pelvis');
    expect(rig.parts.find((p) => p.name === 'lower_arm_r')).toMatchObject({
      bone: 'lower_arm_r',
      variants: ['default', 'sleeve'],
    });
    expect(rig.views).toEqual([
      { id: expect.any(String) as string, name: 'side', directions: ['side'] },
    ]);
    expect((out.layers as unknown[]).length).toBe(16);
  });

  it('reports dirty state, mirrors, palettes and a missing rig', async () => {
    const { hero, run } = await openHero();
    await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: { group: 'default' }, frame: 0, bones: { torso: { angle: 5 } } },
      run,
    );
    hero.store.transact('Setup', (tx) => {
      const mirror = tx.newId('animation');
      const pal = tx.newId('palette');
      tx.update((d) => {
        const src = need(d.animations[0]);
        d.animations.push({
          id: mirror,
          group: 'default',
          direction: 'left',
          mirrorOf: src.id,
          overrides: [],
        });
        d.palettes.push({
          id: pal as never,
          name: 'pico',
          colors: [
            [0, 0, 0, 0],
            [255, 255, 255, 255],
          ],
          ramps: [],
        } as never);
        d.activePaletteId = pal;
        delete d.rig;
      });
    });
    const out = (await registry.execute('doc.summary', { doc: HERO_ID }, run)) as Record<
      string,
      unknown
    >;
    expect(out).toMatchObject({
      dirty: true,
      canUndo: true,
      rig: null,
      palette: { name: 'pico', colors: 2 },
    });
    expect((out.animations as unknown[])[1]).toMatchObject({
      label: 'default/left',
      mirrorOf: 'default',
      frames: 1,
      durationMs: 100,
    });
  });
});
