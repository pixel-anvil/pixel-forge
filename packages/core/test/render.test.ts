import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { SCHEMA_VERSION, createIdGenerator, makeId } from '@pixel-forge/schema';
import type {
  Animation,
  AuthoredAnimation,
  Document,
  ImageId,
  Layer,
  LayerId,
  Override,
  Palette,
  PostPasses,
  Skin,
} from '@pixel-forge/schema';
import { asciiToImage, expectAscii } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import {
  CoreError,
  DocumentStore,
  createFrameRenderer,
  renderFrame,
  renderInputKey,
} from '../src/index.js';
import type { RenderedPart, RigFrameContext, RigRenderer, StoredImage } from '../src/index.js';
import { blankFrame } from './helpers.js';

const legend = {
  R: [255, 0, 0, 255],
  G: [0, 255, 0, 255],
  B: [0, 0, 255, 255],
  Y: [255, 255, 0, 255],
  P: [128, 0, 127, 255], // 50% red over opaque blue
  Q: [64, 0, 191, 255], // 25% red over opaque blue
  h: [255, 0, 0, 128], // half transparent red
} as const;

const gen = createIdGenerator({ seed: 99, next: 0 });
const ID = {
  doc: gen.next('doc'),
  pal: gen.next('palette'),
  pal2: gen.next('palette'),
  skinRemap: gen.next('skin'),
  skinPal: gen.next('skin'),
  anim: gen.next('animation'),
  mirror: gen.next('animation'),
  f0: gen.next('frame'),
  f1: gen.next('frame'),
  ov: Array.from({ length: 4 }, () => gen.next('override')),
  L: Array.from({ length: 8 }, () => gen.next('layer')),
  img: Array.from({ length: 8 }, () => gen.next('image')),
};
const idState = gen.state();
function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing');
  return v;
}
const L = (n: number): LayerId => need(ID.L[n]);
const IMG = (n: number): ImageId => need(ID.img[n]);

const rgbaImg = (ascii: string): TiledImage => TiledImage.fromRGBA(asciiToImage(ascii, legend));
const idxImg = (rows: string, ti = 0): IndexedImage => {
  const lines = rows
    .trim()
    .split('\n')
    .map((l) => l.trim());
  const data = Uint8Array.from(
    lines
      .join('')
      .split('')
      .map((c) => (c === '.' ? ti : Number(c))),
  );
  return IndexedImage.fromIndices(lines[0]?.length ?? 0, lines.length, data, ti);
};

interface LayerOpts {
  visible?: boolean;
  opacity?: number;
  export?: boolean;
}
const base = (n: number, o: LayerOpts) => ({
  id: L(n),
  name: `l${String(n)}`,
  visible: o.visible ?? true,
  opacity: o.opacity ?? 255,
  export: o.export ?? true,
});
const celOf = (img: number, x = 0, y = 0, opacity = 255) => ({
  imageId: IMG(img),
  offset: { x, y },
  opacity,
});
const px = (
  n: number,
  img: number | undefined,
  o: LayerOpts & { x?: number; y?: number; cel?: number } = {},
): Layer => ({
  kind: 'pixel',
  ...base(n, o),
  cels: img === undefined ? {} : { [ID.f0]: celOf(img, o.x, o.y, o.cel) },
});
const ref = (n: number, img: number): Layer => ({
  kind: 'reference',
  ...base(n, { export: false }),
  export: false,
  cels: { [ID.f0]: celOf(img) },
});
const grp = (n: number, children: Layer[], o: LayerOpts = {}): Layer => ({
  kind: 'group',
  ...base(n, o),
  children,
});
const part = (n: number, o: LayerOpts = {}): Layer => ({ kind: 'part', ...base(n, o) });

const PAL_RGB: Palette = {
  id: ID.pal,
  name: 'p',
  colors: [
    [0, 0, 0, 0],
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
  ],
  ramps: [],
};
const PAL_ALT: Palette = {
  id: ID.pal2,
  name: 'alt',
  colors: [
    [0, 0, 0, 0],
    [255, 255, 0, 255],
    [255, 0, 255, 255],
  ],
  ramps: [],
};
const SKIN_REMAP: Skin = { id: ID.skinRemap, name: 'rival', remap: [[1, 2]] };
const SKIN_PAL: Skin = { id: ID.skinPal, name: 'alt', paletteId: ID.pal2 };

interface Build {
  layers: Layer[];
  images?: [number, StoredImage][];
  w?: number;
  h?: number;
  origin?: { x: number; y: number };
  indexed?: boolean;
  animations?: Animation[];
}

function build(b: Build): DocumentStore {
  const doc: Document = {
    meta: {
      id: ID.doc,
      name: 'render',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w: b.w ?? 4, h: b.h ?? 2 },
      origin: b.origin ?? { x: 0, y: 0 },
      pixelsPerUnit: 16,
      colorMode: b.indexed === true ? 'indexed' : 'rgba',
      paletteLocked: false,
      ids: { ...idState },
    },
    palettes: [PAL_RGB, PAL_ALT],
    activePaletteId: ID.pal,
    skins: [SKIN_REMAP, SKIN_PAL],
    layers: b.layers,
    animations: b.animations ?? [
      {
        id: ID.anim,
        group: 'idle',
        loop: 'loop',
        frames: [blankFrame(ID.f0), blankFrame(ID.f1)],
        overrides: [],
      },
    ],
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
  };
  return new DocumentStore(doc, { images: (b.images ?? []).map(([i, img]) => [IMG(i), img]) });
}

const A = { group: 'idle' } as const;
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof CoreError ? e.code : 'other';
  }
  return undefined;
};
const reason = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return e instanceof CoreError ? e.details?.reason : 'other';
  }
  return undefined;
};

