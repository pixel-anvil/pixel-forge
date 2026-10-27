import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodePng } from '@pixel-forge/png';
import { describe, expect, it } from 'vitest';
import { aseCelToRgba, findAseCel, parseAseprite } from '../src/index.js';
import type { AseFile } from '../src/index.js';

/**
 * Oracles: `*.expected.json` and the per-layer PNGs come from the Aseprite CLI (see
 * fixtures/aseprite/README.md). The parser is checked against them, never against itself.
 */
const dir = fileURLToPath(new URL('../../../fixtures/aseprite/', import.meta.url));

interface ExpectedLayer {
  name: string;
  group?: string;
  opacity?: number;
  blendMode?: string;
}
interface Expected {
  frames: { duration: number }[];
  meta: {
    size: { w: number; h: number };
    frameTags: { name: string; from: number; to: number; direction: string; color: string }[];
    layers: ExpectedLayer[];
  };
}

function load(name: string): { file: AseFile; expected: Expected } {
  const file = parseAseprite(new Uint8Array(readFileSync(`${dir}${name}.aseprite`)));
  const expected = JSON.parse(readFileSync(`${dir}${name}.expected.json`, 'utf8')) as Expected;
  return { file, expected };
}

/** Oracle PNG name: `:`, `#` and `@` in layer names become `~`. */
function oraclePath(fixture: string, layer: string, frame: number): string {
  return `${dir}${fixture}/${layer.replace(/[:#@]/g, '~')}-${String(frame)}.png`;
}

/** Aseprite's 8-bit multiply: round(a * b / 255). */
function mul(a: number, b: number): number {
  const t = a * b + 128;
  return (t + (t >> 8)) >> 8;
}

/** Paste an RGBA cel at (x, y) onto a transparent canvas, clipping, scaling alpha by `opacity`. */
function place(
  canvasW: number,
  canvasH: number,
  cel: { x: number; y: number; width: number; height: number; data: Uint8Array },
  opacity: number,
): Uint8Array {
  const out = new Uint8Array(canvasW * canvasH * 4);
  for (let cy = 0; cy < cel.height; cy++) {
    for (let cx = 0; cx < cel.width; cx++) {
      const px = cel.x + cx;
      const py = cel.y + cy;
      if (px < 0 || py < 0 || px >= canvasW || py >= canvasH) continue;
      const s = (cy * cel.width + cx) * 4;
      const d = (py * canvasW + px) * 4;
      out[d] = cel.data[s] ?? 0;
      out[d + 1] = cel.data[s + 1] ?? 0;
      out[d + 2] = cel.data[s + 2] ?? 0;
      out[d + 3] = mul(cel.data[s + 3] ?? 0, opacity);
    }
  }
  return out;
}

/** Index of the first differing byte, or -1. Colour under alpha 0 is ignored. */
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] !== b[i + 3]) return i + 3;
    if (a[i + 3] === 0) continue;
    for (let k = 0; k < 3; k++) if (a[i + k] !== b[i + k]) return i + k;
  }
  return -1;
}

const FIXTURES = ['layers_parts', 'tags_overlap', 'linked_cels', 'indexed_palette'];

