// doc.save: first save, save, save-as through host.rebind, atomic write, dirty tracking.
import { documentHash } from '@pixel-forge/core';
import { buildPxf, fixedClock, pxfStore, readPxf } from '@pixel-forge/io';
import { describe, expect, it, vi } from 'vitest';
import { docSave, registry } from '../src/index.js';
import { HERO_BYTES, HERO_ID, HERO_PATH, heroHost, need, openHero, rejection } from './helpers.js';

const setPose = {
  doc: HERO_ID,
  animation: { group: 'default' },
  frame: 0,
  bones: { torso: { angle: 5 } },
};

describe('doc.save', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const bad = await rejection(registry.execute('doc.save', { doc: HERO_ID, path: '' }, run));
    expect(bad.code).toBe('BAD_INPUT');
    expect(bad.details.issues).toEqual([{ path: 'path', message: expect.any(String) as string }]);
  });

  it('runs its example (save as): rebinds, writes a readable file, marks the document saved', async () => {
    const { hero, fs, run } = await openHero();
    const out = (await registry.execute('doc.save', need(docSave.examples[0]).input, run)) as {
      path: string;
      wrote: boolean;
      bytes: number;
    };
    expect(out).toMatchObject({ path: '/work/hero-v2.pxf', wrote: true });
    expect(hero.path).toBe('/work/hero-v2.pxf');
    expect(hero.savedVersion).toBe(hero.store.version);
    const bytes = await fs.readFile('/work/hero-v2.pxf');
    expect(bytes.length).toBe(out.bytes);
    expect(readPxf(bytes).doc.meta.id).toBe(HERO_ID);
    expect(hero.file?.doc.meta.id).toBe(HERO_ID);
    expect(await fs.exists(HERO_PATH)).toBe(true); // the old file is untouched
    expect(hero.store.historyInfo().entries).toHaveLength(0); // saving is not an undo step
  });

  it('writes through a temp file in the same folder and a rename', async () => {
    const { hero, fs, run } = await openHero();
    await registry.execute('rig.setPose', setPose, run);
    const rename = vi.spyOn(fs, 'rename');
    const write = vi.spyOn(fs, 'writeFile');
    await registry.execute('doc.save', { doc: HERO_ID }, run);
    const tmp = need(write.mock.calls.find(([p]) => p !== HERO_PATH))[0];
    expect(tmp.startsWith(`${HERO_PATH}.tmp-`)).toBe(true);
    expect(rename).toHaveBeenCalledWith(tmp, HERO_PATH);
    expect(await fs.exists(tmp)).toBe(false);
    const saved = pxfStore(readPxf(await fs.readFile(HERO_PATH)));
    expect(documentHash(saved)).toBe(documentHash(hero.store));
  });

  it('tracks dirty: saves after an edit, then writes nothing for an unchanged document', async () => {
    const { hero, run } = await openHero();
    const dirty = async (): Promise<boolean> =>
      ((await registry.execute('doc.summary', { doc: HERO_ID }, run)) as { dirty: boolean }).dirty;
    expect(await dirty()).toBe(false);
    await registry.execute('rig.setPose', setPose, run);
    expect(await dirty()).toBe(true);
    expect(await registry.execute('doc.save', { doc: HERO_ID }, run)).toMatchObject({
      wrote: true,
    });
    expect(await dirty()).toBe(false);
    expect(await registry.execute('doc.save', { doc: HERO_ID }, run)).toMatchObject({
      wrote: false,
      bytes: 0,
      version: hero.store.version,
    });
  });

  it('writes an unchanged document whose file has no render cache, keeping modified', async () => {
    const { host, fs } = heroHost();
    const clock = fixedClock('2026-01-01T00:00:00Z');
    const old = readPxf(HERO_BYTES);
    fs.seed(HERO_PATH, buildPxf(pxfStore(old), { clock, renderCache: false, previous: old }).bytes);
    const run = { host };
    await registry.execute('doc.open', { path: HERO_PATH }, run);
    const before = readPxf(await fs.readFile(HERO_PATH));
    expect(before.renderIndex).toBeUndefined();
    const out = await registry.execute('doc.save', { doc: HERO_ID }, run);
    expect(out).toMatchObject({ wrote: true });
    const after = readPxf(await fs.readFile(HERO_PATH));
    expect(after.renderIndex).toBeDefined();
    expect(after.manifest.modified).toBe(before.manifest.modified);
    expect(documentHash(pxfStore(after))).toBe(documentHash(pxfStore(before)));
    // Now the file is what a save writes: nothing more to do.
    expect(await registry.execute('doc.save', { doc: HERO_ID }, run)).toMatchObject({
      wrote: false,
    });
  });

  it('saves a created document on its first save and needs a path for it', async () => {
    const { host, fs, run } = await openHero();
    const made = (await registry.execute(
      'doc.create',
      { name: 'new', width: 8, height: 8 },
      run,
    )) as { doc: string };
    const noPath = await rejection(registry.execute('doc.save', { doc: made.doc }, run));
    expect(noPath).toMatchObject({ code: 'BAD_INPUT' });
    await registry.execute('doc.save', { doc: made.doc, path: '/work/new/new.pxf' }, run);
    expect(readPxf(await fs.readFile('/work/new/new.pxf')).doc.meta.name).toBe('new');
    expect(need(host.get(made.doc as never)).path).toBe('/work/new/new.pxf');
  });

  it("refuses paths outside the roots, an existing target and another open document's path", async () => {
    const { host, fs, run } = await openHero();
    const outside = await rejection(
      registry.execute('doc.save', { doc: HERO_ID, path: '/etc/x.pxf' }, run),
    );
    expect(outside.code).toBe('NOT_ALLOWED');
    fs.seed('/work/taken.pxf', new Uint8Array([1]));
    const exists = await rejection(
      registry.execute('doc.save', { doc: HERO_ID, path: '/work/taken.pxf' }, run),
    );
    expect(exists).toMatchObject({ code: 'CONFLICT', details: { reason: 'file-exists' } });
    expect(need(host.get(HERO_ID)).path).toBe(HERO_PATH);
    await registry.execute(
      'doc.save',
      { doc: HERO_ID, path: '/work/taken.pxf', overwrite: true },
      run,
    );
    expect(readPxf(await fs.readFile('/work/taken.pxf')).doc.meta.id).toBe(HERO_ID);
    const other = (await registry.execute('doc.create', { width: 4, height: 4 }, run)) as {
      doc: string;
    };
    const clash = await rejection(
      registry.execute(
        'doc.save',
        { doc: other.doc, path: '/work/taken.pxf', overwrite: true },
        run,
      ),
    );
    expect(clash.code).toBe('CONFLICT');
  });

  it('keeps the old path when the write fails', async () => {
    const { hero, fs, run } = await openHero();
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk full'));
    const failed = await rejection(
      registry.execute('doc.save', { doc: HERO_ID, path: '/work/v3.pxf' }, run),
    );
    expect(failed.code).toBe('IO_FAILED');
    expect(hero.path).toBe(HERO_PATH);
    expect(hero.savedVersion).toBe(0);
    expect(await fs.exists('/work/v3.pxf')).toBe(false);
  });
});
