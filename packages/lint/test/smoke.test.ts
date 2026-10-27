import { describe, expect, it } from 'vitest';
import { lintPackage } from '../src/index.js';

describe('@pixel-forge/lint', () => {
  it('loads', () => {
    expect(lintPackage).toBe('@pixel-forge/lint');
  });
});
