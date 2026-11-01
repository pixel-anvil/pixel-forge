import { CoreError } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { RULES, RULE_IDS, lint, lintPackage } from '../src/index.js';
import type { LintFinding, RuleId } from '../src/index.js';
import { pixelStore, rigStore } from './fixtures.js';

const only = (rule: RuleId, f: LintFinding[]): LintFinding[] => f.filter((x) => x.rule === rule);
const first = (f: LintFinding[]): LintFinding => {
  const x = f[0];
  if (x === undefined) throw new Error('no finding');
  return x;
};

const PIC = `
RR....
RR..B.
......
......`;

describe('registry and options', () => {
  it('registers every rule id, in order', () => {
    expect(lintPackage).toBe('@pixel-forge/lint');
    expect(RULES.map((r) => r.id)).toEqual([...RULE_IDS]);
    for (const r of RULES) expect(r.summary.length).toBeGreaterThan(10);
  });

  it('enable and disable select rules', () => {
    const store = pixelStore({ frames: [null, PIC] });
    const all = lint(store);
    expect(all.map((f) => f.rule)).toEqual(['pixels.orphan', 'anim.emptyFrame']);
    expect(lint(store, { enable: ['anim.emptyFrame'] }).map((f) => f.rule)).toEqual([
      'anim.emptyFrame',
    ]);
    expect(lint(store, { disable: ['anim.emptyFrame'] }).map((f) => f.rule)).toEqual([
      'pixels.orphan',
    ]);
    expect(lint(store, { enable: ['anim.emptyFrame'], disable: ['anim.emptyFrame'] })).toEqual([]);
  });

  it('is deterministic and does not change the document', () => {
    const store = pixelStore({ frames: [null, PIC], locked: true, layerOpacity: 100 });
    const v = store.version;
    expect(JSON.stringify(lint(store))).toBe(JSON.stringify(lint(store)));
    expect(store.version).toBe(v);
  });

  it('restricts animations and rejects an unknown one', () => {
    const store = pixelStore({ frames: [null] });
    expect(lint(store, { animations: [{ group: 'act' }] })).toHaveLength(1);
    expect(() => lint(store, { animations: [{ group: 'nope' }] })).toThrow(CoreError);
  });
});

describe('palette.offPalette', () => {
  it('triggers on a colour outside a locked palette', () => {
    const f = only(
      'palette.offPalette',
      lint(pixelStore({ frames: ['G.....\n......\n......\n..G...'], locked: true })),
    );
    expect(f).toHaveLength(1);
    const x = first(f);
    expect(x.severity).toBe('error');
    expect(x.location).toMatchObject({ skin: 'base', frameIndex: 0, pixel: { x: 0, y: 0 } });
    expect(x.data).toMatchObject({
      count: 2,
      pixels: [
        [0, 0],
        [2, 3],
      ],
      colors: ['00ff00'],
    });
  });

  it('does not trigger on palette colours, or when the document is not locked', () => {
    expect(only('palette.offPalette', lint(pixelStore({ frames: [PIC], locked: true })))).toEqual(
      [],
    );
    expect(
      only('palette.offPalette', lint(pixelStore({ frames: ['G.....'], locked: false }))),
    ).toEqual([]);
  });

  it('checks the render under every skin', () => {
    // Clean in the base render and under a remap skin, off palette under the palette skin that
    // lacks the red entry (red stays red there).
    const store = pixelStore({ frames: [PIC], locked: true, skin: 'short' });
    const f = only('palette.offPalette', lint(store));
    expect(f.map((x) => x.location.skin)).toEqual(['short']);
    expect(only('palette.offPalette', lint(store, { skins: ['base'] }))).toEqual([]);
    expect(
      only('palette.offPalette', lint(pixelStore({ frames: [PIC], locked: true, skin: 'remap' }))),
    ).toEqual([]);
    expect(
      only('palette.offPalette', lint(store, { skins: [{ name: 'short' }, { name: 'short' }] })),
    ).toHaveLength(1);
  });

  it('caps the listed pixels', () => {
    const row = 'GGGGGG\nGGGGGG\n......\n......';
    const f = first(
      only(
        'palette.offPalette',
        lint(pixelStore({ frames: [row], locked: true }), { maxPixels: 3 }),
      ),
    );
    expect(f.data).toMatchObject({ count: 12 });
    expect((f.data.pixels as unknown[]).length).toBe(3);
  });
});

