import { DocumentStore, renderFrame, validate } from '@pixel-forge/core';
import { decodePng } from '@pixel-forge/png';
import { describe, expect, it } from 'vitest';
import {
  IoError,
  cc0SheetInputs,
  cellOffset,
  createDocumentFromSpritesheet,
  defaultOrigin,
  importSpritesheetTx,
} from '../src/index.js';
import {
  bytesEqual,
  cropCell,
  heroDocument,
  heroFile,
  heroSheetJson,
  ioCode,
  need,
  pngFromRows,
} from './helpers.js';

const legend = {
  R: [255, 0, 0, 255],
  G: [0, 255, 0, 255],
  B: [0, 0, 255, 255],
  O: [10, 10, 10, 255],
} as const;

describe('CC0 hero sheets', () => {
  const store = heroDocument();
  const sheet = heroSheetJson();

  it('validates with core validate() (no errors)', () => {
    const findings = validate(store);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('has the frame counts of sheet.json and the cell size as canvas', () => {
    expect(store.doc.meta.canvas).toEqual({ w: 64, h: 64 });
    expect(store.doc.meta.origin).toEqual({ x: 32, y: 63 });
    for (const [name, a] of Object.entries(sheet.animations)) {
      const anim = store.doc.animations.find((x) => x.group === name);
      expect(anim && 'frames' in anim && anim.frames.length).toBe(a.frames.length);
    }
    expect(store.doc.layers).toHaveLength(1);
    expect(store.doc.layers[0]?.name).toBe('body');
  });

  it('renders every frame equal to the source cell pixels (crop of the PNG is the oracle)', () => {
    let checked = 0;
    for (const [name, a] of Object.entries(sheet.animations)) {
      const png = decodePng(heroFile(a.file));
      a.frames.forEach(([row, col], i) => {
        const want = cropCell(png, row, col, 64, 64);
        const got = renderFrame(store, { group: name }, i).toRGBA().data;
        expect(bytesEqual(got, want), `${name}[${String(i)}]`).toBe(true);
        checked += 1;
      });
    }
    expect(checked).toBe(Object.values(sheet.animations).reduce((n, a) => n + a.frames.length, 0));
  });

  it('is one undoable transaction per import', () => {
    const before = store.version;
    const { store: fresh } = createDocumentFromSpritesheet(
      need(cc0SheetInputs(heroSheetJson(), heroFile)[0]),
    );
    expect(fresh.doc.animations).toHaveLength(1);
    expect(fresh.canUndo).toBe(true);
    fresh.undo();
    expect(fresh.doc.animations).toHaveLength(0);
    expect(fresh.doc.layers).toHaveLength(0);
    expect(store.version).toBe(before);
  });
});

describe('importSpritesheetTx', () => {
  // 3 cols x 2 rows of 2x2 cells. Cell (0,2) is empty. Cell (1,0) repeats (0,0).
  const sheetRows = ['RRGG..', 'RGGG..', 'RRBB..', 'RRBO..'];
  const png = pngFromRows(sheetRows, legend);

  it('creates frames for empty cells without cels and links repeated cells', () => {
    const { store, result } = createDocumentFromSpritesheet({
      png,
      cell: [2, 2],
      animations: [
        {
          group: 'walk',
          direction: 'side',
          frames: [
            [0, 0],
            [0, 1],
            [0, 2], // empty
            [0, 0], // repeat
          ],
          durationMs: 80,
        },
      ],
    });
    expect(result.frames).toBe(4);
    expect(result.imageCels).toBe(2);
    const anim = store.doc.animations[0];
    if (!anim || !('frames' in anim)) throw new Error('anim');
    expect(anim.direction).toBe('side');
    expect(anim.frames.map((f) => f.durationMs)).toEqual([80, 80, 80, 80]);
    const layer = store.doc.layers[0];
    if (layer?.kind !== 'pixel') throw new Error('layer');
    const ids = anim.frames.map((f) => f.id);
    expect(Object.keys(layer.cels)).toHaveLength(3);
    expect(layer.cels[need(ids[2])]).toBeUndefined();
    expect(layer.cels[need(ids[3])]).toEqual({ linkTo: ids[0] });
    expect(validate(store).filter((f) => f.severity === 'error')).toEqual([]);
    // The repeated frame renders like the first.
    expect(renderFrame(store, { group: 'walk', direction: 'side' }, 3).toRGBA().data).toEqual(
      renderFrame(store, { group: 'walk', direction: 'side' }, 0).toRGBA().data,
    );
    // The empty frame renders fully transparent.
    expect(renderFrame(store, { group: 'walk', direction: 'side' }, 2).bounds()).toBeUndefined();
  });

  it('derives the duration from fps, falls back to the default and honours loop', () => {
    const { store } = createDocumentFromSpritesheet({
      png,
      cell: [2, 2],
      defaultDurationMs: 33,
      animations: [
        { group: 'a', frames: [[0, 0]], fps: 12, loop: 'pingpong' },
        { group: 'b', frames: [[0, 1]] },
        { group: 'c', frames: [[0, 1]], durationMs: 5, fps: 1 },
      ],
    });
    const dur = (g: string): number | undefined => {
      const a = store.doc.animations.find((x) => x.group === g);
      return a && 'frames' in a ? a.frames[0]?.durationMs : undefined;
    };
    expect(dur('a')).toBe(83);
    expect(dur('b')).toBe(33);
    expect(dur('c')).toBe(5);
    const a = store.doc.animations[0];
    expect(a && 'loop' in a && a.loop).toBe('pingpong');
  });

  it('imports an outline sheet as a second layer above, with matching cels', () => {
    const outline = pngFromRows(['OO....', 'OO....', '......', '......'], legend);
    const { store, result } = createDocumentFromSpritesheet({
      png,
      cell: [2, 2],
      outlinePng: outline,
      outlineLayerName: 'lines',
      animations: [
        {
          group: 'idle',
          frames: [
            [0, 0],
            [0, 1],
          ],
        },
      ],
    });
    expect(store.doc.layers.map((l) => l.name)).toEqual(['body', 'lines']);
    expect(result.outlineLayer).toBe(store.doc.layers[1]?.id);
    const out = store.doc.layers[1];
    if (out?.kind !== 'pixel') throw new Error('layer');
    expect(Object.keys(out.cels)).toHaveLength(1); // cell (0,1) has no outline pixels
    const f0 = renderFrame(store, { group: 'idle' }, 0);
    expect(f0.get(0, 0)).toEqual([10, 10, 10, 255]); // outline drawn over the body
    const f1 = renderFrame(store, { group: 'idle' }, 1);
    expect(f1.get(0, 0)).toEqual([0, 255, 0, 255]);
  });

  it('places cels relative to the origin on a larger canvas and reuses an existing layer', () => {
    const { store } = createDocumentFromSpritesheet(
      { png, cell: [2, 2], animations: [{ group: 'a', frames: [[0, 0]] }] },
      { origin: { x: 1, y: 1 } },
    );
    store.transact('grow', (tx) => {
      tx.update((d) => {
        d.meta.canvas = { w: 8, h: 8 };
        d.meta.origin = { x: 4, y: 7 };
      });
      importSpritesheetTx(tx, {
        png,
        cell: [2, 2],
        animations: [{ group: 'b', frames: [[1, 1]] }],
      });
    });
    expect(store.doc.layers).toHaveLength(1);
    const f = renderFrame(store, { group: 'b' }, 0);
    // bottom-centre of the 2x2 cell: (1, 1) -> origin (4, 7): offset (3, 6)
    expect(f.get(3, 6)).toEqual([0, 0, 255, 255]);
    expect(f.get(4, 7)).toEqual([10, 10, 10, 255]);
    expect(cellOffset([2, 2], { x: 4, y: 7 })).toEqual({ x: 3, y: 6 });
    expect(defaultOrigin([64, 64])).toEqual({ x: 32, y: 63 });
  });

  it('refuses bad input before touching the document', () => {
    const base = { png, cell: [2, 2] as [number, number] };
    const anim = (frames: [number, number][], extra = {}) => ({ group: 'a', frames, ...extra });
    const mk = (input: Parameters<typeof createDocumentFromSpritesheet>[0]) => () =>
      createDocumentFromSpritesheet(input);
    expect(ioCode(mk({ ...base, animations: [] }))).toBe('BAD_INPUT');
    expect(ioCode(mk({ ...base, animations: [anim([])] }))).toBe('BAD_INPUT');
    expect(ioCode(mk({ ...base, animations: [anim([[2, 0]])] }))).toBe('CELL_OUT_OF_RANGE');
    expect(ioCode(mk({ ...base, animations: [anim([[0, 3]])] }))).toBe('CELL_OUT_OF_RANGE');
    expect(ioCode(mk({ ...base, animations: [anim([[-1, 0]])] }))).toBe('CELL_OUT_OF_RANGE');
    expect(ioCode(mk({ ...base, animations: [anim([[0, 0]]), anim([[0, 1]])] }))).toBe(
      'DUPLICATE_ANIMATION',
    );
    expect(ioCode(mk({ ...base, animations: [{ group: 'Bad Name', frames: [[0, 0]] }] }))).toBe(
      'BAD_INPUT',
    );
    expect(
      ioCode(mk({ ...base, animations: [{ group: 'a', direction: 'default', frames: [[0, 0]] }] })),
    ).toBe('BAD_INPUT');
    expect(ioCode(mk({ ...base, cell: [0, 2], animations: [anim([[0, 0]])] }))).toBe('BAD_INPUT');
    expect(ioCode(mk({ ...base, animations: [anim([[0, 0]], { durationMs: 0 })] }))).toBe(
      'BAD_INPUT',
    );
    expect(ioCode(mk({ ...base, animations: [anim([[0, 0]], { fps: 0 })] }))).toBe('BAD_INPUT');
    expect(ioCode(mk({ ...base, defaultDurationMs: 0, animations: [anim([[0, 0]])] }))).toBe(
      'BAD_INPUT',
    );
    expect(ioCode(mk({ ...base, layerName: 'No Good', animations: [anim([[0, 0]])] }))).toBe(
      'BAD_INPUT',
    );
    const small = pngFromRows(['RR', 'RR'], legend);
    expect(ioCode(mk({ ...base, outlinePng: small, animations: [anim([[0, 0]])] }))).toBe(
      'SIZE_MISMATCH',
    );

    // An existing animation also counts as a duplicate, and nothing leaks into the store.
    const { store } = createDocumentFromSpritesheet({ ...base, animations: [anim([[0, 0]])] });
    const v = store.version;
    const tx = store.begin('again');
    expect(ioCode(() => importSpritesheetTx(tx, { ...base, animations: [anim([[0, 1]])] }))).toBe(
      'DUPLICATE_ANIMATION',
    );
    tx.cancel();
    expect(store.version).toBe(v);
    expect(new IoError('BAD_INPUT', 'x').name).toBe('IoError');
    expect(store).toBeInstanceOf(DocumentStore);
  });
});

describe('cc0SheetInputs', () => {
  const read = heroFile;
  it('turns sheet.json into one input per animation', () => {
    const inputs = cc0SheetInputs(heroSheetJson(), read, {
      fps: 10,
      layerName: 'hero',
      loop: 'once',
    });
    expect(inputs.map((i) => i.animations[0]?.group)).toEqual(
      Object.keys(heroSheetJson().animations),
    );
    expect(inputs[0]?.layerName).toBe('hero');
    expect(inputs[0]?.animations[0]).toMatchObject({ fps: 10, loop: 'once' });
  });

  it('rejects malformed sheet.json', () => {
    const bad = (j: unknown) => () => cc0SheetInputs(j, read);
    expect(ioCode(bad(null))).toBe('BAD_INPUT');
    expect(ioCode(bad({ cell: [64], animations: {} }))).toBe('BAD_INPUT');
    expect(ioCode(bad({ cell: [64, 64] }))).toBe('BAD_INPUT');
    expect(ioCode(bad({ cell: [64, 64], animations: { a: { frames: [] } } }))).toBe('BAD_INPUT');
    expect(ioCode(bad({ cell: [64, 64], animations: { a: { file: 'idle.png' } } }))).toBe(
      'BAD_INPUT',
    );
    expect(
      ioCode(bad({ cell: [64, 64], animations: { a: { file: 'idle.png', frames: [[0]] } } })),
    ).toBe('BAD_INPUT');
  });
});
