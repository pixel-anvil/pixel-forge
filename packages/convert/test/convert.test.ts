import { describe, expect, it } from 'vitest';
import { hashRGBA } from '@pixel-forge/raster';
import type { RgbaImage } from '@pixel-forge/raster';
import {
  ConvertError,
  autoKeyColor,
  cropImage,
  removeBackground,
  rgbDistanceSq,
} from '../src/index.js';
import type { ConvertErrorCode } from '../src/index.js';

/**
 * Oracles are hand-written ASCII pictures: `.` = red (background), `#` = blue, `o` = green,
 * `~` = near red (250,5,5), `-` = half transparent blue, `_` = fully transparent.
 */
const PALETTE: Record<string, readonly [number, number, number, number]> = {
  '.': [255, 0, 0, 255],
  '#': [0, 0, 255, 255],
  o: [0, 255, 0, 255],
  '~': [250, 5, 5, 255],
  '-': [0, 0, 255, 128],
  _: [0, 0, 0, 0],
};

function fromAscii(rows: readonly string[]): RgbaImage {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const data = new Uint8Array(w * h * 4);
  rows.forEach((row, y) => {
    row.split('').forEach((ch, x) => {
      const c = PALETTE[ch];
      if (!c) throw new Error(`bad char ${ch}`);
      data.set(c, (y * w + x) * 4);
    });
  });
  return { width: w, height: h, data };
}

/** ASCII of an image: `_` for alpha 0, else the palette char with equal RGBA, else `?`. */
function toAscii(img: RgbaImage): string[] {
  const rows: string[] = [];
  for (let y = 0; y < img.height; y++) {
    let row = '';
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      const px = [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
      const hit = Object.entries(PALETTE).find(([, c]) => c.every((v, i) => v === px[i]));
      row += hit ? hit[0] : '?';
    }
    rows.push(row);
  }
  return rows;
}

function code(fn: () => unknown): ConvertErrorCode | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConvertError) return e.code;
    throw e;
  }
  return undefined;
}

describe('cropImage', () => {
  const img = fromAscii(['.#o.', '#o.#', 'o.#o']);

  it('copies the rectangle into a new image', () => {
    const out = cropImage(img, { x: 1, y: 1, w: 2, h: 2 });
    expect(toAscii(out)).toEqual(['o.', '.#']);
    expect(out.data).not.toBe(img.data);
  });

  it('full-image crop equals the input and does not alias it', () => {
    const out = cropImage(img, { x: 0, y: 0, w: 4, h: 3 });
    expect(out.data).toEqual(img.data);
    expect(out.data).not.toBe(img.data);
  });

  it('works on a 1x1 image', () => {
    const one = fromAscii(['#']);
    expect(toAscii(cropImage(one, { x: 0, y: 0, w: 1, h: 1 }))).toEqual(['#']);
  });

  it.each([
    [{ x: -1, y: 0, w: 1, h: 1 }],
    [{ x: 0, y: -1, w: 1, h: 1 }],
    [{ x: 3, y: 0, w: 2, h: 1 }],
    [{ x: 0, y: 2, w: 1, h: 2 }],
    [{ x: 0, y: 0, w: 0, h: 1 }],
    [{ x: 0, y: 0, w: 1, h: -1 }],
    [{ x: 0.5, y: 0, w: 1, h: 1 }],
    [{ x: 0, y: 0, w: Number.NaN, h: 1 }],
  ])('refuses %j', (rect) => {
    expect(code(() => cropImage(img, rect))).toBe('BAD_RECT');
  });

  it('refuses a malformed image', () => {
    expect(
      code(() =>
        cropImage({ width: 2, height: 2, data: new Uint8Array(3) }, { x: 0, y: 0, w: 1, h: 1 }),
      ),
    ).toBe('BAD_IMAGE');
  });
});

