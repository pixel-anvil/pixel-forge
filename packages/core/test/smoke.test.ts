import { describe, expect, it } from 'vitest';
import { corePackage } from '../src/index.js';

describe('@pixel-forge/core', () => {
  it('loads', () => {
    expect(corePackage).toBe('@pixel-forge/core');
  });
});
