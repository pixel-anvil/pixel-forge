import { describe, expect, it } from 'vitest';
import { cliPackage } from '../src/index.js';

describe('@pixel-forge/cli', () => {
  it('loads', () => {
    expect(cliPackage).toBe('@pixel-forge/cli');
  });
});
