import { TiledImage } from '@pixel-forge/raster';
import { makeId } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { corePackage } from '../src/index.js';
import type { RenderedPart, RigFrameContext, RigRenderer } from '../src/index.js';
import { authored, ids, makeStore } from './helpers.js';

/** A parts-only fake renderer of the kind T2.3 tests renderFrame with: one red pixel per part layer. */
class FakeRig implements RigRenderer {
  calls = 0;
  renderParts(ctx: RigFrameContext): readonly RenderedPart[] {
    this.calls++;
    return ctx.partLayers.map((layer, i): RenderedPart => {
      const image = new TiledImage(1, 1);
      image.set(0, 0, [255, 0, 0, 255]);
      return {
        layerId: layer.id,
        partId: makeId('part', 1, i),
        z: -i,
        image,
        offset: { x: i, y: 0 },
      };
    });
  }
}

describe('RigRenderer hook (types)', () => {
  it('can be implemented and called with a view of the store', () => {
    const store = makeStore();
    const animation = authored(JSON.parse(JSON.stringify(store.doc)) as never);
    const frame = animation.frames[0];
    if (frame === undefined) throw new Error('fixture frame');
    const rig = new FakeRig();
    const ctx: RigFrameContext = {
      view: store,
      animation,
      frameIndex: 0,
      frame,
      partLayers: [
        { kind: 'part', id: ids.layBg, name: 'p', visible: true, opacity: 255, export: true },
      ],
    };
    const parts = rig.renderParts(ctx);
    expect(parts.map((p) => [p.layerId, p.z, p.offset])).toEqual([[ids.layBg, -0, { x: 0, y: 0 }]]);
    expect(rig.calls).toBe(1);
    expect(corePackage).toBe('@pixel-forge/core');
  });
});
