import { describe, expect, it } from 'vitest';
import { colorPackage } from '../src/index.js';

describe('@pixel-forge/color', () => {
  it('loads', () => {
    expect(colorPackage).toBe('@pixel-forge/color');
  });
});
