// cel.link: link, unlink, linkIdentical; one-hop links (I3), images released, refusals.
import { documentHash, validate } from '@pixel-forge/core';
import type { Cel } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { celLink, registry } from '../src/index.js';
import { HERO_ID, flatHost, need, openHero, rejection, stepLabels } from './helpers.js';

const errors = (store: Parameters<typeof validate>[0]) =>
  validate(store).filter((f) => f.severity === 'error' || f.code === 'IMAGE_ORPHAN');

async function setup() {
  const f = await flatHost();
  const frames = (group: string): string[] => {
    const a = f.store.doc.animations.find((x) => x.group === group);
    return a !== undefined && 'frames' in a ? a.frames.map((fr) => fr.id) : [];
  };
  const cel = (group: string, i: number): Cel | undefined => {
    const layer = f.store.doc.layers.find((l) => l.name === 'body');
    return layer !== undefined && 'cels' in layer
      ? (layer.cels as Record<string, Cel>)[need(frames(group)[i])]
      : undefined;
  };
  return { ...f, frames, cel };
}

describe('cel.link', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await setup();
    const bad = await rejection(
      registry.execute('cel.link', { doc: HERO_ID, layer: 'body', mode: 'swap' }, run),
    );
    expect(bad.code).toBe('BAD_INPUT');
    expect(bad.details.issues).toEqual([{ path: 'mode', message: expect.any(String) as string }]);
    const missing = await rejection(
      registry.execute(
        'cel.link',
        { doc: HERO_ID, layer: 'body', mode: 'link', animation: { group: 'run' } },
        run,
      ),
    );
    expect(missing).toMatchObject({ code: 'BAD_INPUT' });
    expect(missing.details.issues).toEqual([
      { path: 'source', message: expect.any(String) as string },
    ]);
  });

  it('runs its example (linkIdentical) as one undo step and releases the freed image', async () => {
    const { hosted, run, cel, store } = await setup();
    const before = documentHash(store);
    const images = store.imageIds().length;
    const out = await registry.execute('cel.link', need(celLink.examples[0]).input, run);
    expect(out).toEqual({ mode: 'linkIdentical', changed: 1, imagesDeleted: 1 });
    expect(cel('run_copy', 0)).toEqual({
      linkTo: need(
        store.doc.animations[0] && 'frames' in store.doc.animations[0]
          ? store.doc.animations[0].frames[0]?.id
          : undefined,
      ),
    });
    expect(store.imageIds()).toHaveLength(images - 1);
    expect(stepLabels(hosted)).toEqual(['AI: cel.link']);
    expect(errors(store)).toEqual([]);
    store.undo();
    expect(documentHash(store)).toBe(before);
    // nothing left to link: a no-op records nothing
    await registry.execute('cel.link', need(celLink.examples[0]).input, run);
    const again = await registry.call('cel.link', need(celLink.examples[0]).input, run);
    expect(again).toMatchObject({ ok: true, output: { changed: 0 }, doc: { undoEntry: null } });
  });

  it('links a cel to another frame, across animations and always in one hop', async () => {
    const { run, cel, frames, store } = await setup();
    const out = await registry.execute(
      'cel.link',
      {
        doc: HERO_ID,
        layer: 'body',
        mode: 'link',
        animation: { group: 'run' },
        frame: 2,
        source: { frame: 0 },
      },
      run,
    );
    expect(out).toMatchObject({ changed: 1, imagesDeleted: 1 });
    expect(cel('run', 2)).toEqual({ linkTo: need(frames('run')[0]) });
    // link to a link: resolves to the target
    await registry.execute(
      'cel.link',
      {
        doc: HERO_ID,
        layer: 'body',
        mode: 'link',
        animation: { group: 'run_copy' },
        frame: 0,
        source: { animation: { group: 'run' }, frame: 2 },
      },
      run,
    );
    expect(cel('run_copy', 0)).toEqual({ linkTo: need(frames('run')[0]) });
    const same = await registry.call(
      'cel.link',
      {
        doc: HERO_ID,
        layer: 'body',
        mode: 'link',
        animation: { group: 'run' },
        frame: 2,
        source: { frame: 0 },
      },
      run,
    );
    expect(same).toMatchObject({ ok: true, output: { changed: 0 } });
    expect(errors(store)).toEqual([]);
  });

  it('refuses self links, a missing source cel, cels others link to, and layers without cels', async () => {
    const { store, run } = await setup();
    const link = (extra: Record<string, unknown>) =>
      rejection(
        registry.execute(
          'cel.link',
          { doc: HERO_ID, layer: 'body', mode: 'link', animation: { group: 'run' }, ...extra },
          run,
        ),
      );
    expect((await link({ frame: 1, source: { frame: 1 } })).details.reason).toBe('self-link');
    // frame 1's cel is linked from frame 3 after this:
    await registry.execute(
      'cel.link',
      {
        doc: HERO_ID,
        layer: 'body',
        mode: 'link',
        animation: { group: 'run' },
        frame: 3,
        source: { frame: 1 },
      },
      run,
    );
    const linkedFrom = await link({ frame: 1, source: { frame: 0 } });
    expect(linkedFrom).toMatchObject({ code: 'REFUSED', details: { reason: 'linked-from' } });
    expect((await link({ frame: 1, source: { frame: 3 } })).details.reason).toBe('self-link'); // 3 links to 1
    store.transact('drop cel', (tx) => {
      tx.update((d) => {
        const layer = d.layers[0];
        const f =
          d.animations[0] && 'frames' in d.animations[0]
            ? d.animations[0].frames[2]?.id
            : undefined;
        if (layer !== undefined && 'cels' in layer && f !== undefined)
          Reflect.deleteProperty(layer.cels, f);
      });
    });
    expect((await link({ frame: 0, source: { frame: 2 } })).details.reason).toBe('no-source-cel');
    const { run: heroRun } = await openHero();
    const parts = await rejection(
      registry.execute('cel.link', { doc: HERO_ID, layer: 'head', mode: 'linkIdentical' }, heroRun),
    );
    expect(parts).toMatchObject({ code: 'REFUSED', details: { reason: 'no-cels' } });
  });

  it('unlinks a cel: it gets its own copy of the pixels; an own cel is left alone', async () => {
    const { run, cel, store } = await setup();
    await registry.execute('cel.link', need(celLink.examples[0]).input, run);
    const images = store.imageIds().length;
    const unlink = {
      doc: HERO_ID,
      layer: 'body',
      mode: 'unlink',
      animation: { group: 'run_copy' },
      frame: 0,
    };
    expect(await registry.execute('cel.link', unlink, run)).toMatchObject({ changed: 1 });
    const own = need(cel('run_copy', 0));
    expect('imageId' in own).toBe(true);
    expect(store.imageIds()).toHaveLength(images + 1);
    expect(errors(store)).toEqual([]);
    const second = await registry.call('cel.link', unlink, run);
    expect(second).toMatchObject({ ok: true, output: { changed: 0 }, doc: { undoEntry: null } });
    const none = await rejection(
      registry.execute('cel.link', { ...unlink, animation: { group: 'run' }, frame: 9 }, run),
    );
    expect(none.code).toBe('NOT_FOUND');
  });
});