describe('renderFrame: layers', () => {
  it('draws bottom (index 0) to top (last), the output has the canvas size', () => {
    const s = build({
      layers: [px(0, 0), px(1, 1)],
      images: [
        [0, rgbaImg('RRR.\n....')],
        [1, rgbaImg('.G..\n.G..')],
      ],
    });
    const out = renderFrame(s, A, 0);
    expect([out.width, out.height]).toEqual([4, 2]);
    expectAscii(out.toRGBA(), 'RGR.\n.G..', legend);
  });

  it('skips hidden layers and hidden groups', () => {
    const s = build({
      layers: [px(0, 0), px(1, 1, { visible: false }), grp(2, [px(3, 1)], { visible: false })],
      images: [
        [0, rgbaImg('RRR.\n....')],
        [1, rgbaImg('.G..\n.G..')],
      ],
    });
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'RRR.\n....', legend);
  });

  it('applies layer opacity with the documented rounding (half red over blue)', () => {
    const s = build({
      layers: [px(0, 0), px(1, 1, { opacity: 128 })],
      images: [
        [0, rgbaImg('BB..\n....')],
        [1, rgbaImg('RR..\n....')],
      ],
    });
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'PP..\n....', legend);
  });

  it('multiplies cel opacity with layer opacity', () => {
    const s = build({
      layers: [px(0, 0), px(1, 1, { opacity: 128, cel: 255 }), px(2, 2, { cel: 128 })],
      images: [
        [0, rgbaImg('BB..\n....')],
        [1, rgbaImg('R...\n....')],
        [2, rgbaImg('.R..\n....')],
      ],
    });
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'PP..\n....', legend);
    const t = build({
      layers: [px(0, 0), px(1, 1, { opacity: 128, cel: 128 })],
      images: [
        [0, rgbaImg('B...\n....')],
        [1, rgbaImg('R...\n....')],
      ],
    });
    // 128*128 -> div255 = 64: a quarter red
    expectAscii(renderFrame(t, A, 0).toRGBA(), 'Q...\n....', legend);
  });

  it('multiplies opacity through nested groups (pass-through, rounded at each level)', () => {
    const s = build({
      layers: [px(0, 0), grp(1, [grp(2, [px(3, 1)], { opacity: 128 })], { opacity: 128 })],
      images: [
        [0, rgbaImg('BB..\n....')],
        [1, rgbaImg('RR..\n....')],
      ],
    });
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'QQ..\n....', legend);
    const one = build({
      layers: [px(0, 0), grp(1, [px(3, 1)], { opacity: 128 })],
      images: [
        [0, rgbaImg('BB..\n....')],
        [1, rgbaImg('RR..\n....')],
      ],
    });
    expectAscii(renderFrame(one, A, 0).toRGBA(), 'PP..\n....', legend);
  });

  it('groups are pass-through: children blend with what is below the group, not each other first', () => {
    // Two half-opaque layers in a half-opaque group over blue; pass-through blends one by one.
    const s = build({
      layers: [px(0, 0), grp(1, [px(2, 1), px(3, 2)], { opacity: 128 })],
      images: [
        [0, rgbaImg('B...\n....')],
        [1, rgbaImg('R...\n....')],
        [2, rgbaImg('G...\n....')],
      ],
    });
    // G (alpha 128) over (R 128 over B = P) -> not an isolated group
    const out = renderFrame(s, A, 0).toRGBA();
    const [r, g, b, a] = out.data;
    expect([r, g, b, a]).toEqual([64, 128, 63, 255]);
  });

  it('places a cel at its offset (clipped to the canvas)', () => {
    const s = build({
      layers: [px(0, 0, { x: 2, y: 1 })],
      images: [[0, rgbaImg('RG\nBY')]],
    });
    expectAscii(renderFrame(s, A, 0).toRGBA(), '....\n..RG', legend);
  });

  it('resolves a linked cel to the target cel, by index or frame id', () => {
    const layer: Layer = {
      kind: 'pixel',
      ...base(0, {}),
      cels: { [ID.f0]: celOf(0, 1, 0, 255), [ID.f1]: { linkTo: ID.f0 } },
    };
    const s = build({ layers: [layer], images: [[0, rgbaImg('R.\n.G')]] });
    expectAscii(renderFrame(s, A, 1).toRGBA(), '.R..\n..G.', legend);
    expectAscii(renderFrame(s, A, ID.f1).toRGBA(), '.R..\n..G.', legend);
  });

  it('a layer without a cel at the frame draws nothing', () => {
    const s = build({ layers: [px(0, 0)], images: [[0, rgbaImg('R...\n....')]] });
    expectAscii(renderFrame(s, A, 1).toRGBA(), '....\n....', legend);
  });

  it('throws typed errors for broken links and missing images', () => {
    const missing: Layer = { kind: 'pixel', ...base(0, {}), cels: { [ID.f1]: { linkTo: ID.f0 } } };
    const s = build({ layers: [missing], images: [] });
    expect(code(() => renderFrame(s, A, 1))).toBe('BAD_VALUE');
    expect(reason(() => renderFrame(s, A, 1))).toBe('BROKEN_LINK');
    const chain: Layer = {
      kind: 'pixel',
      ...base(0, {}),
      cels: { [ID.f0]: { linkTo: ID.f1 }, [ID.f1]: { linkTo: ID.f0 } },
    };
    const c = build({ layers: [chain] });
    expect(reason(() => renderFrame(c, A, 0))).toBe('BROKEN_LINK');
    const noImg = build({ layers: [px(0, 3)] });
    expect(code(() => renderFrame(noImg, A, 0))).toBe('IMAGE_MISSING');
  });
});

describe('renderFrame: export, reference, layers filters', () => {
  const layers = (): Layer[] => [
    px(0, 0),
    ref(1, 1),
    px(2, 2, { export: false }),
    grp(3, [px(4, 3)], { export: false }),
    grp(5, [px(6, 4, { export: false }), px(7, 5)]),
  ];
  const images: [number, StoredImage][] = [
    [0, rgbaImg('R...\n....')],
    [1, rgbaImg('.G..\n....')],
    [2, rgbaImg('..B.\n....')],
    [3, rgbaImg('...Y\n....')],
    [4, rgbaImg('....\nR...')],
    [5, rgbaImg('....\n.G..')],
  ];

  it('default render: reference skipped, export flags ignored', () => {
    const s = build({ layers: layers(), images });
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'R.BY\nRG..', legend);
  });

  it('includeReference draws reference layers in tree order', () => {
    const s = build({ layers: layers(), images });
    expectAscii(renderFrame(s, A, 0, { includeReference: true }).toRGBA(), 'RGBY\nRG..', legend);
  });

  it('exportOnly drops non-exported layers and groups with non-exported ancestors, and references', () => {
    const s = build({ layers: layers(), images });
    expectAscii(renderFrame(s, A, 0, { exportOnly: true }).toRGBA(), 'R...\n.G..', legend);
    expectAscii(
      renderFrame(s, A, 0, { exportOnly: true, includeReference: true }).toRGBA(),
      'R...\n.G..',
      legend,
    );
  });

  it('layers option: a leaf, or a group for its whole subtree; ancestors still apply', () => {
    const s = build({ layers: layers(), images });
    expectAscii(renderFrame(s, A, 0, { layers: [L(2)] }).toRGBA(), '..B.\n....', legend);
    expectAscii(renderFrame(s, A, 0, { layers: [L(5)] }).toRGBA(), '....\nRG..', legend);
    expectAscii(renderFrame(s, A, 0, { layers: [L(7), L(0)] }).toRGBA(), 'R...\n.G..', legend);
    expectAscii(renderFrame(s, A, 0, { layers: [] }).toRGBA(), '....\n....', legend);
    expect(code(() => renderFrame(s, A, 0, { layers: [L(7), makeId('layer', 5, 5)] }))).toBe(
      'BAD_ARGUMENT',
    );
  });

  it('unknown layers inside hidden groups are still known', () => {
    const s = build({
      layers: [grp(0, [px(1, 0)], { visible: false })],
      images: [[0, rgbaImg('R...\n....')]],
    });
    expectAscii(renderFrame(s, A, 0, { layers: [L(1)] }).toRGBA(), '....\n....', legend);
  });
});

