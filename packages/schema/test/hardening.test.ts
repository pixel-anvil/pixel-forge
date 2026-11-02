import { describe, expect, it } from 'vitest';
import {
  BASE_SKIN_KEY,
  DIRECTION_REGEX,
  DirectionFallback,
  DirectionName,
  Document,
  GroupLayer,
  Layer,
  MAX_LAYER_DEPTH,
  NAME_MAX_LENGTH,
  NAME_REGEX,
  Name,
  RENDER_IMAGE_PATH_REGEX,
  RESERVED_PROPERTY_NAMES,
  RenderFrame,
  RenderImagePath,
  RenderIndex,
  SKIN_NAME_REGEX,
  SkinName,
  UNDIRECTED_KEY,
  documentJsonSchema,
} from '../src/index.js';
import { ids, minimalDoc, minimalRenderIndex } from './fixtures/src/minimal-doc.js';
import { at, failurePaths, jsonCopy, must, withOwn } from './helpers.js';

const doc = () => jsonCopy(minimalDoc);

/** Every name that must never be a record key: our list plus whatever `Object.prototype` holds. */
const protoNames = [
  ...new Set([...RESERVED_PROPERTY_NAMES, ...Object.getOwnPropertyNames(Object.prototype)]),
];
/** The subset the name alphabet could ever accept (lower case, digits, `_`, `-`). */
const alphabetProtoNames = protoNames.filter((n) => /^[a-z0-9_-]+$/.test(n));

describe('reserved JavaScript property names', () => {
  it('lists every Object.prototype member', () => {
    for (const n of Object.getOwnPropertyNames(Object.prototype)) {
      expect(RESERVED_PROPERTY_NAMES, n).toContain(n);
    }
    expect(alphabetProtoNames).toEqual(expect.arrayContaining(['__proto__', 'constructor']));
    expect(alphabetProtoNames).toContain('prototype');
  });

  it('are rejected as names, directions, skin names and path segments', () => {
    for (const n of protoNames) {
      expect(Name.safeParse(n).success, n).toBe(false);
      expect(NAME_REGEX.test(n), n).toBe(false);
      expect(DirectionName.safeParse(n).success, n).toBe(false);
      expect(DIRECTION_REGEX.test(n), n).toBe(false);
      expect(SkinName.safeParse(n).success, n).toBe(false);
      expect(SKIN_NAME_REGEX.test(n), n).toBe(false);
      expect(RenderImagePath.safeParse(`${n}/side/0.png`).success, n).toBe(false);
      expect(RenderImagePath.safeParse(`run/${n}/0.png`).success, n).toBe(false);
    }
  });

  it('still allows names that merely contain a reserved word', () => {
    for (const n of [
      'proto',
      '__proto',
      'constructor2',
      'my_constructor',
      'prototype-x',
      '_proto_',
    ]) {
      expect(Name.safeParse(n).success, n).toBe(true);
      expect(RenderImagePath.safeParse(`${n}/${n}/0.png`).success, n).toBe(true);
    }
  });

  it('fails a markers key instead of silently dropping it', () => {
    for (const key of alphabetProtoNames) {
      const d = doc();
      const a = at(d.animations, 0);
      if ('mirrorOf' in a) throw new Error('expected an authored animation');
      withOwn(at(a.frames, 0).markers, key, { x: 1, y: 2 });
      const result = Document.safeParse(d);
      expect(result.success, key).toBe(false);
      expect(failurePaths(Document, d), key).toContain(`animations.0.frames.0.markers.${key}`);
    }
  });

  it('fails a markers key parsed from real JSON text', () => {
    const d = doc();
    const text = JSON.stringify(d).replace('"markers":{', '"markers":{"__proto__":{"x":1,"y":2},');
    expect(text).toContain('"__proto__"');
    expect(Document.safeParse(JSON.parse(text)).success).toBe(false);
  });

  it('fails a directionFallback key and entry', () => {
    for (const key of alphabetProtoNames) {
      const input = withOwn({ up: ['up'] }, key, ['side']);
      expect(DirectionFallback.safeParse(input).success, key).toBe(false);
      const d = { ...doc(), directionFallback: input };
      expect(failurePaths(Document, d), key).toContain(`directionFallback.${key}`);
      expect(DirectionFallback.safeParse({ up: [key] }).success, key).toBe(false);
    }
  });

  it('fails render-index group, direction and skin keys', () => {
    const run = must(minimalRenderIndex.animations.run);
    for (const key of alphabetProtoNames) {
      const group = jsonCopy(minimalRenderIndex);
      withOwn(group.animations, key, jsonCopy(run));
      expect(RenderIndex.safeParse(group).success, key).toBe(false);

      const direction = jsonCopy(minimalRenderIndex);
      withOwn(must(direction.animations.run), key, { loop: 'loop', mirrorOf: 'right' });
      expect(RenderIndex.safeParse(direction).success, key).toBe(false);

      const skin = jsonCopy(minimalRenderIndex);
      skin.skins = [BASE_SKIN_KEY, key];
      expect(RenderIndex.safeParse(skin).success, key).toBe(false);
    }
  });

  it('keeps parsing the fixture as identity', () => {
    expect(Document.parse(minimalDoc)).toStrictEqual(minimalDoc);
    expect(RenderIndex.parse(minimalRenderIndex)).toStrictEqual(minimalRenderIndex);
  });
});

