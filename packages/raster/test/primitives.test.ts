import { asciiToImage, expectAscii } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import {
  brushMask,
  ellipse,
  floodFill,
  IndexedImage,
  line,
  pixelPerfect,
  rect,
  TiledImage,
} from '../src/index.js';
import type { Rgba } from '../src/index.js';
import { rng } from './util.js';

const R: Rgba = [255, 0, 0, 255];
const B: Rgba = [0, 0, 255, 255];
const legend = { '#': R, B, '.': [0, 0, 0, 0] } as const;

function draw(
  w: number,
  h: number,
  f: (img: TiledImage) => void,
): ReturnType<TiledImage['toRGBA']> {
  const img = new TiledImage(w, h);
  f(img);
  return img.toRGBA();
}
const from = (ascii: string): TiledImage => TiledImage.fromRGBA(asciiToImage(ascii, legend));

function pixelSet(img: TiledImage): string {
  const { width, height, data } = img.toRGBA();
  const out: string[] = [];
  for (let i = 0; i < width * height; i++) if (data[i * 4 + 3] !== 0) out.push(String(i));
  return out.join(',');
}

describe('line: ASCII expectations', () => {
  it('single pixel', () => {
    expectAscii(
      draw(3, 3, (i) => {
        line(i, 1, 1, 1, 1, R);
      }),
      '...\n.#.\n...',
      legend,
    );
  });

  it('horizontal and vertical', () => {
    expectAscii(
      draw(5, 3, (i) => {
        line(i, 0, 1, 4, 1, R);
      }),
      '.....\n#####\n.....',
      legend,
    );
    expectAscii(
      draw(3, 5, (i) => {
        line(i, 1, 0, 1, 4, R);
      }),
      '.#.\n.#.\n.#.\n.#.\n.#.',
      legend,
    );
  });

  it('shallow (dx > dy) and steep (dy > dx)', () => {
    expectAscii(
      draw(8, 4, (i) => {
        line(i, 0, 0, 7, 3, R);
      }),
      '##......\n..##....\n....##..\n......##',
      legend,
    );
    expectAscii(
      draw(4, 8, (i) => {
        line(i, 0, 0, 3, 7, R);
      }),
      '#...\n#...\n.#..\n.#..\n..#.\n..#.\n...#\n...#',
      legend,
    );
  });

  it('diagonals', () => {
    expectAscii(
      draw(5, 5, (i) => {
        line(i, 0, 0, 4, 4, R);
      }),
      '#....\n.#...\n..#..\n...#.\n....#',
      legend,
    );
    expectAscii(
      draw(5, 5, (i) => {
        line(i, 0, 4, 4, 0, R);
      }),
      '....#\n...#.\n..#..\n.#...\n#....',
      legend,
    );
  });

  // From the centre (3,3) to (3±3, 3±1) and (3±1, 3±3): the ideal line never hits a pixel-edge midpoint,
  // so each expectation is unambiguous (hand-derived from y = 3 + dy/dx * (x - 3), rounded).
  const octants: [string, number, number, string][] = [
    ['E-SE', 6, 4, '.......\n.......\n.......\n...##..\n.....##\n.......\n.......'],
    ['E-NE', 6, 2, '.......\n.......\n.....##\n...##..\n.......\n.......\n.......'],
    ['W-SW', 0, 4, '.......\n.......\n.......\n..##...\n##.....\n.......\n.......'],
    ['W-NW', 0, 2, '.......\n.......\n##.....\n..##...\n.......\n.......\n.......'],
    ['S-SE', 4, 6, '.......\n.......\n.......\n...#...\n...#...\n....#..\n....#..'],
    ['N-NE', 4, 0, '....#..\n....#..\n...#...\n...#...\n.......\n.......\n.......'],
    ['S-SW', 2, 6, '.......\n.......\n.......\n...#...\n...#...\n..#....\n..#....'],
    ['N-NW', 2, 0, '..#....\n..#....\n...#...\n...#...\n.......\n.......\n.......'],
  ];
  it.each(octants)('octant %s', (_name, x, y, ascii) => {
    expectAscii(
      draw(7, 7, (i) => {
        line(i, 3, 3, x, y, R);
      }),
      ascii,
      legend,
    );
  });

  it('clips at the canvas edge without throwing', () => {
    expectAscii(
      draw(3, 1, (i) => {
        line(i, -5, 0, 10, 0, R);
      }),
      '###',
      legend,
    );
  });

  it('is symmetric: A to B and B to A set the same pixels (1000 seeded random lines)', () => {
    const r = rng(12345);
    const n = (): number => Math.floor(r() * 24) - 4; // some endpoints are off-canvas
    for (let k = 0; k < 1000; k++) {
      const [x0, y0, x1, y1] = [n(), n(), n(), n()];
      const a = new TiledImage(20, 20);
      const b = new TiledImage(20, 20);
      line(a, x0, y0, x1, y1, R);
      line(b, x1, y1, x0, y0, R);
      expect(pixelSet(a), [x0, y0, x1, y1].join(',')).toBe(pixelSet(b));
    }
  });

  it('ties are broken the same way both ways: (0,0)-(6,2)', () => {
    const ascii = '##.....\n..###..\n.....##';
    expectAscii(
      draw(7, 3, (i) => {
        line(i, 0, 0, 6, 2, R);
      }),
      ascii,
      legend,
    );
    expectAscii(
      draw(7, 3, (i) => {
        line(i, 6, 2, 0, 0, R);
      }),
      ascii,
      legend,
    );
  });

  it('draws with a palette index on an IndexedImage', () => {
    const img = new IndexedImage(4, 1);
    line(img, 0, 0, 3, 0, 5);
    expect([...img.toIndices()]).toEqual([5, 5, 5, 5]);
  });

  it('rejects non-integer coordinates', () => {
    expect(() => {
      line(new TiledImage(4, 4), 0.5, 0, 3, 0, R);
    }).toThrow();
  });
});