describe('renderFrame: indexed documents and skins', () => {
  const idx = (): StoredImage[] => [idxImg('1.2.\n3..1')];

  it('resolves indices through the active palette; transparentIndex is transparent', () => {
    const s = build({ indexed: true, layers: [px(0, 0)], images: [[0, need(idx()[0])]] });
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'R.G.\nB..R', legend);
  });

  it('a custom transparentIndex is transparent even if its palette entry is opaque', () => {
    const img = idxImg('1.2.\n3..1', 3);
    const s = build({ indexed: true, layers: [px(0, 0)], images: [[0, img]] });
    // index '.' = 3 is transparent; the pixel with the literal index 3 is not drawn either
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'R.G.\n...R', legend);
  });

  it('remap skin: indices are remapped before the palette lookup', () => {
    const s = build({ indexed: true, layers: [px(0, 0)], images: [[0, need(idx()[0])]] });
    expectAscii(renderFrame(s, A, 0, { skin: { name: 'rival' } }).toRGBA(), 'G.G.\nB..G', legend);
    expectAscii(
      renderFrame(s, A, 0, { skin: { id: ID.skinRemap } }).toRGBA(),
      'G.G.\nB..G',
      legend,
    );
    expectAscii(renderFrame(s, A, 0, { skin: 'base' }).toRGBA(), 'R.G.\nB..R', legend);
  });

  it('palette skin: index for index through the skin palette', () => {
    const img = idxImg('1.2.\n...1');
    const s = build({ indexed: true, layers: [px(0, 0)], images: [[0, img]] });
    expectAscii(renderFrame(s, A, 0, { skin: { name: 'alt' } }).toRGBA(), 'Y.M.\n...Y', {
      ...legend,
      M: [255, 0, 255, 255],
    });
    // index 3 (blue) has no entry in the 3-colour skin palette: it stays blue
    const keep = build({ indexed: true, layers: [px(0, 0)], images: [[0, need(idx()[0])]] });
    expectAscii(renderFrame(keep, A, 0, { skin: { name: 'alt' } }).toRGBA(), 'Y.M.\nB..Y', {
      ...legend,
      M: [255, 0, 255, 255],
    });
  });

  it('an index outside the palette is a typed error; so is a missing palette', () => {
    const img = idxImg('9...\n....');
    const s = build({ indexed: true, layers: [px(0, 0)], images: [[0, img]] });
    expect(reason(() => renderFrame(s, A, 0))).toBe('BAD_INDEX');
    const doc = JSON.parse(JSON.stringify(s.doc)) as Document;
    delete (doc as { activePaletteId?: unknown }).activePaletteId;
    const none = new DocumentStore(doc, { images: [[IMG(0), need(idx()[0])]] });
    expect(reason(() => renderFrame(none, A, 0))).toBe('NO_PALETTE');
  });

  it('RGBA documents: palette colours map through the active palette index, others stay', () => {
    const s = build({
      layers: [px(0, 0)],
      images: [[0, rgbaImg('RGBY\nhR..')]],
    });
    // remap 1 -> 2: red becomes green (alpha kept); blue and yellow (not remapped / not in palette) stay
    expectAscii(renderFrame(s, A, 0, { skin: { name: 'rival' } }).toRGBA(), 'GGBY\nhG..', {
      ...legend,
      h: [0, 255, 0, 128],
    });
    // palette skin: red (index 1) -> yellow, green (2) -> magenta, blue (3) has no entry: unchanged
    expectAscii(renderFrame(s, A, 0, { skin: { name: 'alt' } }).toRGBA(), 'YMBY\nhY..', {
      ...legend,
      M: [255, 0, 255, 255],
      h: [255, 255, 0, 128],
    });
  });

  it('unknown skins and a skin palette that is missing are errors', () => {
    const s = build({ layers: [] });
    expect(code(() => renderFrame(s, A, 0, { skin: { name: 'nope' } }))).toBe('BAD_ARGUMENT');
    const doc = JSON.parse(JSON.stringify(s.doc)) as Document;
    doc.palettes = [PAL_RGB];
    const broken = new DocumentStore(doc);
    expect(reason(() => renderFrame(broken, A, 0, { skin: { name: 'alt' } }))).toBe('NO_PALETTE');
  });

  it('an indexed image inside an RGBA document resolves through the palette, un-skinned at source', () => {
    const s = build({ layers: [px(0, 0)], images: [[0, need(idx()[0])]] });
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'R.G.\nB..R', legend);
    expectAscii(renderFrame(s, A, 0, { skin: { name: 'rival' } }).toRGBA(), 'G.G.\nB..G', legend);
  });
});

describe('renderFrame: references and mirror animations', () => {
  it('reports unknown animations and frames', () => {
    const s = build({ layers: [] });
    expect(code(() => renderFrame(s, { group: 'run' }, 0))).toBe('BAD_ARGUMENT');
    expect(code(() => renderFrame(s, A, 2))).toBe('BAD_ARGUMENT');
    expect(code(() => renderFrame(s, A, -1))).toBe('BAD_ARGUMENT');
    expect(code(() => renderFrame(s, { id: ID.anim }, makeId('frame', 1, 1)))).toBe('BAD_ARGUMENT');
    expect(code(() => renderFrame(s, { group: 'idle', direction: 'side' }, 0))).toBe(
      'BAD_ARGUMENT',
    );
  });

  const mirrorAnims = (mirrorOf = ID.anim): Animation[] => [
    {
      id: ID.anim,
      group: 'idle',
      direction: 'side',
      loop: 'loop',
      frames: [blankFrame(ID.f0), blankFrame(ID.f1)],
      overrides: [],
    },
    { id: ID.mirror, group: 'idle', direction: 'side2', mirrorOf, overrides: [] },
  ];

  it('mirror: the source frame flipped about origin.x (x -> 2*origin.x - x), clipped', () => {
    const s = build({
      w: 5,
      h: 1,
      origin: { x: 2, y: 0 },
      layers: [px(0, 0)],
      images: [[0, rgbaImg('RBG..')]],
      animations: mirrorAnims(),
    });
    const m = { group: 'idle', direction: 'side2' };
    expectAscii(renderFrame(s, { group: 'idle', direction: 'side' }, 0).toRGBA(), 'RBG..', legend);
    // R(0)->4, B(1)->3, G(2)->2
    expectAscii(renderFrame(s, m, 0).toRGBA(), '..GBR', legend);
    expectAscii(renderFrame(s, { id: ID.mirror }, ID.f0).toRGBA(), '..GBR', legend);
    // origin at the right edge: everything left of it moves out of the canvas? x -> 8 - x
    const edge = build({
      w: 5,
      h: 1,
      origin: { x: 1, y: 0 },
      layers: [px(0, 0)],
      images: [[0, rgbaImg('RBG..')]],
      animations: mirrorAnims(),
    });
    // R(0)->2, B(1)->1, G(2)->0
    expectAscii(renderFrame(edge, m, 0).toRGBA(), 'GBR..', legend);
  });

  it('a mirror of a missing or mirrored source is a typed error', () => {
    const s = build({ layers: [], animations: mirrorAnims(makeId('animation', 3, 3)) });
    expect(reason(() => renderFrame(s, { id: ID.mirror }, 0))).toBe('BAD_MIRROR');
    const anims = mirrorAnims();
    anims.push({ id: makeId('animation', 3, 4), group: 'x', mirrorOf: ID.mirror, overrides: [] });
    const t = build({ layers: [], animations: anims });
    expect(reason(() => renderFrame(t, { id: makeId('animation', 3, 4) }, 0))).toBe('BAD_MIRROR');
  });

  it('a mirror applies the skin after flipping', () => {
    const s = build({
      w: 5,
      h: 1,
      origin: { x: 2, y: 0 },
      layers: [px(0, 0)],
      images: [[0, rgbaImg('RBG..')]],
      animations: mirrorAnims(),
    });
    expectAscii(
      renderFrame(s, { id: ID.mirror }, 0, { skin: { name: 'rival' } }).toRGBA(),
      '..GBG',
      legend,
    );
  });
});

/** A parts-only rig that returns configurable parts. */
class FakeRig implements RigRenderer {
  calls = 0;
  ctx: RigFrameContext | undefined;
  constructor(private readonly make: (ctx: RigFrameContext) => RenderedPart[]) {}
  renderParts(ctx: RigFrameContext): readonly RenderedPart[] {
    this.calls++;
    this.ctx = ctx;
    return this.make(ctx);
  }
}

const partOf = (layer: LayerId, z: number, ascii: string, x = 0, y = 0): RenderedPart => ({
  layerId: layer,
  partId: makeId('part', 1, z + 100),
  z,
  image: rgbaImg(ascii),
  offset: { x, y },
});