describe('one name grammar', () => {
  const probes = [
    'a',
    'run-fast',
    'a'.repeat(NAME_MAX_LENGTH),
    'a'.repeat(NAME_MAX_LENGTH + 1),
    '',
    'Body',
    'x.y',
    'run/left',
    'ü',
    UNDIRECTED_KEY,
    BASE_SKIN_KEY,
    '__proto__',
    'constructor',
  ];

  it('agrees across names, directions, skins and path segments, differing only in reserved keys', () => {
    for (const p of probes) {
      const name = Name.safeParse(p).success;
      expect(DirectionName.safeParse(p).success, p).toBe(name && p !== UNDIRECTED_KEY);
      expect(SkinName.safeParse(p).success, p).toBe(name && p !== BASE_SKIN_KEY);
      expect(RENDER_IMAGE_PATH_REGEX.test(`${p}/${p}/3.png`), p).toBe(name);
    }
  });

  it('derives the length limit from NAME_MAX_LENGTH', () => {
    for (const re of [NAME_REGEX, DIRECTION_REGEX, SKIN_NAME_REGEX, RENDER_IMAGE_PATH_REGEX]) {
      expect(re.source).toContain(`{1,${String(NAME_MAX_LENGTH)}}`);
    }
    expect(Name.safeParse('a'.repeat(NAME_MAX_LENGTH)).success).toBe(true);
    expect(Name.safeParse('a'.repeat(NAME_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('keeps the reserved direction and skin keys out of document names but not render paths', () => {
    expect(DirectionName.safeParse(UNDIRECTED_KEY).success).toBe(false);
    expect(SkinName.safeParse(BASE_SKIN_KEY).success).toBe(false);
    expect(RenderImagePath.safeParse(`idle/${UNDIRECTED_KEY}/0.png`).success).toBe(true);
  });

  it('puts the rule in the error messages', () => {
    const message = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
      r.error?.issues[0]?.message ?? '';
    expect(message(Name.safeParse('Bad'))).toContain(`1-${String(NAME_MAX_LENGTH)}`);
    expect(message(DirectionName.safeParse('default'))).toContain('"default"');
    expect(message(SkinName.safeParse('base'))).toContain('"base"');
  });

  it('rejects bad frame paths', () => {
    const f = at(
      (() => {
        const r = minimalRenderIndex.animations.run?.right;
        if (!r || 'mirrorOf' in r) throw new Error('expected frames');
        return r.frames;
      })(),
      0,
    );
    expect(RenderFrame.safeParse({ ...f, image: '__proto__/side/0.png' }).success).toBe(false);
    expect(RenderFrame.safeParse({ ...f, image: 'run/side/0.png' }).success).toBe(true);
  });
});

/** A chain of `levels` nested groups, built iteratively (no recursion in the test itself). */
const nestedGroups = (levels: number): unknown => {
  const base = { visible: true, opacity: 255, export: true };
  let node: unknown = { kind: 'group', id: 'lay_deep', name: 'leaf', ...base, children: [] };
  for (let i = 1; i < levels; i++) {
    node = { kind: 'group', id: 'lay_deep', name: 'g', ...base, children: [node] };
  }
  return node;
};

describe('layer depth', () => {
  it('accepts exactly MAX_LAYER_DEPTH levels and rejects one more', () => {
    expect(MAX_LAYER_DEPTH).toBe(32);
    expect(Layer.safeParse(nestedGroups(MAX_LAYER_DEPTH)).success).toBe(true);
    expect(Layer.safeParse(nestedGroups(MAX_LAYER_DEPTH + 1)).success).toBe(false);
    expect(GroupLayer.safeParse(nestedGroups(MAX_LAYER_DEPTH)).success).toBe(true);
    expect(GroupLayer.safeParse(nestedGroups(MAX_LAYER_DEPTH + 1)).success).toBe(false);
  });

  it('counts depth in a document from each root layer', () => {
    const d = { ...doc(), layers: [nestedGroups(MAX_LAYER_DEPTH), ...doc().layers] };
    expect(Document.safeParse(d).success).toBe(true);
    const tooDeep = { ...doc(), layers: [...doc().layers, nestedGroups(MAX_LAYER_DEPTH + 1)] };
    const result = Document.safeParse(tooDeep);
    expect(result.success).toBe(false);
    expect(failurePaths(Document, tooDeep)).toEqual(['layers.2']);
    expect(result.error?.issues[0]?.message).toContain(String(MAX_LAYER_DEPTH));
  });

  it('fails, without throwing, on a 5000-deep document', () => {
    const d = { ...doc(), layers: [nestedGroups(5000)] };
    let result: ReturnType<typeof Document.safeParse> | undefined;
    expect(() => {
      result = Document.safeParse(d);
    }).not.toThrow();
    expect(result?.success).toBe(false);
    expect(Layer.safeParse(nestedGroups(5000)).success).toBe(false);
  });

  it('fails on a very deep chain of malformed nodes and on cycles-free wide trees', () => {
    // Garbage below a group is left to the structural schema, which reports it.
    const wide = {
      ...(nestedGroups(1) as object),
      children: Array.from({ length: 2000 }, () => nestedGroups(2)),
    };
    expect(Layer.safeParse(wide).success).toBe(true);
    const junk = { ...(nestedGroups(1) as object), children: [null, 7, 'x', { kind: 'group' }] };
    expect(Layer.safeParse(junk).success).toBe(false);
    expect(failurePaths(Layer, junk)).toEqual(
      expect.arrayContaining(['children.0', 'children.1', 'children.2']),
    );
  });

  it('keeps the exported JSON Schema recursive through a Layer definition', () => {
    const text = JSON.stringify(documentJsonSchema());
    expect(text).toContain('"#/$defs/Layer"');
    expect(text).not.toContain('__schema');
  });

  it('keeps layer ids stable in the fixture tree', () => {
    expect(at(doc().layers, 0).id).toBe(ids.layBody);
  });
});

describe('render index skins', () => {
  const withSkins = (skins: string[]) => ({ ...jsonCopy(minimalRenderIndex), skins });

  it('requires base exactly once', () => {
    expect(RenderIndex.safeParse(withSkins([BASE_SKIN_KEY])).success).toBe(true);
    expect(RenderIndex.safeParse(withSkins(['rival', BASE_SKIN_KEY, 'ally'])).success).toBe(true);
    expect(failurePaths(RenderIndex, withSkins(['rival']))).toEqual(['skins']);
    expect(failurePaths(RenderIndex, withSkins([]))).toEqual(['skins']);
    expect(failurePaths(RenderIndex, withSkins([BASE_SKIN_KEY, BASE_SKIN_KEY]))).toEqual(['skins']);
  });

  it('requires every entry to be unique', () => {
    expect(failurePaths(RenderIndex, withSkins([BASE_SKIN_KEY, 'rival', 'rival']))).toEqual([
      'skins',
    ]);
    expect(RenderIndex.safeParse(withSkins([BASE_SKIN_KEY, 'rival', 'ally'])).success).toBe(true);
  });
});

describe('record helper', () => {
  it('rejects a __proto__ key in id-keyed maps too (cels, bone keys, rest poses)', () => {
    const d1 = doc();
    const ball = at(d1.layers, 1);
    if (ball.kind !== 'pixel') throw new Error('expected the ball layer');
    withOwn(ball.cels, '__proto__', { linkTo: ids.frame0 });
    expect(failurePaths(Document, d1)).toEqual(['layers.1.cels.__proto__']);

    const d2 = doc();
    withOwn(at(must(d2.rig).views, 0).rest, '__proto__', { x: 0, y: 0, angle: 0 });
    expect(failurePaths(Document, d2)).toEqual(['rig.views.0.rest.__proto__']);
  });

  it('leaves non-object inputs to the record type check', () => {
    const d = { ...doc(), directionFallback: [] };
    expect(failurePaths(Document, d)).toEqual(['directionFallback']);
    expect(Document.safeParse({ ...doc(), directionFallback: null }).success).toBe(false);
  });
});
