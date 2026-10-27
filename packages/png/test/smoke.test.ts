import { describe, expect, it } from 'vitest';
import { pngPackage } from '../src/index.js';

describe('@pixel-forge/png', () => {
  it('loads', () => {
    expect(pngPackage).toBe('@pixel-forge/png');
  });
});
