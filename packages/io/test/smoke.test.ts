import { describe, expect, it } from 'vitest';
import { ioPackage } from '../src/index.js';

describe('@pixel-forge/io', () => {
  it('loads', () => {
    expect(ioPackage).toBe('@pixel-forge/io');
  });
});
