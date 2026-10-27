import { describe, expect, it } from 'vitest';
import { testkitPackage } from '../src/index.js';

describe('@pixel-forge/testkit', () => {
  it('loads', () => {
    expect(testkitPackage).toBe('@pixel-forge/testkit');
  });
});