describe('removeBackground', () => {
  const sheet = fromAscii(['....', '.##.', '.#o.', '....']);

  it('none returns an equal copy', () => {
    const out = removeBackground(sheet, { mode: 'none' });
    expect(out.data).toEqual(sheet.data);
    expect(out.data).not.toBe(sheet.data);
  });

  it('does not change the input', () => {
    const before = sheet.data.slice();
    removeBackground(sheet, { mode: 'key', tolerance: 10 });
    removeBackground(sheet, { mode: 'flood' });
    removeBackground(sheet, { mode: 'alpha', threshold: 255 });
    expect(sheet.data).toEqual(before);
  });

  describe('key', () => {
    it('explicit colour, tolerance 0 is an exact match', () => {
      const img = fromAscii(['.~#', '~.#']);
      const out = removeBackground(img, { mode: 'key', color: [255, 0, 0] });
      expect(toAscii(out)).toEqual(['_~#', '~_#']);
    });

    it('tolerance reaches near colours (distance sqrt(75) = 8.66)', () => {
      const img = fromAscii(['.~#']);
      expect(
        toAscii(removeBackground(img, { mode: 'key', color: [255, 0, 0], tolerance: 8 })),
      ).toEqual(['_~#']);
      expect(
        toAscii(removeBackground(img, { mode: 'key', color: [255, 0, 0], tolerance: 9 })),
      ).toEqual(['__#']);
    });

    it('auto uses the corner colour and clears it everywhere, enclosed or not', () => {
      const img = fromAscii(['....', '.#..', '.#o.', '....']);
      const out = removeBackground(img, { mode: 'key' });
      expect(toAscii(out)).toEqual(['____', '_#__', '_#o_', '____']);
    });

    it('1x1 image', () => {
      expect(toAscii(removeBackground(fromAscii(['.']), { mode: 'key' }))).toEqual(['_']);
    });

    it('does not touch semi-transparent pixels unless their RGB matches', () => {
      const img = fromAscii(['.-.']);
      // '-' is blue; key red leaves it alone
      expect(toAscii(removeBackground(img, { mode: 'key', color: [255, 0, 0] }))).toEqual(['_-_']);
    });

    it('refuses bad options', () => {
      const bad = (o: Parameters<typeof removeBackground>[1]): ConvertErrorCode | undefined =>
        code(() => removeBackground(sheet, o));
      expect(bad({ mode: 'key', tolerance: -1 })).toBe('BAD_OPTION');
      expect(bad({ mode: 'key', tolerance: 443 })).toBe('BAD_OPTION');
      expect(bad({ mode: 'key', tolerance: Number.NaN })).toBe('BAD_OPTION');
      expect(bad({ mode: 'flood', color: [256, 0, 0] })).toBe('BAD_OPTION');
      expect(bad({ mode: 'key', color: [1.5, 0, 0] })).toBe('BAD_OPTION');
      expect(bad({ mode: 'alpha', threshold: 256 })).toBe('BAD_OPTION');
      expect(bad({ mode: 'alpha', threshold: 1.5 })).toBe('BAD_OPTION');
    });
  });

  describe('auto colour', () => {
    it('majority of the corners wins', () => {
      const img = fromAscii(['.#', '#.'].map((r) => r)); // TL red, TR blue, BL blue, BR red -> tie
      expect(autoKeyColor(img)).toEqual([255, 0, 0]); // tie: first in TL,TR,BL,BR order
      const three = fromAscii(['.#', '##']);
      expect(autoKeyColor(three)).toEqual([0, 0, 255]);
    });

    it('disagreeing corners: 2 vs 1 vs 1 picks the pair', () => {
      const img = fromAscii(['#o', '.o']);
      expect(autoKeyColor(img)).toEqual([0, 255, 0]);
    });

    it('all four different picks the top-left', () => {
      const img = fromAscii(['#o', '.~']);
      expect(autoKeyColor(img)).toEqual([0, 0, 255]);
    });

    it('skips transparent corners; all transparent gives undefined', () => {
      expect(autoKeyColor(fromAscii(['_o', '_o']))).toEqual([0, 255, 0]);
      const clear = fromAscii(['__', '__']);
      expect(autoKeyColor(clear)).toBeUndefined();
      expect(removeBackground(clear, { mode: 'key' }).data).toEqual(clear.data);
    });

    it('1x1 image corners are the same pixel', () => {
      expect(autoKeyColor(fromAscii(['o']))).toEqual([0, 255, 0]);
    });
  });

  describe('flood', () => {
    it('clears the border-connected background only', () => {
      const out = removeBackground(sheet, { mode: 'flood' });
      expect(toAscii(out)).toEqual(['____', '_##_', '_#o_', '____']);
    });

    it('does not leak into an enclosed same-colour region', () => {
      const img = fromAscii(['.......', '.#####.', '.#...#.', '.#...#.', '.#####.', '.......']);
      const out = removeBackground(img, { mode: 'flood' });
      expect(toAscii(out)).toEqual([
        '_______',
        '_#####_',
        '_#...#_',
        '_#...#_',
        '_#####_',
        '_______',
      ]);
      // the same picture with key clears the hole as well
      expect(toAscii(removeBackground(img, { mode: 'key' }))[2]).toBe('_#___#_');
    });

    it('is 4-connected: a diagonal gap does not let it in', () => {
      const img = fromAscii(['.#..', '#.#.', '.#..', '....'].map((r) => r));
      // the red at (1,1) touches the outside only diagonally
      const out = removeBackground(img, { mode: 'flood' });
      expect(toAscii(out)[1]).toBe('#.#_');
    });

    it('reaches around a wall that is open at one end', () => {
      const img = fromAscii(['.....', '.###.', '.#.#.', '.#...', '.....']);
      // inner red (2,2) connects through (2,3)/(3,3)/(4,3) to the border
      const out = removeBackground(img, { mode: 'flood' });
      expect(toAscii(out)).toEqual(['_____', '_###_', '_#_#_', '_#___', '_____']);
    });

    it('tolerance 0 stops at near colours, tolerance includes them', () => {
      const img = fromAscii(['.~.', '.#.', '...']);
      expect(toAscii(removeBackground(img, { mode: 'flood' }))[0]).toBe('_~_');
      expect(toAscii(removeBackground(img, { mode: 'flood', tolerance: 9 }))[0]).toBe('___');
    });

    it('compares with the reference, so a slow gradient does not creep', () => {
      // 5 pixels, red channel steps by 4 each; tolerance 5 from the first only reaches the second
      const data = new Uint8Array(5 * 4);
      for (let i = 0; i < 5; i++) data.set([255 - 4 * i, 0, 0, 255], i * 4);
      const out = removeBackground({ width: 5, height: 1, data }, { mode: 'flood', tolerance: 5 });
      // all five pixels are on the border row, but only those within 5 of the reference match;
      // the last corner (colour 239) is a seed and is far from the reference
      expect([...out.data.filter((_, i) => i % 4 === 3)]).toEqual([0, 0, 255, 255, 255]);
    });

    it('already transparent pixels are passable', () => {
      const img = fromAscii(['.._', '.#_', '...']);
      const out = removeBackground(img, { mode: 'flood' });
      expect(toAscii(out)).toEqual(['___', '_#_', '___']);
    });

    it('1x1 image and an image that is all background', () => {
      expect(toAscii(removeBackground(fromAscii(['.']), { mode: 'flood' }))).toEqual(['_']);
      expect(toAscii(removeBackground(fromAscii(['..', '..']), { mode: 'flood' }))).toEqual([
        '__',
        '__',
      ]);
    });

    it('an explicit colour that is not at the border clears nothing', () => {
      const out = removeBackground(sheet, { mode: 'flood', color: [0, 255, 0] });
      expect(out.data).toEqual(sheet.data);
    });
  });

  describe('alpha', () => {
    it('threshold 0 or none keeps everything', () => {
      const img = fromAscii(['-#_']);
      expect(removeBackground(img, { mode: 'alpha' }).data).toEqual(img.data);
      expect(removeBackground(img, { mode: 'alpha', threshold: 0 }).data).toEqual(img.data);
    });

    it('threshold clears pixels below it and keeps the rest unchanged', () => {
      const img = fromAscii(['-#_']);
      expect(toAscii(removeBackground(img, { mode: 'alpha', threshold: 128 }))).toEqual(['-#_']);
      expect(toAscii(removeBackground(img, { mode: 'alpha', threshold: 129 }))).toEqual(['_#_']);
      expect(toAscii(removeBackground(img, { mode: 'alpha', threshold: 255 }))).toEqual(['_#_']);
    });
  });
});

