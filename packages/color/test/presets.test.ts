import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Palette } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { PRESETS, pico8, presetToPalette } from '../src/presets/index.js';

const sourcesDir = fileURLToPath(new URL('../src/presets/sources/', import.meta.url));

const slugFromSource = (source: string): string => source.split('/').pop() ?? '';

describe('palette presets', () => {
  it('has unique ids', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(PRESETS.map((p) => [p.id, p] as const))(
    '%s matches its Lospec .hex source',
    (_id, preset) => {
      const slug = slugFromSource(preset.source);
      expect(slug).toBe(preset.id);
      const fromFile = readFileSync(`${sourcesDir}${slug}.hex`, 'utf8')
        .split('\n')
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line.length > 0);
      expect(preset.hex).toEqual(fromFile);
    },
  );

  it.each(PRESETS.map((p) => [p.id, p] as const))(
    '%s converts to a valid schema Palette',
    (_id, preset) => {
      const palette = presetToPalette(preset, 'pal_preset');
      expect(palette.colors).toHaveLength(preset.hex.length);
      expect(palette.name).toBe(preset.name);
      expect(palette.ramps).toEqual([]);
      expect(Palette.parse(palette)).toEqual(palette);
      palette.colors.forEach((c, i) => {
        const hex = preset.hex[i] ?? '';
        expect(c).toEqual([
          Number.parseInt(hex.slice(0, 2), 16),
          Number.parseInt(hex.slice(2, 4), 16),
          Number.parseInt(hex.slice(4, 6), 16),
          255,
        ]);
      });
    },
  );

  it('honours an explicit display name', () => {
    const palette = presetToPalette(pico8, 'pal_named', 'Custom');
    expect(palette.name).toBe('Custom');
  });
});
