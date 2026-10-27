import { describe, expect, it } from 'vitest';
import { serverPackage } from '../src/index.js';

describe('@pixel-forge/server', () => {
  it('loads', () => {
    expect(serverPackage).toBe('@pixel-forge/server');
  });
});