const maskImg = (rows: string): IndexedImage => {
  const lines = rows.trim().split('\n');
  const data = Uint8Array.from(
    lines
      .join('')
      .split('')
      .map((c) => (c === '#' ? 255 : 0)),
  );
  return IndexedImage.fromIndices(lines[0]?.length ?? 0, lines.length, data, 0);
};
const HASH = 'a'.repeat(64);
const ovr = (
  n: number,
  o: {
    frame?: typeof ID.f0;
    set?: number;
    erase?: number;
    x?: number;
    y?: number;
    target?: Override['target'];
  },
): Override => ({
  id: need(ID.ov[n]),
  frameId: o.frame ?? ID.f0,
  target: o.target ?? 'final',
  anchor: { x: o.x ?? 0, y: o.y ?? 0 },
  ...(o.set === undefined ? {} : { set: IMG(o.set) }),
  ...(o.erase === undefined ? {} : { erase: IMG(o.erase) }),
  baseHash: HASH,
});
const authored = (extra: Partial<AuthoredAnimation>): AuthoredAnimation => ({
  id: ID.anim,
  group: 'idle',
  loop: 'loop',
  frames: [blankFrame(ID.f0), blankFrame(ID.f1)],
  overrides: [],
  ...extra,
});
const withPasses = (postPasses: PostPasses, overrides: Override[] = []): Animation[] => [
  authored({ postPasses, overrides }),
];

describe('renderFrame: the rig block among pixel layers', () => {
  const bg = rgbaImg('RRRR\nRRRR');
  const fg = rgbaImg('Y...\n....');

  it('pixel layers before the first part layer draw below the whole rig, those after draw above', () => {
    const s = build({
      layers: [px(0, 0), part(1), px(2, 1), part(3)],
      images: [
        [0, bg],
        [1, fg],
      ],
    });
    const rig = new FakeRig(() => [
      partOf(L(3), 0, 'BBB.'), // z 0
      partOf(L(1), 1, 'GG..'), // z 1: above the z 0 part in the block
    ]);
    // the foreground (Y) is after the first part layer, so it covers the block, including L(3) that
    // comes later in the tree; the background (R) is below the block
    expectAscii(renderFrame(s, A, 0, { rig }).toRGBA(), 'YGBR\nRRRR', legend);
  });

  it('is independent of where the later part layers are: a pixel layer between parts still draws above', () => {
    const s = build({
      layers: [part(0), px(1, 1), part(2)],
      images: [[1, fg]],
    });
    const rig = new FakeRig(() => [partOf(L(0), 5, 'GG..'), partOf(L(2), 1, 'BBBB')]);
    // L(2) has the lower z, so it is drawn first although it is later in the tree; Y is above both
    expectAscii(renderFrame(s, A, 0, { rig }).toRGBA(), 'YGBB\n....', legend);
  });

  it('the block sits at the first part layer inside groups too, and respects the layers filter', () => {
    const s = build({
      layers: [px(0, 0), grp(1, [part(2)]), px(3, 1), part(4)],
      images: [
        [0, bg],
        [1, fg],
      ],
    });
    const rig = new FakeRig((ctx) =>
      [partOf(L(2), 0, 'GGGG'), partOf(L(4), 1, 'BBB.')].filter((p) =>
        ctx.partLayers.some((l) => l.id === p.layerId),
      ),
    );
    expectAscii(renderFrame(s, A, 0, { rig }).toRGBA(), 'YBBG\nRRRR', legend);
    // without the first part layer the block moves to the next one, which is after the foreground
    const filtered = renderFrame(s, A, 0, { rig, layers: [L(0), L(3), L(4)] });
    expectAscii(filtered.toRGBA(), 'BBBR\nRRRR', legend);
  });

  it('the key reflects the block position', () => {
    const imgs: [number, StoredImage][] = [[0, bg]];
    const a = build({ layers: [px(0, 0), part(1)], images: imgs });
    const b = build({ layers: [part(1), px(0, 0)], images: imgs });
    const rig = new FakeRig(() => []);
    expect(renderInputKey(a, A, 0, { rig })).not.toBe(renderInputKey(b, A, 0, { rig }));
  });
});

describe('renderFrame: post-passes (step 6)', () => {
  it('removeOrphans runs on a pixel-only animation', () => {
    const s = build({
      layers: [px(0, 0)],
      images: [[0, rgbaImg('RR.G\n....')]],
      animations: withPasses({ removeOrphans: {} }),
    });
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'RR..\n....', legend);
    const plain = build({ layers: [px(0, 0)], images: [[0, rgbaImg('RR.G\n....')]] });
    expectAscii(renderFrame(plain, A, 0).toRGBA(), 'RR.G\n....', legend);
  });

  it('outline: round corners by default, square when corners is true; colour from the schema field', () => {
    const img: [number, StoredImage] = [0, rgbaImg('.R..\n....')];
    const round = build({
      layers: [px(0, 0)],
      images: [img],
      animations: withPasses({ outline: { color: [0, 0, 255, 255] } }),
    });
    expectAscii(renderFrame(round, A, 0).toRGBA(), 'BRB.\n.B..', legend);
    const square = build({
      layers: [px(0, 0)],
      images: [img],
      animations: withPasses({ outline: { color: [0, 0, 255, 255], corners: true } }),
    });
    expectAscii(renderFrame(square, A, 0).toRGBA(), 'BRB.\nBBB.', legend);
  });

  it('outline stays within the canvas (cropped back; the result keeps the canvas size)', () => {
    const s = build({
      layers: [px(0, 0)],
      images: [[0, rgbaImg('RRRR\n....')]],
      animations: withPasses({ outline: { color: [0, 0, 255, 255] } }),
    });
    const out = renderFrame(s, A, 0);
    expect([out.width, out.height]).toEqual([4, 2]);
    // nothing above or beside the shape can be drawn; the row below is
    expectAscii(out.toRGBA(), 'RRRR\nBBBB', legend);
    const corner = build({
      layers: [px(0, 0)],
      images: [[0, rgbaImg('R...\nR...')]],
      animations: withPasses({ outline: { color: [0, 0, 255, 255] } }),
    });
    expectAscii(renderFrame(corner, A, 0).toRGBA(), 'RB..\nRB..', legend);
  });

  it('outsideOnly defaults to true and false also outlines holes', () => {
    const ring = 'RRR\nR.R\nRRR';
    const mk = (outsideOnly?: boolean): DocumentStore =>
      build({
        w: 5,
        h: 5,
        layers: [px(0, 0, { x: 1, y: 1 })],
        images: [[0, rgbaImg(ring)]],
        animations: withPasses({
          outline: {
            color: [0, 0, 255, 255],
            ...(outsideOnly === undefined ? {} : { outsideOnly }),
          },
        }),
      });
    expect(renderFrame(mk(), A, 0).get(2, 2)).toEqual([0, 0, 0, 0]);
    expect(renderFrame(mk(true), A, 0).get(2, 2)).toEqual([0, 0, 0, 0]);
    expect(renderFrame(mk(false), A, 0).get(2, 2)).toEqual([0, 0, 255, 255]);
  });

  it('removeOrphans runs before outline: a removed orphan gets no outline', () => {
    const s = build({
      layers: [px(0, 0)],
      images: [[0, rgbaImg('RR.G\n....')]],
      animations: withPasses({ removeOrphans: {}, outline: { color: [255, 255, 0, 255] } }),
    });
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'RRY.\nYY..', legend);
  });

  it('applies to animations with part layers too, on the composite with pixel layers', () => {
    const s = build({
      layers: [part(0), px(1, 0)],
      images: [[0, rgbaImg('...Y\n....')]],
      animations: withPasses({ removeOrphans: {} }),
    });
    const rig = new FakeRig(() => [partOf(L(0), 0, 'RR..')]);
    // the pixel layer's lone Y is an orphan on the composite, the part pair stays
    expectAscii(renderFrame(s, A, 0, { rig }).toRGBA(), 'RR..\n....', legend);
  });

  it('a mirror uses the source post-passes (before the flip)', () => {
    const s = build({
      w: 5,
      h: 1,
      origin: { x: 2, y: 0 },
      layers: [px(0, 0)],
      images: [[0, rgbaImg('.R...')]],
      animations: [
        authored({ postPasses: { outline: { color: [0, 0, 255, 255] } } }),
        { id: ID.mirror, group: 'idle', direction: 'm', mirrorOf: ID.anim, overrides: [] },
      ],
    });
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'BRB..', legend);
    // outline drawn on x = 0, 2 then flipped x -> 4 - x
    expectAscii(renderFrame(s, { id: ID.mirror }, 0).toRGBA(), '..BRB', legend);
  });

  it('an outline colour with alpha 0 is a typed error', () => {
    const s = build({
      layers: [px(0, 0)],
      images: [[0, rgbaImg('.R..\n....')]],
      animations: withPasses({ outline: { color: [0, 0, 255, 0] } }),
    });
    expect(code(() => renderFrame(s, A, 0))).toBe('BAD_VALUE');
    expect(reason(() => renderFrame(s, A, 0))).toBe('BAD_POSTPASS');
  });
});

