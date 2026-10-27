import { describe, expect, it } from 'vitest';
import { opsPackage } from '../src/index.js';

describe('@pixel-forge/ops', () => {
  it('loads', () => {
    expect(opsPackage).toBe('@pixel-forge/ops');
  });
});
