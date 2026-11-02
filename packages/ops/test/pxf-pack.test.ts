// pxf.unpack / pxf.pack: the .pxfd folder form through the host file system.
import { describe, expect, it } from 'vitest';
import { registry } from '../src/index.js';
import { HERO_BYTES, HERO_PATH, heroHost, rejection } from './helpers.js';

describe('pxf.unpack / pxf.pack', () => {
  it('unpacks beside the file, then packs back to identical bytes', async () => {
    const { host, fs } = heroHost();
    const run = { host };
    const un = await registry.execute('pxf.unpack', { file: HERO_PATH }, run);
    expect(un).toEqual({ file: HERO_PATH, dir: '/work/hero.pxfd' });
    expect(await fs.exists('/work/hero.pxfd/document.json')).toBe(true);
    expect(await fs.exists('/work/hero.pxfd/.gdignore')).toBe(true);

    fs.seed('/work/hero.pxf', new Uint8Array(0));
    const packed = await registry.execute('pxf.pack', { dir: '/work/hero.pxfd' }, run);
    expect(packed).toEqual({ dir: '/work/hero.pxfd', file: '/work/hero.pxf' });
    expect(Buffer.from(await fs.readFile('/work/hero.pxf')).equals(Buffer.from(HERO_BYTES))).toBe(
      true,
    );
  });

  it('honours dir and file, refuses an existing folder unless overwrite', async () => {
    const { host } = heroHost();
    const run = { host };
    await registry.execute('pxf.unpack', { file: HERO_PATH, dir: '/work/x/h.pxfd' }, run);
    const again = await rejection(
      registry.execute('pxf.unpack', { file: HERO_PATH, dir: '/work/x/h.pxfd' }, run),
    );
    expect(again).toMatchObject({ code: 'CONFLICT' });
    await registry.execute(
      'pxf.unpack',
      { file: HERO_PATH, dir: '/work/x/h.pxfd', overwrite: true },
      run,
    );
    const out = await registry.execute(
      'pxf.pack',
      { dir: '/work/x/h.pxfd', file: '/work/y/copy.pxf' },
      run,
    );
    expect(out).toEqual({ dir: '/work/x/h.pxfd', file: '/work/y/copy.pxf' });
  });

  it('refuses names that are not .pxf / .pxfd and paths outside the roots', async () => {
    const { host } = heroHost();
    const run = { host };
    const cases: [string, Record<string, unknown>][] = [
      ['pxf.unpack', { file: '/work/hero.png' }],
      ['pxf.unpack', { file: HERO_PATH, dir: '/work/out' }],
      ['pxf.pack', { dir: '/work/folder' }],
      ['pxf.pack', { dir: '/work/a.pxfd', file: '/work/a.zip' }],
    ];
    for (const [op, input] of cases) {
      expect((await rejection(registry.execute(op, input, run))).code, op).toBe('BAD_INPUT');
    }
    const outside = await rejection(registry.execute('pxf.unpack', { file: '/etc/h.pxf' }, run));
    expect(outside.code).toBe('NOT_ALLOWED');
  });
});