describe('brushes', () => {
  const rows = (shape: 'square' | 'round', size: number): string => {
    const m = brushMask({ shape, size });
    let s = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) s += m.cells[y * size + x] ? '#' : '.';
      s += y < size - 1 ? '\n' : '';
    }
    return s;
  };

  it('round masks (hand-checked)', () => {
    expect(rows('round', 1)).toBe('#');
    expect(rows('round', 2)).toBe('##\n##');
    expect(rows('round', 3)).toBe('.#.\n###\n.#.');
    expect(rows('round', 4)).toBe('.##.\n####\n####\n.##.');
    expect(rows('round', 5)).toBe('.###.\n#####\n#####\n#####\n.###.');
  });

  it('square masks are full; every mask is symmetric; sizes outside 1..8 throw', () => {
    for (let s = 1; s <= 8; s++) {
      expect(rows('square', s).split('#').length - 1).toBe(s * s);
      const m = brushMask({ shape: 'round', size: s });
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          expect(m.cells[y * s + x]).toBe(m.cells[y * s + (s - 1 - x)]);
          expect(m.cells[y * s + x]).toBe(m.cells[(s - 1 - y) * s + x]);
        }
      }
    }
    expect(() => brushMask({ shape: 'square', size: 0 })).toThrow(RangeError);
    expect(() => brushMask({ shape: 'square', size: 9 })).toThrow(RangeError);
  });

  it('a square brush of size 3 thickens a line around the centre', () => {
    expectAscii(
      draw(7, 5, (i) => {
        line(i, 2, 2, 4, 2, R, { brush: { shape: 'square', size: 3 } });
      }),
      '.......\n.#####.\n.#####.\n.#####.\n.......',
      legend,
    );
  });

  it('even size 2 extends up/left of the stamp point; brush overhanging the canvas is clipped', () => {
    expectAscii(
      draw(4, 4, (i) => {
        line(i, 1, 1, 1, 1, R, { brush: { shape: 'square', size: 2 } });
      }),
      '##..\n##..\n....\n....',
      legend,
    );
    expectAscii(
      draw(2, 2, (i) => {
        line(i, 0, 0, 0, 0, R, { brush: { shape: 'round', size: 3 } });
      }),
      '##\n#.',
      legend,
    );
  });

  it('a round brush line is symmetric too', () => {
    const r = rng(7);
    for (let k = 0; k < 100; k++) {
      const p = Array.from({ length: 4 }, () => Math.floor(r() * 20));
      const brush = { shape: 'round', size: 1 + Math.floor(r() * 8) } as const;
      const a = new TiledImage(20, 20);
      const b = new TiledImage(20, 20);
      line(a, p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0, R, { brush });
      line(b, p[2] ?? 0, p[3] ?? 0, p[0] ?? 0, p[1] ?? 0, R, { brush });
      expect(pixelSet(a)).toBe(pixelSet(b));
    }
  });
});