describe('palette.opacityInLocked', () => {
  it('warns about layer and cel opacity in a locked document', () => {
    const f = only(
      'palette.opacityInLocked',
      lint(pixelStore({ frames: [PIC], locked: true, layerOpacity: 100, celOpacity: 200 })),
    );
    expect(f.map((x) => x.data.scope)).toEqual(['layer', 'cel']);
    expect(f.every((x) => x.severity === 'warning')).toBe(true);
    expect(f[1]?.location.animationId).toBeDefined();
  });

  it('is silent at full opacity or when unlocked', () => {
    expect(
      only('palette.opacityInLocked', lint(pixelStore({ frames: [PIC], locked: true }))),
    ).toEqual([]);
    expect(
      only('palette.opacityInLocked', lint(pixelStore({ frames: [PIC], layerOpacity: 100 }))),
    ).toEqual([]);
  });
});

describe('pixels.orphan', () => {
  it('reports isolated pixels (8-neighbourhood)', () => {
    const f = first(only('pixels.orphan', lint(pixelStore({ frames: [PIC] }))));
    expect(f.severity).toBe('info');
    expect(f.data).toMatchObject({ count: 1, pixels: [[4, 1]] });
    expect(f.location.pixel).toEqual({ x: 4, y: 1 });
  });

  it('is silent for connected pixels (diagonals count) and after removeOrphans', () => {
    expect(
      only('pixels.orphan', lint(pixelStore({ frames: ['R.....\n.R....\n......\n......'] }))),
    ).toEqual([]);
    expect(only('pixels.orphan', lint(pixelStore({ frames: [PIC], removeOrphans: true })))).toEqual(
      [],
    );
  });
});

describe('anim.emptyFrame', () => {
  it('reports a frame that renders nothing', () => {
    const f = only('anim.emptyFrame', lint(pixelStore({ frames: [PIC, null] })));
    expect(f).toHaveLength(1);
    expect(f[0]?.location.frameIndex).toBe(1);
  });
  it('is silent when every frame has pixels', () => {
    expect(only('anim.emptyFrame', lint(pixelStore({ frames: [PIC, PIC] })))).toEqual([]);
  });
});

describe('rig.jointGap', () => {
  it('reports the gaps of an uncapped elbow (fixtures/joint/gappy_elbow)', () => {
    const f = only('rig.jointGap', lint(rigStore({ elbow: 'gappy' })));
    expect(f).toHaveLength(1);
    const x = first(f);
    expect(x.severity).toBe('warning');
    expect(x.location).toMatchObject({ view: 'side', bone: 'lower' });
    // The two pixels the hand-written oracle names ((7,6) at -30, (7,4) at +30) are among the union.
    expect(x.data).toMatchObject({ parent: 'upper' });
    expect(x.data.union).toContainEqual([7, 4]);
    expect(x.data.union).toContainEqual([7, 6]);
    expect(x.data.gapCount).toBeGreaterThanOrEqual(2);
    expect(x.location.pixel).toEqual({ x: 7, y: 4 });
  });

  it('is silent for a capped elbow and for a document without a rig', () => {
    expect(only('rig.jointGap', lint(rigStore({ elbow: 'capped' })))).toEqual([]);
    expect(only('rig.jointGap', lint(pixelStore({ frames: [PIC] })))).toEqual([]);
  });
});

describe('rig.staleOverride and rig.overrideError', () => {
  it('lists a stale override', () => {
    const f = lint(rigStore({ elbow: 'capped', override: 'stale' }));
    const s = only('rig.staleOverride', f);
    expect(s).toHaveLength(1);
    expect(first(s).data).toMatchObject({ reason: 'hash', mirror: false });
    expect(first(s).location.overrideId).toBeDefined();
    expect(only('rig.overrideError', f)).toEqual([]);
  });

  it('is silent for a re-based override and for none', () => {
    for (const override of ['ok', 'none'] as const) {
      const f = lint(rigStore({ elbow: 'capped', override }));
      expect(only('rig.staleOverride', f)).toEqual([]);
      expect(only('rig.overrideError', f)).toEqual([]);
    }
  });

  it('reports a render error as its own finding, not as stale (CORE-03)', () => {
    const f = lint(rigStore({ elbow: 'capped', override: 'error' }));
    expect(only('rig.staleOverride', f)).toEqual([]);
    const e = only('rig.overrideError', f);
    expect(e).toHaveLength(1);
    expect(first(e).severity).toBe('error');
    expect(first(e).data).toMatchObject({ target: 'final', errorCode: 'IMAGE_MISSING' });
    // The frame itself cannot render either: one render error per frame.
    expect(only('lint.renderError', f).length).toBeGreaterThan(0);
  });
});

describe('rig.rotationResidual (stub)', () => {
  it('is registered and returns nothing', () => {
    const rule = RULES.find((r) => r.id === 'rig.rotationResidual');
    expect(rule).toBeDefined();
    expect(lint(rigStore({ elbow: 'capped' }), { enable: ['rig.rotationResidual'] })).toEqual([]);
  });
});

describe('a clean rig document', () => {
  it('has no findings', () => {
    expect(lint(rigStore({ elbow: 'capped' }))).toEqual([]);
  });
});
