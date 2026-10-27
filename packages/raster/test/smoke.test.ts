import { describe, expect, it } from 'vitest';
import { rasterPackage } from '../src/index.js';

describe('@pixel-forge/raster', () => {
  it('loads', () => {
    expect(rasterPackage).toBe('@pixel-forge/raster');
  });
});