describe('rgbDistanceSq', () => {
  it('is the squared Euclidean distance', () => {
    expect(rgbDistanceSq(0, 0, 0, 3, 4, 12)).toBe(169);
  });
});

describe('determinism', () => {
  /** 48x32 image from an integer LCG: a background with noise around a blob. */
  function scene(): RgbaImage {
    const w = 48;
    const h = 32;
    const data = new Uint8Array(w * h * 4);
    let s = 2024;
    const rnd = (): number => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return s >>> 16;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inBlob = (x - 24) * (x - 24) + (y - 16) * (y - 16) < 120;
        const o = (y * w + x) * 4;
        if (inBlob) data.set([40 + (rnd() & 15), 90 + (rnd() & 15), 200, 255], o);
        else data.set([250 + (rnd() & 3), 240 + (rnd() & 7), 10 + (rnd() & 3), 255], o);
      }
    }
    return { width: w, height: h, data };
  }

  const runAll = (): string[] => {
    const img = scene();
    const c = cropImage(img, { x: 4, y: 2, w: 40, h: 28 });
    return [
      hashRGBA(c),
      hashRGBA(removeBackground(c, { mode: 'key', tolerance: 20 })),
      hashRGBA(removeBackground(c, { mode: 'flood', tolerance: 20 })),
      hashRGBA(removeBackground(c, { mode: 'alpha', threshold: 1 })),
    ];
  };

  it('same input, same hashes, run twice', () => {
    expect(runAll()).toEqual(runAll());
  });

  it('key and flood agree on a scene with no enclosed background, and clear the blob outside', () => {
    const [, key, flood] = runAll();
    expect(key).toBe(flood);
  });

  it('pinned hashes', () => {
    expect(runAll()).toEqual(EXPECTED_HASHES);
  });
});

const EXPECTED_HASHES: string[] = [
  'a341b4e6ac223700851971872442554ecc6bae85132b6bbe4efd5b5f312413c2', // crop
  '874b518930f298688adbc58780ee5c0237e839d306083e7c97aab5b970dbf6ca', // key, tolerance 20
  '874b518930f298688adbc58780ee5c0237e839d306083e7c97aab5b970dbf6ca', // flood, tolerance 20
  'a341b4e6ac223700851971872442554ecc6bae85132b6bbe4efd5b5f312413c2', // alpha (all opaque: equals crop)
];