describe('rect', () => {
  it('outline', () => {
    expectAscii(
      draw(6, 5, (i) => {
        rect(i, 1, 1, 4, 3, R);
      }),
      '......\n.####.\n.#..#.\n.####.\n......',
      legend,
    );
  });
  it('fill', () => {
    expectAscii(
      draw(6, 5, (i) => {
        rect(i, 1, 1, 4, 3, R, { fill: true });
      }),
      '......\n.####.\n.####.\n.####.\n......',
      legend,
    );
  });
  it('1xN and 1x1 outlines are solid; empty sizes draw nothing', () => {
    expectAscii(
      draw(3, 3, (i) => {
        rect(i, 1, 0, 1, 3, R);
      }),
      '.#.\n.#.\n.#.',
      legend,
    );
    expectAscii(
      draw(2, 2, (i) => {
        rect(i, 1, 1, 1, 1, R);
      }),
      '..\n.#',
      legend,
    );
    expectAscii(
      draw(2, 2, (i) => {
        rect(i, 0, 0, 0, 2, R);
      }),
      '..\n..',
      legend,
    );
  });
  it('clips to the canvas (outline edges outside are not drawn)', () => {
    expectAscii(
      draw(4, 3, (i) => {
        rect(i, 2, 1, 5, 4, R);
      }),
      '....\n..##\n..#.',
      legend,
    );
  });
});

describe('ellipse', () => {
  const outline: [number, number, string][] = [
    [1, 1, '#'],
    [2, 2, '##\n##'],
    [3, 3, '.#.\n#.#\n.#.'],
    [4, 3, '.##.\n#..#\n.##.'],
    [5, 5, '.###.\n#...#\n#...#\n#...#\n.###.'],
    [8, 6, '..####..\n.#....#.\n#......#\n#......#\n.#....#.\n..####..'],
  ];
  it.each(outline)('outline %ix%i', (w, h, ascii) => {
    expectAscii(
      draw(w, h, (i) => {
        ellipse(i, 0, 0, w - 1, h - 1, R);
      }),
      ascii,
      legend,
    );
  });

  const filled: [number, number, string][] = [
    [1, 1, '#'],
    [2, 2, '##\n##'],
    [3, 3, '.#.\n###\n.#.'],
    [4, 3, '.##.\n####\n.##.'],
    [5, 5, '.###.\n#####\n#####\n#####\n.###.'],
    [8, 6, '..####..\n.######.\n########\n########\n.######.\n..####..'],
  ];
  it.each(filled)('filled %ix%i', (w, h, ascii) => {
    expectAscii(
      draw(w, h, (i) => {
        ellipse(i, 0, 0, w - 1, h - 1, R, { fill: true });
      }),
      ascii,
      legend,
    );
  });

  it('corner order does not matter and is offset-invariant', () => {
    const a = draw(12, 12, (i) => {
      ellipse(i, 7, 6, 3, 2, R);
    });
    const b = draw(12, 12, (i) => {
      ellipse(i, 3, 2, 7, 6, R);
    });
    expect(a).toEqual(b);
  });

  it('is mirror-symmetric in both axes for many sizes (outline and fill)', () => {
    for (let w = 1; w <= 24; w++) {
      for (let h = 1; h <= 24; h++) {
        for (const fill of [false, true]) {
          const img = new TiledImage(w, h);
          ellipse(img, 0, 0, w - 1, h - 1, R, { fill });
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const v = img.get(x, y)[3];
              expect(img.get(w - 1 - x, y)[3], [w, h, fill, x, y, 'mirror x'].join(' ')).toBe(v);
              expect(img.get(x, h - 1 - y)[3], [w, h, fill, x, y, 'mirror y'].join(' ')).toBe(v);
            }
          }
        }
      }
    }
  });
});