describe('renderFrame: final overrides (step 7)', () => {
  const base4 = rgbaImg('RRRR\nRRRR');

  it('applies erase (255 clears) and then set, both at the anchor', () => {
    const s = build({
      layers: [px(0, 0)],
      images: [
        [0, base4],
        [5, maskImg('.##.')],
        [6, rgbaImg('BB')],
      ],
      animations: withPasses({}, [ovr(0, { erase: 5, set: 6 })]),
    });
    // erase clears x 1..2, then set paints x 0..1: erase-then-set (set-then-erase would give B..R)
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'BB.R\nRRRR', legend);
  });

  it('uses the anchor as a canvas position, clips at the canvas edge and blends set alpha', () => {
    const s = build({
      layers: [px(0, 0)],
      images: [
        [0, rgbaImg('BBBB\nBBBB')],
        [5, maskImg('##')],
        [6, rgbaImg('hY')],
      ],
      animations: withPasses({}, [
        ovr(0, { erase: 5, x: -1, y: 1 }), // clears (0,1) only; (-1,1) is outside
        ovr(1, { set: 6, x: 2, y: 0 }),
      ]),
    });
    // h (50% red) over blue = P; the half-transparent pixel is blended, Y replaces
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'BBPY\n.BBB', legend);
  });

  it('applies the overrides of the frame in array order', () => {
    const s = build({
      layers: [px(0, 0)],
      images: [
        [0, base4],
        [6, rgbaImg('G')],
        [7, rgbaImg('Y')],
      ],
      animations: withPasses({}, [ovr(0, { set: 6 }), ovr(1, { set: 7 })]),
    });
    expect(renderFrame(s, A, 0).get(0, 0)).toEqual([255, 255, 0, 255]);
  });

  it('ignores other frames and part overrides', () => {
    const s = build({
      layers: [px(0, 0)],
      images: [
        [0, base4],
        [6, rgbaImg('G')],
      ],
      animations: withPasses({}, [
        ovr(0, { set: 6, frame: ID.f1 }),
        ovr(1, { set: 6, target: { partId: makeId('part', 1, 1) } }),
      ]),
    });
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'RRRR\nRRRR', legend);
    // (the layer has no cel at frame 1, so only the override is drawn)
    expectAscii(renderFrame(s, A, 1).toRGBA(), 'G...\n....', legend);
  });

  it('runs after the post-passes (an erase can remove an outline pixel)', () => {
    const s = build({
      layers: [px(0, 0)],
      images: [
        [0, rgbaImg('.R..\n....')],
        [5, maskImg('#')],
      ],
      animations: withPasses({ outline: { color: [0, 0, 255, 255] } }, [ovr(0, { erase: 5 })]),
    });
    expectAscii(renderFrame(s, A, 0).toRGBA(), '.RB.\n.B..', legend);
  });

  it('works without post-passes or part layers, and for indexed documents', () => {
    const s = build({
      indexed: true,
      layers: [px(0, 0)],
      images: [
        [0, idxImg('1111\n1111')],
        [5, maskImg('#.')],
        [6, idxImg('3.')],
      ],
      animations: withPasses({}, [ovr(0, { erase: 5, set: 6, x: 1 })]),
    });
    // erase clears (1,0); set paints index 3 (blue) at (1,0) and leaves the transparent index alone
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'RBRR\nRRRR', legend);
  });

  it('a final override with a missing image is a typed error', () => {
    const s = build({ layers: [], animations: withPasses({}, [ovr(0, { set: 6 })]) });
    expect(code(() => renderFrame(s, A, 0))).toBe('IMAGE_MISSING');
  });

  it('a mirror applies its own final overrides after the flip, the source ones before', () => {
    const s = build({
      w: 5,
      h: 1,
      origin: { x: 2, y: 0 },
      layers: [px(0, 0)],
      images: [
        [0, rgbaImg('RBG..')],
        [6, rgbaImg('Y')],
        [7, rgbaImg('B')],
      ],
      animations: [
        authored({ overrides: [ovr(0, { set: 6 })] }),
        {
          id: ID.mirror,
          group: 'idle',
          direction: 'm',
          mirrorOf: ID.anim,
          overrides: [ovr(1, { set: 7 })],
        },
      ],
    });
    // source: Y painted at x 0 -> 'YBG..'; flipped (x -> 4 - x): '..GBY'; the mirror's B at x 0
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'YBG..', legend);
    expectAscii(renderFrame(s, { id: ID.mirror }, 0).toRGBA(), 'B.GBY', legend);
  });
});

describe('renderFrame: skin last (step 8)', () => {
  it('skins the post-pass outline and final overrides: outline colours that are palette colours are skinned', () => {
    // PAL_RGB: index 1 red, 2 green. Skin "rival" remaps 1 -> 2.
    const s = build({
      indexed: true,
      layers: [px(0, 0)],
      images: [
        [0, idxImg('.2..\n....')],
        [6, rgbaImg('R')],
      ],
      animations: withPasses({ outline: { color: [255, 0, 0, 255] } }, [
        ovr(0, { set: 6, x: 3, y: 1 }),
      ]),
    });
    // unskinned: red outline around the green pixel, red override pixel
    expectAscii(renderFrame(s, A, 0).toRGBA(), 'RGR.\n.R.R', legend);
    // skinned last: every red pixel (outline and override alike) becomes green
    expectAscii(renderFrame(s, A, 0, { skin: { name: 'rival' } }).toRGBA(), 'GGG.\n.G.G', legend);
    // a colour that is not in the palette stays
    const other = build({
      indexed: true,
      layers: [px(0, 0)],
      images: [[0, idxImg('.2..\n....')]],
      animations: withPasses({ outline: { color: [9, 9, 9, 255] } }),
    });
    expect(renderFrame(other, A, 0, { skin: { name: 'rival' } }).get(0, 0)).toEqual([9, 9, 9, 255]);
  });

  it('works by colour in both modes: the same document skins identically, blended pixels stay', () => {
    const rgba = build({ layers: [px(0, 0)], images: [[0, rgbaImg('RB..\nhP..')]] });
    // the half-transparent red has the RGB of palette red, so it is skinned with its alpha kept
    expectAscii(renderFrame(rgba, A, 0, { skin: { name: 'rival' } }).toRGBA(), 'GB..\nkP..', {
      ...legend,
      k: [0, 255, 0, 128],
    });
  });

  it('duplicate palette colours: the lowest index wins', () => {
    const s = build({
      indexed: true,
      layers: [px(0, 0)],
      images: [[0, idxImg('12..')]],
    });
    const doc = JSON.parse(JSON.stringify(s.doc)) as Document;
    // index 1 and 2 are both red; skin "rival" remaps 1 -> 3 (blue) and 2 -> 2
    doc.palettes[0] = {
      ...PAL_RGB,
      colors: [
        [0, 0, 0, 0],
        [255, 0, 0, 255],
        [255, 0, 0, 255],
        [0, 0, 255, 255],
      ],
    };
    doc.skins[0] = { id: ID.skinRemap, name: 'rival', remap: [[1, 3]] };
    const dup = new DocumentStore(doc, { images: [[IMG(0), idxImg('12..')]] });
    // both pixels are red; both take the colour of the lowest index (1 -> blue)
    expectAscii(renderFrame(dup, A, 0, { skin: { name: 'rival' } }).toRGBA(), 'BB..\n....', legend);
  });

  it('a skin does not touch transparent pixels, and unskinned renders are unchanged', () => {
    const s = build({ layers: [px(0, 0)], images: [[0, rgbaImg('R...\n....')]] });
    const out = renderFrame(s, A, 0, { skin: { name: 'rival' } });
    expect(out.get(1, 0)).toEqual([0, 0, 0, 0]);
    expect(renderFrame(s, A, 0, { skin: 'base' }).get(0, 0)).toEqual([255, 0, 0, 255]);
  });
});

