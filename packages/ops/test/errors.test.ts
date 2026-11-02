// toOpError: one wire format for every lower-package error (KNOWN_ISSUES CORE-02).
import { CoreError } from '@pixel-forge/core';
import { AseError, IoError } from '@pixel-forge/io';
import { JointCheckError, RigError } from '@pixel-forge/rig';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OP_ERROR_CODES, OpError, inputError, toOpError } from '../src/index.js';

describe('OpError', () => {
  it('serialises as {code, message, details}', () => {
    const e = new OpError('REFUSED', 'no', { reason: 'x' });
    expect(JSON.parse(JSON.stringify(e))).toEqual({
      code: 'REFUSED',
      message: 'no',
      details: { reason: 'x' },
    });
    expect(new OpError('INTERNAL', 'x').details).toEqual({});
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('OpError');
    expect(OP_ERROR_CODES).toContain('DOC_LOCKED');
  });

  it('maps core refusals by reason: unknown-* is NOT_FOUND, others REFUSED', () => {
    for (const [reason, kind] of [
      ['unknown-animation', 'animation'],
      ['unknown-frame', 'frame'],
      ['unknown-bone', 'bone'],
      ['unknown-view', 'view'],
      ['unknown-part', 'part'],
      ['unknown-variant', 'variant'],
      ['unknown-override', 'override'],
    ]) {
      const e = toOpError(new CoreError('BAD_ARGUMENT', 'm', { reason }));
      expect(e.code).toBe('NOT_FOUND');
      expect(e.details).toMatchObject({ reason, kind });
    }
    for (const reason of ['last-frame', 'mirror-animation', 'has-parts', 'cycle']) {
      expect(toOpError(new CoreError('BAD_ARGUMENT', 'm', { reason }))).toMatchObject({
        code: 'REFUSED',
        details: { reason, cause: { error: 'CoreError', code: 'BAD_ARGUMENT' } },
      });
    }
    expect(
      toOpError(new CoreError('BAD_VALUE', 'm', { reason: 'BAD_RIG', f: () => 1, n: NaN })).details,
    ).toEqual({
      reason: 'BAD_RIG',
      n: 'NaN',
      cause: { error: 'CoreError', code: 'BAD_VALUE' },
    });
    expect(toOpError(new CoreError('TX_ACTIVE', 'm')).code).toBe('INTERNAL');
    expect(toOpError(new CoreError('PATCH_CONFLICT', 'm')).code).toBe('CONFLICT');
  });

  it('maps io, aseprite, rig and joint-check errors', () => {
    expect(toOpError(new IoError('FS_FAILED', 'm'))).toMatchObject({
      code: 'IO_FAILED',
      details: { cause: { error: 'IoError', code: 'FS_FAILED' } },
    });
    expect(toOpError(new IoError('BAD_PXF', 'm')).code).toBe('BAD_FILE');
    expect(toOpError(new IoError('UNSUPPORTED_VERSION', 'm')).code).toBe('BAD_FILE');
    expect(toOpError(new IoError('BAD_INPUT', 'm')).code).toBe('BAD_INPUT');
    expect(toOpError(new AseError('TRUNCATED', 'm')).code).toBe('BAD_FILE');
    expect(toOpError(new RigError('BAD_ARGUMENT', 'm', 'before-mismatch'))).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'before-mismatch' },
    });
    expect(toOpError(new RigError('UNKNOWN_VIEW', 'm')).code).toBe('NOT_FOUND');
    for (const [code, kind] of [
      ['UNKNOWN_BONE', 'bone'],
      ['UNKNOWN_FRAME', 'frame'],
      ['UNKNOWN_VIEW', 'view'],
      ['UNKNOWN_VARIANT', 'variant'],
    ] as const) {
      expect(toOpError(new RigError(code, 'm'))).toMatchObject({
        code: 'NOT_FOUND',
        details: { kind, cause: { error: 'RigError', code } },
      });
    }
    expect(toOpError(new RigError('CYCLE', 'm')).details).not.toHaveProperty('kind');
    expect(toOpError(new JointCheckError('BAD_RADIUS', 'm')).code).toBe('INVALID_VALUE');
  });

  it('maps zod errors to BAD_INPUT with dotted paths', () => {
    const r = z
      .strictObject({ a: z.strictObject({ b: z.int() }) })
      .safeParse({ a: { b: 'x' }, c: 1 });
    if (r.success) throw new Error('expected failure');
    const e = toOpError(r.error);
    expect(e.code).toBe('BAD_INPUT');
    expect(e.details.issues).toEqual([
      { path: 'a.b', message: expect.any(String) as string },
      { path: '', message: expect.any(String) as string },
    ]);
    expect(e.message).toMatch(/at "a\.b".*\(\+1 more\)/);
    expect(inputError(r.error, 'x.y').message).toMatch(/for x\.y/);
  });

  it('maps anything else to INTERNAL', () => {
    expect(toOpError(new Error('boom'))).toMatchObject({
      code: 'INTERNAL',
      message: 'internal error: boom',
    });
    expect(toOpError(42).details).toEqual({ cause: { error: 'number' } });
    const op = new OpError('AMBIGUOUS', 'x');
    expect(toOpError(op)).toBe(op);
  });
});
