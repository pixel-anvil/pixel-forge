import { Palette, type RGBA8 } from '@pixel-forge/schema';
import type { PalettePreset } from './types.js';
import { aap64 } from './aap-64.js';
import { endesga32 } from './endesga-32.js';
import { nintendoEntertainmentSystem } from './nintendo-entertainment-system.js';
import { nintendoGameboyBgb } from './nintendo-gameboy-bgb.js';
import { pico8 } from './pico-8.js';
import { resurrect64 } from './resurrect-64.js';
import { sweetie16 } from './sweetie-16.js';

export type { PalettePreset } from './types.js';
export {
  aap64,
  endesga32,
  nintendoEntertainmentSystem,
  nintendoGameboyBgb,
  pico8,
  resurrect64,
  sweetie16,
};

/** Every built-in palette preset, in display order. */
export const PRESETS: readonly PalettePreset[] = [
  pico8,
  nintendoEntertainmentSystem,
  nintendoGameboyBgb,
  endesga32,
  resurrect64,
  aap64,
  sweetie16,
];

/**
 * Converts a preset's hex list into the schema {@link Palette} shape: each `RRGGBB` becomes an
 * opaque RGBA8 tuple, `ramps` is empty. `id` must be a valid palette id (`pal_…`).
 */
export function presetToPalette(preset: PalettePreset, id: string, name?: string): Palette {
  const colors: RGBA8[] = preset.hex.map((hex) => {
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return [r, g, b, 255];
  });
  return Palette.parse({ id, name: name ?? preset.name, colors, ramps: [] });
}
