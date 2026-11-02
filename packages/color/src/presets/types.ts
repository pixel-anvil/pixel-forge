export interface PalettePreset {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly author: string;
  readonly license: string;
  /** 6-digit lower-case hex, exactly as in the source .hex file. */
  readonly hex: readonly string[];
}