describe.each(FIXTURES)('aseprite fixture %s', (name) => {
  const { file, expected } = load(name);

  it('header matches the oracle', () => {
    expect(file.header.width).toBe(
      expected.meta.size.w / (name === 'layers_parts' ? 3 : expected.frames.length),
    );
    expect(file.header.frameCount).toBe(expected.frames.length);
    expect(file.frames).toHaveLength(expected.frames.length);
  });

  it('frame durations match', () => {
    expect(file.frames.map((f) => f.durationMs)).toEqual(expected.frames.map((f) => f.duration));
  });

  it('layers match: names, group nesting, opacity, blend mode', () => {
    expect(file.layers.map((l) => l.name)).toEqual(expected.meta.layers.map((l) => l.name));
    for (const [i, want] of expected.meta.layers.entries()) {
      const got = file.layers[i];
      expect(got?.index).toBe(i);
      expect(
        got?.parentIndex === null ? undefined : file.layers[got?.parentIndex ?? -1]?.name,
      ).toBe(want.group);
      if (want.opacity !== undefined) expect(got?.opacity).toBe(want.opacity);
      if (want.blendMode !== undefined) expect(got?.blendMode).toBe(want.blendMode);
      // The oracle lists a group (no opacity key) without image data.
      expect(got?.type === 'group').toBe(want.opacity === undefined);
    }
  });

  it('tags match (0-based from/to)', () => {
    const hex = (c?: { r: number; g: number; b: number; a: number }): string =>
      c === undefined
        ? 'none'
        : `#${[c.r, c.g, c.b, c.a].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    expect(
      file.tags.map((t) => ({
        name: t.name,
        from: t.from,
        to: t.to,
        direction: t.direction,
        color: hex(t.userData?.color),
      })),
    ).toEqual(expected.meta.frameTags);
  });

  it('every cel equals the oracle PNG for its layer and frame', () => {
    let compared = 0;
    for (const layer of file.layers) {
      if (layer.type === 'group') continue;
      for (const frame of file.frames) {
        const path = oraclePath(name, layer.name, frame.index);
        expect(existsSync(path), path).toBe(true);
        const oracle = decodePng(new Uint8Array(readFileSync(path)));
        expect([oracle.width, oracle.height]).toEqual([file.header.width, file.header.height]);
        const cel = findAseCel(file, frame.index, layer.index);
        // Aseprite saves a missing cel as a fully transparent canvas.
        const ours =
          cel === undefined
            ? new Uint8Array(oracle.data.length)
            : place(
                file.header.width,
                file.header.height,
                aseCelToRgba(file, cel),
                mul(cel.opacity, layer.opacity),
              );
        const at = firstDiff(ours, oracle.data);
        expect(
          at,
          `${layer.name} frame ${String(frame.index)} first diff at byte ${String(at)}`,
        ).toBe(-1);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });
});

describe('layers_parts', () => {
  const { file } = load('layers_parts');

  it('reads the hidden flag only on hidden_guide (the JSON lacks it)', () => {
    const hidden = file.layers.filter((l) => !l.visible).map((l) => l.name);
    expect(hidden).toEqual(['hidden_guide']);
  });

  it('nests the arm parts under the arm group via child level', () => {
    const arm = file.layers.find((l) => l.name === 'arm');
    expect(arm?.type).toBe('group');
    const kids = file.layers.filter((l) => l.parentIndex === arm?.index);
    expect(kids.map((l) => [l.name, l.childLevel])).toEqual([
      ['part:upper_arm_r', 1],
      ['part:lower_arm_r@45', 1],
      ['part:hand_r#side', 1],
    ]);
    expect(file.layers.find((l) => l.name === 'body')?.childLevel).toBe(0);
  });

  it('honours the header flag for layer opacity', () => {
    expect(file.header.layerOpacityValid).toBe(true);
    const lower = file.layers.find((l) => l.name === 'part:lower_arm_r@45');
    expect(lower?.opacityRaw).toBe(128);
    expect(lower?.opacity).toBe(128);
  });

  it('exposes colour profile and palette chunks', () => {
    expect(file.colorProfile?.type).toBe(1);
    expect(file.frames[0]?.chunks.some((c) => c.kind === 'oldPalette')).toBe(true);
  });
});

describe('tags_overlap', () => {
  const { file } = load('tags_overlap');

  it('attaches the tag colours (user data after the tags chunk) in tag order', () => {
    expect(file.tags).toHaveLength(2);
    for (const tag of file.tags) expect(tag.userData?.color).toBeDefined();
    const targets = file.frames
      .flatMap((f) => f.chunks)
      .flatMap((c) => (c.kind === 'userData' ? [c.target] : []));
    expect(targets).toContainEqual({ kind: 'tag', tagIndex: 0 });
    expect(targets).toContainEqual({ kind: 'tag', tagIndex: 1 });
  });

  it('keeps overlapping tags as written (frame 3 is in both)', () => {
    const run = file.tags.find((t) => t.name === 'run');
    const turn = file.tags.find((t) => t.name === 'turn');
    expect([run?.from, run?.to, turn?.from, turn?.to]).toEqual([0, 3, 3, 5]);
    expect(turn?.direction).toBe('pingpong');
  });
});

describe('linked_cels', () => {
  const { file } = load('linked_cels');

  it('marks frames 2 and 4 (1-based) as links to frame 1', () => {
    const kinds = file.frames.map((f) => f.cels[0]?.content.type);
    expect(kinds).toEqual(['image', 'linked', 'image', 'linked']);
    for (const i of [1, 3]) {
      const c = file.frames[i]?.cels[0]?.content;
      expect(c?.type === 'linked' ? c.framePosition : -1).toBe(0);
    }
  });

  it('resolves links to the source pixels and distinguishes frame 3', () => {
    const px = (i: number): Uint8Array => {
      const cel = findAseCel(file, i, 0);
      if (cel === undefined) throw new Error('missing cel');
      return aseCelToRgba(file, cel).data;
    };
    expect(px(1)).toEqual(px(0));
    expect(px(3)).toEqual(px(0));
    expect(px(2)).not.toEqual(px(0));
  });
});

describe('indexed_palette', () => {
  const { file } = load('indexed_palette');

  it('is 8-bit with a 16-entry palette whose entry 0 is transparent', () => {
    expect(file.header.colorDepth).toBe(8);
    expect(file.header.transparentIndex).toBe(0);
    expect(file.palette?.source).toBe('new');
    expect(file.palette?.entries).toHaveLength(16);
    expect(file.palette?.entries[0]?.a).toBe(0);
    expect(file.palette?.entries.slice(1).every((e) => e.a === 255)).toBe(true);
  });

  it('keeps the stored indices: pixel (x, y) is (x + y) % 16, as the fixture script drew it', () => {
    const content = file.frames[0]?.cels[0]?.content;
    expect(content?.type).toBe('image');
    if (content?.type !== 'image') return;
    expect(content.image.depth).toBe(8);
    const { width, height, data } = content.image;
    expect([width, height]).toEqual([8, 8]);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) expect(data[y * 8 + x]).toBe((x + y) % 16);
    }
    expect(Math.max(...data)).toBe(14);
  });
});
