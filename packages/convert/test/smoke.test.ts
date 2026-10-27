import { describe, expect, it } from 'vitest';
import { convertPackage } from '../src/index.js';

describe('@pixel-forge/convert', () => {
  it('loads', () => {
    expect(convertPackage).toBe('@pixel-forge/convert');
  });
});
