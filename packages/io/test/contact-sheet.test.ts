import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePng } from '@pixel-forge/png';
import { describe, expect, it } from 'vitest';
import { contactSheet, contactSheetPlan, createDocumentFromSpritesheet } from '../src/index.js';
import { heroDocument, ioCode, need, pngFromRows } from './helpers.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Number of pixels exactly white (the label colour) inside a rectangle. */
function whiteIn(
  img: { get(x: number, y: number): readonly number[] },
  x0: number,
  y0: number,
  w: number,
  h: number,
): number {
  let n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p = img.get(x, y);
      if (p[0] === 255 && p[1] === 255 && p[2] === 255 && p[3] === 255) n += 1;
    }
  }
  return n;
}

describe('contactSheet', () => {
  const hero = heroDocument();

  it('respects the long-edge limit (default 1568) and reports its plan', () => {
    const plan = contactSheetPlan(hero);
    expect(Math.max(plan.width, plan.height)).toBeLessThanOrEqual(1568);
    expect(plan.tiles).toHaveLength(22); // CC0 hero: 2 + 8 + 4 + 5 + 3 frames
    const img = contactSheet(hero);
    expect(img.width).toBe(plan.width);
    expect(img.height).toBe(plan.height);
    expect(plan.tiles[0]?.label).toBe('idle #0');
    expect(plan.tiles[21]?.label).toBe('slide #2');
  });

  it('honours smaller limits by reducing the scale, never below 1', () => {
    const small = contactSheetPlan(hero, { maxLongEdge: 800, scale: 4 });
    expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(800);
    expect(small.scale).toBeLessThan(4);
    const tight = contactSheetPlan(hero, { maxLongEdge: 600 });
    expect(Math.max(tight.width, tight.height)).toBeLessThanOrEqual(600);
    expect(ioCode(() => contactSheetPlan(hero, { maxLongEdge: 100 }))).toBe('TOO_LARGE');
  });

  it('uses an explicit scale when it fits and the largest fitting scale by default', () => {
    const { store } = createDocumentFromSpritesheet({
      png: pngFromRows(['RRRR', 'RRRR'], { R: [255, 0, 0, 255] }),
      cell: [2, 2],
      animations: [
        {
          group: 'a',
          frames: [
            [0, 0],
            [0, 1],
          ],
        },
      ],
    });
    expect(contactSheetPlan(store, { scale: 3 }).scale).toBe(3);
    expect(contactSheetPlan(store).scale).toBe(16);
    expect(contactSheetPlan(store, { maxLongEdge: 40 }).scale).toBeLessThan(16);
  });

  it('draws labels as white pixels under each frame and none when labels = false', () => {
    const plan = contactSheetPlan(hero, { scale: 1 });
    const withLabels = contactSheet(hero, { scale: 1 });
    const without = contactSheet(hero, { scale: 1, labels: false });
    const t = need(plan.tiles[3]);
    const labelY = t.y + 2 + 64 + 2;
    expect(whiteIn(withLabels, t.x, labelY, plan.tileW, 12)).toBeGreaterThan(10);
    expect(without.height).toBeLessThan(withLabels.height);
    expect(without.width).toBeLessThanOrEqual(withLabels.width);
    // The art itself is also present: some non-background, non-checker colour exists in tile 0.
    const first = need(plan.tiles[0]);
    let coloured = 0;
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const p = withLabels.get(first.x + Math.floor((plan.tileW - 64) / 2) + x, first.y + 2 + y);
        if (p[0] !== p[1] || p[1] !== p[2]) coloured += 1;
      }
    expect(coloured).toBeGreaterThan(50);
  });

  it('frame pixels are the integer-scaled render over the checkerboard', () => {
    const { store } = createDocumentFromSpritesheet({
      png: pngFromRows(['R.', '..'], { R: [255, 0, 0, 255] }),
      cell: [2, 2],
      animations: [{ group: 'a', frames: [[0, 0]] }],
    });
    const plan = contactSheetPlan(store, { scale: 4, labels: false });
    const img = contactSheet(store, { scale: 4, labels: false });
    const fx = Math.floor((plan.tileW - 8) / 2);
    expect(img.get(fx, 2)).toEqual([255, 0, 0, 255]);
    expect(img.get(fx + 3, 5)).toEqual([255, 0, 0, 255]);
    const bg = img.get(fx + 4, 2); // next source pixel is transparent: checkerboard
    expect(bg[0]).toBe(bg[1]);
    expect(bg[3]).toBe(255);
    expect(bg[0]).not.toBe(0);
  });

  it('draws origin and marker overlays', () => {
    const { store } = createDocumentFromSpritesheet({
      png: pngFromRows(['..', '..'], {}),
      cell: [2, 2],
      animations: [{ group: 'a', frames: [[0, 0]] }],
    });
    store.transact('marker', (tx) => {
      tx.update((d) => {
        const a = d.animations[0];
        if (a && 'frames' in a && a.frames[0]) a.frames[0].markers = { hand: { x: 0, y: 0 } };
      });
    });
    const plan = contactSheetPlan(store, { scale: 2, labels: false });
    const img = contactSheet(store, {
      scale: 2,
      labels: false,
      overlay: { origin: true, markers: true },
    });
    const fx = Math.floor((plan.tileW - 4) / 2);
    expect(img.get(fx, 2)).toEqual([0, 255, 255, 255]); // marker at (0, 0)
    expect(img.get(fx + 2, 2 + 2)).toEqual([255, 0, 255, 255]); // origin (1, 1)
  });

  it('selects animations, and refuses bad options', () => {
    const plan = contactSheetPlan(hero, { animations: [{ group: 'idle' }] });
    expect(plan.tiles).toHaveLength(2);
    expect(ioCode(() => contactSheetPlan(hero, { scale: 17 }))).toBe('BAD_INPUT');
    expect(ioCode(() => contactSheetPlan(hero, { maxLongEdge: 0 }))).toBe('BAD_INPUT');
    expect(ioCode(() => contactSheetPlan(hero, { animations: [] }))).toBe('BAD_INPUT');
  });

  it('writes the hero sheet to .golden-diff/ for a reviewer to look at', () => {
    const img = contactSheet(hero, { overlay: { origin: true } });
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1568);
    const dir = repoRoot + '.golden-diff/';
    mkdirSync(dir, { recursive: true });
    const { width, height, data } = img.toRGBA();
    writeFileSync(
      dir + 'io-contact-sheet-hero.png',
      encodePng({ width, height, data, kind: 'rgba' }),
    );
  });
});