describe('renderFrame: part layers (rig hook)', () => {
  it('throws NO_RIG_RENDERER when part layers are present and no rig is given', () => {
    const s = build({ layers: [px(0, 0), part(1)], images: [[0, rgbaImg('R...\n....')]] });
    expect(code(() => renderFrame(s, A, 0))).toBe('NO_RIG_RENDERER');
    // hidden or non-exported part layers are not needed
    const hidden = build({ layers: [part(1, { visible: false })] });
    expect(code(() => renderFrame(hidden, A, 0))).toBeUndefined();
    const nonExport = build({ layers: [part(1, { export: false })] });
    expect(code(() => renderFrame(nonExport, A, 0, { exportOnly: true }))).toBeUndefined();
    expect(code(() => renderFrame(nonExport, A, 0))).toBe('NO_RIG_RENDERER');
    expect(code(() => renderFrame(nonExport, A, 0, { layers: [] }))).toBeUndefined();
  });

  it('composites parts by z (ties in tree order), then pixel layers over them', () => {
    const s = build({
      layers: [part(0), px(1, 0), part(2), grp(3, [part(4)], { opacity: 128 })],
      images: [[0, rgbaImg('...Y\n....')]],
    });
    const rig = new FakeRig(() => [
      partOf(L(0), 5, 'RR..\nRR..'), // z 5
      partOf(L(2), 1, 'GGG.\nGGG.'), // z 1: below everything
      partOf(L(4), 5, 'BB..', 1, 0), // z 5, later in tree: above L(0); at 50%
    ]);
    // (1,0): 50% blue over red = U; (2,0): 50% blue over green = T; (3,0): the pixel layer on top
    expectAscii(renderFrame(s, A, 0, { rig }).toRGBA(), 'RUTY\nRRG.', {
      ...legend,
      U: [127, 0, 128, 255],
      T: [0, 127, 128, 255],
    });
  });

  it('applies layer opacity to parts and offsets parts', () => {
    const s = build({ layers: [part(0, { opacity: 128 })] });
    const rig = new FakeRig(() => [partOf(L(0), 0, 'R\nR', 1, 0)]);
    expectAscii(renderFrame(s, A, 0, { rig }).toRGBA(), '.h..\n.h..', legend);
  });

  it('hands the rig the filtered part layers, source animation, frame index and view', () => {
    const s = build({
      layers: [part(0), part(1, { visible: false }), part(2, { export: false }), part(3)],
    });
    const rig = new FakeRig(() => []);
    renderFrame(s, A, ID.f1, { rig, exportOnly: true });
    expect(rig.ctx?.partLayers.map((p) => p.id)).toEqual([L(0), L(3)]);
    expect(rig.ctx?.frameIndex).toBe(1);
    expect(rig.ctx?.frame.id).toBe(ID.f1);
    expect(rig.ctx?.animation.id).toBe(ID.anim);
    expect(rig.ctx?.view).toBe(s);
    expect(rig.calls).toBe(1);
    renderFrame(s, A, 0, { rig, layers: [L(3)] });
    expect(rig.ctx?.partLayers.map((p) => p.id)).toEqual([L(3)]);
  });

  it('mirror: the rig renders the source frame, core flips the result', () => {
    const s = build({
      w: 4,
      h: 1,
      origin: { x: 1, y: 0 },
      layers: [part(0)],
      animations: [
        { id: ID.anim, group: 'idle', loop: 'loop', frames: [blankFrame(ID.f0)], overrides: [] },
        { id: ID.mirror, group: 'idle', direction: 'm', mirrorOf: ID.anim, overrides: [] },
      ],
    });
    const rig = new FakeRig(() => [partOf(L(0), 0, 'RG..')]);
    expectAscii(renderFrame(s, A, 0, { rig }).toRGBA(), 'RG..', legend);
    // x -> 2 - x: R(0) -> 2, G(1) -> 1
    expectAscii(renderFrame(s, { id: ID.mirror }, 0, { rig }).toRGBA(), '.GR.', legend);
    expect(rig.ctx?.animation.id).toBe(ID.anim);
    expect(rig.calls).toBe(2);
  });

  it('rejects a part for a layer the renderer was not given', () => {
    const s = build({ layers: [part(0)] });
    const rig = new FakeRig(() => [partOf(L(5), 0, 'R')]);
    expect(reason(() => renderFrame(s, A, 0, { rig }))).toBe('BAD_RIG');
  });

  it('indexed documents: indexed parts go through the base palette, the skin comes last', () => {
    const s = build({ indexed: true, layers: [part(0)] });
    const mk = (): RenderedPart[] => [
      {
        layerId: L(0),
        partId: makeId('part', 1, 1),
        z: 0,
        image: idxImg('1.2.'),
        offset: { x: 0, y: 0 },
      },
    ];
    const rig = new FakeRig(mk);
    expectAscii(renderFrame(s, A, 0, { rig }).toRGBA(), 'R.G.\n....', legend);
    expectAscii(
      renderFrame(s, A, 0, { rig, skin: { name: 'rival' } }).toRGBA(),
      'G.G.\n....',
      legend,
    );
  });
});

