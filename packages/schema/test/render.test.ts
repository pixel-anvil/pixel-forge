import { describe, expect, it } from 'vitest';
import {
  Document,
  Manifest,
  RenderAnimation,
  RenderFrame,
  RenderIndex,
  documentJsonSchema,
  manifestJsonSchema,
  renderIndexJsonSchema,
} from '../src/index.js';
import {
  ids,
  minimalDoc,
  minimalManifest,
  minimalRenderIndex,
} from './fixtures/src/minimal-doc.js';
import { at, failurePaths, jsonCopy } from './helpers.js';

const firstFrame = (): RenderFrame => {
  const right = minimalRenderIndex.animations.run?.right;
  if (!right || 'mirrorOf' in right) throw new Error('expected run/right frames');
  return at(right.frames, 0);
};

describe('render/index.json', () => {
  it('round-trips the fixture index', () => {
    const parsed = RenderIndex.parse(JSON.parse(JSON.stringify(minimalRenderIndex)));
    expect(parsed).toStrictEqual(minimalRenderIndex);
  });

  it('represents a mirror without frames or PNGs', () => {
    const run = minimalRenderIndex.animations.run;
    expect(run?.left).toEqual({ loop: 'loop', mirrorOf: 'right' });
    expect(RenderAnimation.safeParse({ loop: 'loop', mirrorOf: 'right', frames: [] }).success).toBe(
      false,
    );
    expect(RenderAnimation.safeParse({ loop: 'loop', frames: [] }).success).toBe(false);
  });

  it('accepts the undirected key and validates image paths', () => {
    const f = firstFrame();
    const index = jsonCopy(minimalRenderIndex);
    index.animations.idle = {
      default: { loop: 'once', frames: [{ ...f, image: 'idle/default/0.png' }] },
    };
    expect(RenderIndex.safeParse(index).success).toBe(true);
    for (const image of [
      'run/right/0.PNG',
      '../run/0.png',
      'run/right/01.png',
      'right/0.png',
      'run/right/-1.png',
    ]) {
      expect(RenderFrame.safeParse({ ...f, image }).success, image).toBe(false);
    }
  });

  it('rejects a non-hex frame hash and an empty skin list', () => {
    const index = jsonCopy(minimalRenderIndex);
    index.skins = [];
    expect(failurePaths(RenderIndex, index)).toEqual(['skins']);
    expect(failurePaths(RenderFrame, { ...firstFrame(), hash: 'NOTHEX12' })).toEqual(['hash']);
    expect(failurePaths(RenderFrame, { ...firstFrame(), id: ids.animRunRight })).toEqual(['id']);
  });
});

describe('manifest.json', () => {
  it('round-trips the fixture manifest', () => {
    expect(Manifest.parse(jsonCopy(minimalManifest))).toStrictEqual(minimalManifest);
  });

  it('requires format pxf, version 1 and UTC ISO timestamps', () => {
    expect(failurePaths(Manifest, { ...minimalManifest, format: 'zip' })).toEqual(['format']);
    expect(failurePaths(Manifest, { ...minimalManifest, schemaVersion: 2 })).toEqual([
      'schemaVersion',
    ]);
    expect(failurePaths(Manifest, { ...minimalManifest, modified: '2026-01-01' })).toEqual([
      'modified',
    ]);
    expect(
      failurePaths(Manifest, { ...minimalManifest, created: '2026-01-01T00:00:00+02:00' }),
    ).toEqual(['created']);
  });
});

describe('JSON Schema export', () => {
  it('produces a draft 2020-12 schema of document.json', () => {
    const schema = documentJsonSchema();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(Object.keys(Document.shape).sort());
    expect(schema.required).toEqual(expect.arrayContaining(['meta', 'layers', 'animations']));
    expect(schema.required).not.toContain('rig');
    expect(schema.$defs?.Layer).toBeDefined();
    expect(JSON.stringify(schema)).toContain('"#/$defs/Layer"');
  });

  it('is pure: each call returns an equal, fresh object', () => {
    const a = documentJsonSchema();
    const b = documentJsonSchema();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it('exports the render index and manifest schemas', () => {
    expect(Object.keys(renderIndexJsonSchema().properties ?? {})).toContain('animations');
    expect(manifestJsonSchema().required).toEqual(
      expect.arrayContaining(['format', 'schemaVersion', 'app', 'created', 'modified']),
    );
  });

  it('describes ids, names and integers as patterns and integer types', () => {
    const text = JSON.stringify(documentJsonSchema());
    expect(text).toContain('^lay_[0-9a-z]{1,24}$');
    expect(text).toContain('[a-z0-9_-]{1,48}$');
    expect(text).toContain('__proto__');
    expect(text).toContain('"type":"integer"');
    expect(Document.parse(minimalDoc)).toBeDefined();
  });
});
