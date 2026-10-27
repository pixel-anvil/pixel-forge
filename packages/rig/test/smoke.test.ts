import { describe, expect, it } from 'vitest';
import { rigPackage } from '../src/index.js';

describe('@pixel-forge/rig', () => {
  it('loads', () => {
    expect(rigPackage).toBe('@pixel-forge/rig');
  });
});
