/**
 * The registry of motion presets (FR-RIG-15). E3.1 ships `walk`; later cards add to {@link PRESETS}.
 * @packageDocumentation
 */
import { RigError } from './errors.js';
import { idleBreathe } from './idle-breathe.js';
import type { Preset } from './preset.js';
import { swing } from './swing.js';
import { walk } from './walk.js';

/** Every motion preset by name. */
export const PRESETS: Readonly<Record<string, Preset>> = {
  walk,
  'idle-breathe': idleBreathe,
  swing,
};

/** The names in {@link PRESETS}, sorted. */
export const PRESET_NAMES: readonly string[] = Object.keys(PRESETS).sort();

/** The preset called `name`. Throws `RigError('BAD_VALUE')` for an unknown name. */
export function getPreset(name: string): Preset {
  const preset = Object.hasOwn(PRESETS, name) ? PRESETS[name] : undefined;
  if (preset === undefined) {
    throw new RigError('BAD_VALUE', `unknown preset "${name}" (known: ${PRESET_NAMES.join(', ')})`);
  }
  return preset;
}