describe('floodFill', () => {
  it('4-connected does not cross a diagonal gap; 8-connected does', () => {
    // Seed at (0,0): the B wall runs diagonally, so with 4-connectivity the top-left pocket is enclosed.
    const four = from('.B.\nB..\n...');
    expect(floodFill(four, 0, 0, R, { connectivity: 4 })).toBe(1);
    expectAscii(four.toRGBA(), '#B.\nB..\n...', legend);
    const eight = from('.B.\nB..\n...');
    expect(floodFill(eight, 0, 0, R, { connectivity: 8 })).toBe(7);
    expectAscii(eight.toRGBA(), '#B#\nB##\n###', legend);
  });

  it('contiguous fills only the region; global fills every pixel of that colour', () => {
    const ascii = '..B..\n..B..\n..B..';
    const c = from(ascii);
    expect(floodFill(c, 0, 0, R)).toBe(6);
    expectAscii(c.toRGBA(), '##B..\n##B..\n##B..', legend);
    const g = from(ascii);
    expect(floodFill(g, 0, 0, R, { mode: 'global' })).toBe(12);
    expectAscii(g.toRGBA(), '##B##\n##B##\n##B##', legend);
  });

  it('filling with the colour already there is a no-op (no version bump)', () => {
    const img = from('##.\n...');
    const v = img.version;
    expect(floodFill(img, 0, 0, R)).toBe(0);
    expect(img.version).toBe(v);
  });

  it('seed outside the image does nothing', () => {
    const img = from('..');
    expect(floodFill(img, 5, 0, R)).toBe(0);
    expect(floodFill(img, -1, 0, R)).toBe(0);
  });

  it('fills a transparent empty image completely (bounded by image size)', () => {
    const img = new TiledImage(40, 33);
    expect(floodFill(img, 3, 3, R)).toBe(40 * 33);
  });

  it('is iterative: a long serpentine corridor does not overflow the stack', () => {
    const img = new TiledImage(300, 300);
    for (let y = 1; y < 300; y += 2) rect(img, y % 4 === 1 ? 0 : 1, y, 299, 1, B, { fill: true });
    expect(floodFill(img, 0, 0, R)).toBe(300 * 300 - 150 * 299);
  });

  it('tolerance matches near colours; 0 is exact', () => {
    const img = new TiledImage(3, 1);
    img.set(0, 0, [10, 10, 10, 255]);
    img.set(1, 0, [12, 10, 10, 255]);
    img.set(2, 0, [30, 10, 10, 255]);
    expect(floodFill(img.clone(), 0, 0, R)).toBe(1);
    expect(floodFill(img, 0, 0, R, { tolerance: 2 })).toBe(2);
    expect(img.get(2, 0)).toEqual([30, 10, 10, 255]);
  });

  it('works on IndexedImage', () => {
    const img = new IndexedImage(4, 2);
    img.set(2, 0, 3);
    img.set(2, 1, 3);
    expect(floodFill(img, 0, 0, 7)).toBe(4);
    expect([...img.toIndices()]).toEqual([7, 7, 3, 0, 7, 7, 3, 0]);
    expect(floodFill(img, 3, 0, 9, { mode: 'global', tolerance: 0 })).toBe(2);
  });
});

describe('pixelPerfect', () => {
  const pts = (s: [number, number][]) => s.map(([x, y]) => ({ x, y }));
  const flat = (p: { x: number; y: number }[]): [number, number][] => p.map((q) => [q.x, q.y]);

  it('removes the L corners of a staircase stroke, leaving a clean diagonal', () => {
    const stroke = pts([
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
      [2, 2],
      [3, 2],
    ]);
    expect(flat(pixelPerfect(stroke))).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 2],
    ]);
  });

  it('keeps straight runs and end points, but a plain 90-degree turn is an L and loses its corner; drops repeated points', () => {
    expect(
      flat(
        pixelPerfect(
          pts([
            [0, 0],
            [0, 0],
            [1, 0],
            [2, 0],
            [2, 1],
            [2, 2],
          ]),
        ),
      ),
    ).toEqual([
      [0, 0],
      [1, 0],
      [2, 1],
      [2, 2],
    ]);
  });

  it('single L: the middle is dropped; tiny inputs unchanged; input not mutated', () => {
    const input = pts([
      [0, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(flat(pixelPerfect(input))).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(input).toHaveLength(3);
    expect(pixelPerfect([])).toEqual([]);
    expect(flat(pixelPerfect(pts([[4, 4]])))).toEqual([[4, 4]]);
  });

  it('renders as a thinner line: the filtered stroke has fewer pixels, same extent', () => {
    const stroke = pts([
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
      [2, 2],
    ]);
    const plot = (p: { x: number; y: number }[]): ReturnType<TiledImage['toRGBA']> =>
      draw(3, 3, (i) => {
        p.forEach((q) => i.set(q.x, q.y, R));
      });
    expectAscii(plot(stroke), '##.\n.##\n..#', legend);
    expectAscii(plot(pixelPerfect(stroke)), '#..\n.#.\n..#', legend);
  });
});