describe('createFrameRenderer and renderInputKey', () => {
  const setup = () =>
    build({
      layers: [px(0, 0), grp(1, [px(2, 1)])],
      images: [
        [0, rgbaImg('RR..\n....')],
        [1, rgbaImg('..G.\n....')],
      ],
    });

  it('memoises on identities: same inputs give an equal render without recomputing', () => {
    const s = setup();
    const r = createFrameRenderer();
    const a = r(s, A, 0);
    const b = r(s, A, 0);
    expect(r.stats).toEqual({ hits: 1, misses: 1 });
    expect(b.hashRGBA()).toBe(a.hashRGBA());
    // results are independent copies
    b.set(3, 1, [1, 2, 3, 255]);
    expect(r(s, A, 0).hashRGBA()).toBe(a.hashRGBA());
    expect(a.hashRGBA()).toBe(renderFrame(s, A, 0).hashRGBA());
  });

  it('a hit survives unrelated edits and a snapshot; any input change misses', () => {
    const s = setup();
    const r = createFrameRenderer();
    r(s, A, 0);
    const snap = s.snapshot();
    r(snap, A, 0);
    expect(r.stats.hits).toBe(1);
    // unrelated: marker defs (not an input)
    s.transact('unrelated', (tx) => {
      tx.update((d) => {
        d.markerDefs.push({ name: 'm' });
      });
    });
    r(s, A, 0);
    expect(r.stats.hits).toBe(2);
    // pixels of a used image
    s.transact('px', (tx) => {
      tx.writeImage(IMG(0), (img) => (img as TiledImage).set(3, 1, [9, 9, 9, 255]));
    });
    const after = r(s, A, 0);
    expect(r.stats.misses).toBe(2);
    expect(after.get(3, 1)).toEqual([9, 9, 9, 255]);
    // layer opacity
    s.transact('op', (tx) => {
      tx.update((d) => {
        (d.layers[0] as { opacity: number }).opacity = 100;
      });
    });
    r(s, A, 0);
    expect(r.stats.misses).toBe(3);
    // options
    r(s, A, 0, { skin: { name: 'rival' } });
    r(s, A, 0, { layers: [L(0)] });
    expect(r.stats.misses).toBe(5);
    r.clear();
    r(s, A, 0);
    expect(r.stats.misses).toBe(6);
  });

  it('post-passes and final overrides are part of the memo identity', () => {
    const s = build({
      layers: [px(0, 0)],
      images: [
        [0, rgbaImg('.R..\n....')],
        [6, rgbaImg('B')],
      ],
      animations: withPasses({ outline: { color: [0, 0, 255, 255] } }, [ovr(0, { set: 6 })]),
    });
    const r = createFrameRenderer();
    const a = r(s, A, 0);
    r(s, A, 0);
    expect(r.stats).toEqual({ hits: 1, misses: 1 });
    expectAscii(a.toRGBA(), 'BRB.\n.B..', legend);
    s.transact('img', (tx) =>
      tx.writeImage(IMG(6), (i) => (i as TiledImage).set(0, 0, [255, 255, 0, 255])),
    );
    expectAscii(r(s, A, 0).toRGBA(), 'YRB.\n.B..', legend);
    expect(r.stats.misses).toBe(2);
    s.transact('pp', (tx) => {
      tx.update((d) => {
        const anim = d.animations[0] as { postPasses: { outline: { color: number[] } } };
        anim.postPasses = { outline: { color: [255, 0, 0, 255] } };
      });
    });
    expectAscii(r(s, A, 0).toRGBA(), 'YRR.\n.R..', legend);
    expect(r.stats.misses).toBe(3);
    s.transact('anchor', (tx) => {
      tx.update((d) => {
        const anim = d.animations[0] as { overrides: { anchor: { x: number } }[] };
        const o = anim.overrides[0];
        if (o) o.anchor.x = 3;
      });
    });
    expectAscii(r(s, A, 0).toRGBA(), 'RRRY\n.R..', legend);
    expect(r.stats.misses).toBe(4);
  });

  it('evicts least recently used frames beyond its capacity', () => {
    const s = setup();
    const r = createFrameRenderer(1);
    r(s, A, 0);
    r(s, A, 0, { layers: [L(0)] });
    r(s, A, 0);
    expect(r.stats).toEqual({ hits: 0, misses: 3 });
  });

  it('the rig is part of the identity and parts are rendered once per distinct input', () => {
    const s = build({ layers: [part(0)] });
    const rig1 = new FakeRig(() => [partOf(L(0), 0, 'R...')]);
    const rig2 = new FakeRig(() => [partOf(L(0), 0, 'G...')]);
    const r = createFrameRenderer();
    expectAscii(r(s, A, 0, { rig: rig1 }).toRGBA(), 'R...\n....', legend);
    r(s, A, 0, { rig: rig1 });
    expect(rig1.calls).toBe(1);
    expectAscii(r(s, A, 0, { rig: rig2 }).toRGBA(), 'G...\n....', legend);
  });

  describe('renderInputKey', () => {
    const key = (s: DocumentStore, o = {}): string => renderInputKey(s, A, 0, o);

    it('is a stable SHA-256 hex string', () => {
      const s = setup();
      expect(key(s)).toMatch(/^[0-9a-f]{64}$/);
      expect(key(s)).toBe(key(setup()));
      expect(key(s)).toBe(renderInputKey(s, { id: ID.anim }, ID.f0));
    });

    it('changes iff an input changes', () => {
      const s = setup();
      const k0 = key(s);
      // inputs that must change it
      const edits: [string, (s: DocumentStore) => void][] = [
        [
          'pixel',
          (x) =>
            x.transact('e', (tx) =>
              tx.writeImage(IMG(0), (i) => (i as TiledImage).set(3, 1, [1, 1, 1, 255])),
            ),
        ],
        [
          'layer opacity',
          (x) => {
            x.transact('e', (tx) => {
              tx.update((d) => {
                (d.layers[0] as { opacity: number }).opacity = 7;
              });
            });
          },
        ],
        [
          'group opacity',
          (x) => {
            x.transact('e', (tx) => {
              tx.update((d) => {
                (d.layers[1] as { opacity: number }).opacity = 7;
              });
            });
          },
        ],
        [
          'cel offset',
          (x) => {
            x.transact('e', (tx) => {
              tx.update((d) => {
                const cel = (d.layers[0] as { cels: Record<string, { offset: { x: number } }> })
                  .cels[ID.f0];
                if (cel) cel.offset.x = 1;
              });
            });
          },
        ],
        [
          'cel opacity',
          (x) => {
            x.transact('e', (tx) => {
              tx.update((d) => {
                const cel = (d.layers[0] as { cels: Record<string, { opacity: number }> }).cels[
                  ID.f0
                ];
                if (cel) cel.opacity = 9;
              });
            });
          },
        ],
        [
          'visibility',
          (x) => {
            x.transact('e', (tx) => {
              tx.update((d) => {
                (d.layers[0] as { visible: boolean }).visible = false;
              });
            });
          },
        ],
        [
          'canvas',
          (x) => {
            x.transact('e', (tx) => {
              tx.update((d) => {
                d.meta.canvas.w = 5;
              });
            });
          },
        ],
      ];
      for (const [name, edit] of edits) {
        const t = setup();
        edit(t);
        expect(key(t), name).not.toBe(k0);
      }
      // inputs that must not change it
      const same: [string, (s: DocumentStore) => void][] = [
        [
          'layer name',
          (x) => {
            x.transact('e', (tx) => {
              tx.update((d) => {
                (d.layers[0] as { name: string }).name = 'renamed';
              });
            });
          },
        ],
        [
          'marker defs',
          (x) => {
            x.transact('e', (tx) => {
              tx.update((d) => {
                d.markerDefs.push({ name: 'm' });
              });
            });
          },
        ],
        [
          'frame duration',
          (x) => {
            x.transact('e', (tx) => {
              tx.update((d) => {
                need(
                  (d.animations[0] as { frames: { durationMs: number }[] }).frames[0],
                ).durationMs = 777;
              });
            });
          },
        ],
        [
          'project name',
          (x) => {
            x.transact('e', (tx) => {
              tx.update((d) => {
                d.meta.name = 'other';
              });
            });
          },
        ],
      ];
      for (const [name, edit] of same) {
        const t = setup();
        edit(t);
        expect(key(t), name).toBe(k0);
      }
    });

    it('reacts to options only when they change what is drawn', () => {
      const s = build({
        layers: [px(0, 0), ref(1, 1), px(2, 0, { export: false })],
        images: [
          [0, rgbaImg('R...\n....')],
          [1, rgbaImg('.G..\n....')],
        ],
      });
      const k = key(s);
      expect(key(s, { includeReference: true })).not.toBe(k);
      expect(key(s, { exportOnly: true })).not.toBe(k);
      expect(key(s, { layers: [L(0)] })).not.toBe(k);
      expect(key(s, { exportOnly: true, includeReference: true })).toBe(
        key(s, { exportOnly: true }),
      );
      expect(key(s, { skin: 'base' })).toBe(k);
      expect(key(s, { skin: { name: 'rival' } })).not.toBe(k);
      expect(key(s, { skin: { name: 'rival' } })).not.toBe(key(s, { skin: { name: 'alt' } }));
      expect(key(s, { skin: { name: 'rival' } })).toBe(key(s, { skin: { id: ID.skinRemap } }));
    });

    it('palette matters for indexed documents and skins, not for plain RGBA', () => {
      const plain = setup();
      const k = key(plain);
      plain.transact('e', (tx) => {
        tx.update((d) => {
          (d.palettes[0] as { colors: number[][] }).colors[1] = [1, 2, 3, 255];
        });
      });
      expect(key(plain)).toBe(k);
      expect(key(plain, { skin: { name: 'rival' } })).not.toBe(
        key(setup(), { skin: { name: 'rival' } }),
      );
      const ix = build({ indexed: true, layers: [px(0, 0)], images: [[0, idxImg('1...\n....')]] });
      const ik = key(ix);
      ix.transact('e', (tx) => {
        tx.update((d) => {
          (d.palettes[0] as { colors: number[][] }).colors[1] = [1, 2, 3, 255];
        });
      });
      expect(key(ix)).not.toBe(ik);
      const alt = build({ indexed: true, layers: [px(0, 0)], images: [[0, idxImg('1...\n....')]] });
      alt.transact('e', (tx) => {
        tx.update((d) => {
          (d.palettes[1] as { colors: number[][] }).colors[1] = [1, 2, 3, 255];
        });
      });
      expect(key(alt, { skin: { name: 'alt' } })).not.toBe(key(ix, { skin: { name: 'alt' } }));
      // an indexed image with the same indices but another transparentIndex is another input
      const ti = build({
        indexed: true,
        layers: [px(0, 0)],
        images: [[0, idxImg('1...\n....', 3)]],
      });
      expect(key(ti)).not.toBe(ik);
    });

    it('mirror depends on the origin; part layers key on the rig input', () => {
      const anims: Animation[] = [
        { id: ID.anim, group: 'idle', loop: 'loop', frames: [blankFrame(ID.f0)], overrides: [] },
        { id: ID.mirror, group: 'idle', direction: 'm', mirrorOf: ID.anim, overrides: [] },
      ];
      const m = (ox: number): DocumentStore =>
        build({
          origin: { x: ox, y: 0 },
          layers: [px(0, 0)],
          images: [[0, rgbaImg('R...\n....')]],
          animations: anims,
        });
      expect(renderInputKey(m(0), { id: ID.mirror }, 0)).not.toBe(
        renderInputKey(m(1), { id: ID.mirror }, 0),
      );
      expect(renderInputKey(m(0), { id: ID.mirror }, 0)).not.toBe(
        renderInputKey(m(0), { id: ID.anim }, 0),
      );
      expect(renderInputKey(m(0), { id: ID.anim }, 0)).toBe(
        renderInputKey(m(1), { id: ID.anim }, 0),
      );

      const s = build({ layers: [part(0)], images: [[0, rgbaImg('R...\n....')]] });
      const rig = new FakeRig(() => []);
      const withRig = key(s, { rig });
      expect(withRig).not.toBe(key(s));
      // image pixels, part layer opacity and the animation node reach the key through the rig input
      s.transact('e', (tx) =>
        tx.writeImage(IMG(0), (i) => (i as TiledImage).set(2, 1, [5, 5, 5, 255])),
      );
      expect(key(s, { rig })).not.toBe(withRig);
      const t = build({ layers: [part(0, { opacity: 3 })], images: [[0, rgbaImg('R...\n....')]] });
      expect(key(t, { rig })).not.toBe(withRig);
      const u = build({ layers: [part(0)], images: [[0, rgbaImg('R...\n....')]] });
      expect(key(u, { rig })).toBe(withRig);
      u.transact('e', (tx) => {
        tx.update((d) => {
          (d.animations[0] as { loop: string }).loop = 'once';
        });
      });
      expect(key(u, { rig })).not.toBe(withRig);
    });

    it('includes the post-passes config', () => {
      const mk = (pp?: PostPasses): DocumentStore =>
        build({
          layers: [px(0, 0)],
          images: [[0, rgbaImg('.R..\n....')]],
          animations: withPasses(pp ?? {}),
        });
      const none = key(mk());
      const orphans = key(mk({ removeOrphans: {} }));
      const blue = key(mk({ outline: { color: [0, 0, 255, 255] } }));
      const keys = [
        none,
        orphans,
        blue,
        key(mk({ outline: { color: [0, 0, 254, 255] } })),
        key(mk({ outline: { color: [0, 0, 255, 255], corners: true } })),
        key(mk({ outline: { color: [0, 0, 255, 255], outsideOnly: false } })),
        key(mk({ removeOrphans: {}, outline: { color: [0, 0, 255, 255] } })),
      ];
      expect(new Set(keys).size).toBe(keys.length);
      expect(key(mk({ outline: { color: [0, 0, 255, 255] } }))).toBe(blue);
    });

    it('includes the final overrides of the frame (ids, anchors, image hashes), not the rest', () => {
      const mk = (overrides: Override[], extra: [number, StoredImage][] = []): DocumentStore =>
        build({
          layers: [px(0, 0)],
          images: [[0, rgbaImg('RRRR\nRRRR')], [5, maskImg('.##.')], [6, rgbaImg('BB')], ...extra],
          animations: withPasses({}, overrides),
        });
      const k0 = key(mk([]));
      const withSet = key(mk([ovr(0, { set: 6 })]));
      const variants = [
        k0,
        withSet,
        key(mk([ovr(0, { set: 6, x: 1 })])),
        key(mk([ovr(0, { erase: 5 })])),
        key(mk([ovr(0, { set: 6, erase: 5 })])),
        key(mk([ovr(1, { set: 6 })])), // another id
        key(mk([ovr(0, { set: 6 }), ovr(1, { set: 6 })])),
      ];
      expect(new Set(variants).size).toBe(variants.length);
      // the image content counts, through its hash
      const edited = mk([ovr(0, { set: 6 })]);
      edited.transact('e', (tx) =>
        tx.writeImage(IMG(6), (i) => (i as TiledImage).set(0, 0, [9, 9, 9, 255])),
      );
      expect(key(edited)).not.toBe(withSet);
      const mask = mk([ovr(0, { erase: 5 })]);
      mask.transact('e', (tx) => tx.writeImage(IMG(5), (i) => (i as IndexedImage).set(0, 0, 255)));
      expect(key(mask)).not.toBe(variants[3]);
      // other frames, part overrides and baseHash do not reach the pixels
      expect(key(mk([ovr(0, { set: 6, frame: ID.f1 })]))).toBe(k0);
      expect(key(mk([ovr(0, { set: 6, target: { partId: makeId('part', 1, 1) } })]))).toBe(k0);
      const rebased = mk([{ ...ovr(0, { set: 6 }), baseHash: 'b'.repeat(64) }]);
      expect(key(rebased)).toBe(withSet);
      // a missing image is an error, as in renderFrame
      expect(
        code(() => key(build({ layers: [], animations: withPasses({}, [ovr(0, { set: 6 })]) }))),
      ).toBe('IMAGE_MISSING');
    });

    it("a mirror's key includes its own final overrides", () => {
      const mk = (overrides: Override[]): DocumentStore =>
        build({
          layers: [px(0, 0)],
          images: [
            [0, rgbaImg('R...\n....')],
            [6, rgbaImg('B')],
          ],
          animations: [
            authored({}),
            { id: ID.mirror, group: 'idle', direction: 'm', mirrorOf: ID.anim, overrides },
          ],
        });
      const m = (s: DocumentStore): string => renderInputKey(s, { id: ID.mirror }, 0);
      const k0 = m(mk([]));
      const k1 = m(mk([ovr(0, { set: 6 })]));
      expect(k1).not.toBe(k0);
      expect(m(mk([ovr(0, { set: 6, x: 1 })]))).not.toBe(k1);
      // the source's key is not affected by the mirror's overrides
      expect(renderInputKey(mk([ovr(0, { set: 6 })]), { id: ID.anim }, 0)).toBe(
        renderInputKey(mk([]), { id: ID.anim }, 0),
      );
    });

    it('throws like renderFrame for bad references', () => {
      const s = setup();
      expect(code(() => renderInputKey(s, { group: 'nope' }, 0))).toBe('BAD_ARGUMENT');
    });
  });
});
