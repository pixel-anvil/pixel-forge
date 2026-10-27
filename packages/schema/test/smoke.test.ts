import { describe, expect, it } from 'vitest';
import { schemaPackage } from '../src/index.js';

describe('@pixel-forge/schema', () => {
  it('loads', () => {
    expect(schemaPackage).toBe('@pixel-forge/schema');
  });
});
