/**
 * Typed model of a parsed `.aseprite` file.
 *
 * Implemented from the published file-format documentation (`ase-file-specs.md`) only; no
 * Aseprite source code was consulted. Aseprite's CLI output is used as a test oracle.
 */

/** Bits per pixel: 32 = RGBA, 16 = grayscale (value, alpha), 8 = indexed. */
export type AseColorDepth = 32 | 16 | 8;

/** An RGBA colour, each channel 0..255 (straight, not premultiplied alpha). */
export interface AseColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** The decoded 128-byte file header. */
export interface AseHeader {
  /** File size recorded in the header (not used to bound parsing). */
  readonly fileSize: number;
  /** Number of frames. */
  readonly frameCount: number;
  /** Canvas width in pixels. */
  readonly width: number;
  /** Canvas height in pixels. */
  readonly height: number;
  /** Bits per pixel: 32 (RGBA), 16 (grayscale) or 8 (indexed). */
  readonly colorDepth: AseColorDepth;
  /** Raw header flags. */
  readonly flags: number;
  /** Flag 1: the layer opacity field is valid (otherwise layers are fully opaque). */
  readonly layerOpacityValid: boolean;
  /** Flag 2: blend mode and opacity are also valid for group layers. */
  readonly groupBlendValid: boolean;
  /** Flag 4: layer chunks carry a UUID. */
  readonly layerUuids: boolean;
  /** Deprecated default frame duration (ms), used for frames whose own duration is 0. */
  readonly speedMs: number;
  /** Palette index that is transparent on non-background layers (indexed sprites only). */
  readonly transparentIndex: number;
  /** Number of palette colours recorded in the header (0 in the file means 256; reported as 256). */
  readonly paletteEntryCount: number;
  /** Pixel aspect ratio numerator (1 when the file says 0). */
  readonly pixelWidth: number;
  /** Pixel aspect ratio denominator (1 when the file says 0). */
  readonly pixelHeight: number;
  /** Grid origin X. */
  readonly gridX: number;
  /** Grid origin Y. */
  readonly gridY: number;
  /** Grid width (0 when there is no grid). */
  readonly gridWidth: number;
  /** Grid height (0 when there is no grid). */
  readonly gridHeight: number;
}

/**
 * Raw pixel data of one image. `data` layout depends on `depth`:
 * 32 = RGBA (4 bytes/pixel), 16 = grayscale (value, alpha; 2 bytes/pixel), 8 = palette indices
 * (1 byte/pixel). Rows run top to bottom, pixels left to right.
 */
export interface AseImage {
  /** Width in pixels. */
  readonly width: number;
  /** Height in pixels. */
  readonly height: number;
  /** Colour depth of `data`. */
  readonly depth: AseColorDepth;
  /** Pixel bytes, `width * height * (depth / 8)` long. */
  readonly data: Uint8Array;
}

/** User-data payload (chunk 0x2020). */
export interface AseUserData {
  /** Text, when the has-text flag was set. */
  text?: string;
  /** Colour, when the has-colour flag was set. */
  color?: AseColor;
  /** Raw bytes of the properties maps (not decoded), when the has-properties flag was set. */
  properties?: Uint8Array;
}

/** What a user-data chunk was attached to. */
export type AseUserDataTarget =
  | { readonly kind: 'layer'; readonly layerIndex: number }
  | { readonly kind: 'cel'; readonly frameIndex: number; readonly layerIndex: number }
  | { readonly kind: 'tag'; readonly tagIndex: number }
  | { readonly kind: 'slice'; readonly sliceIndex: number }
  | { readonly kind: 'sprite' };

/** Layer kinds. */
export type AseLayerType = 'normal' | 'group' | 'tilemap';

/** Blend mode names (Aseprite's JSON export spelling), indexed by the chunk's WORD. */
export const ASE_BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color_dodge',
  'color_burn',
  'hard_light',
  'soft_light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'addition',
  'subtract',
  'divide',
] as const;

/** A known blend mode name. */
export type AseBlendMode = (typeof ASE_BLEND_MODES)[number];

/** A layer (chunk 0x2004). Its `index` is its position among all layer chunks (NOTE.2). */
export interface AseLayer {
  /** Layer index used by cels: order of appearance of the layer chunks. */
  readonly index: number;
  /** Layer name. */
  readonly name: string;
  /** Normal image layer, group or tilemap layer. */
  readonly type: AseLayerType;
  /** Nesting depth (0 = top level). */
  readonly childLevel: number;
  /** Index of the enclosing group layer, or null at top level. */
  readonly parentIndex: number | null;
  /** Raw layer flags. */
  readonly flags: number;
  /** Flag 1. Only this layer's own flag; a hidden parent group also hides the layer. */
  readonly visible: boolean;
  /** Flag 2. */
  readonly editable: boolean;
  /** Flag 4. */
  readonly lockMovement: boolean;
  /** Flag 8: background layer (indexed transparency does not apply to it). */
  readonly background: boolean;
  /** Flag 16. */
  readonly preferLinkedCels: boolean;
  /** Flag 32: group shown collapsed. */
  readonly collapsed: boolean;
  /** Flag 64. */
  readonly reference: boolean;
  /** Blend mode name, or 'normal' when the mode is not valid for this layer (groups without header flag 2). */
  readonly blendMode: AseBlendMode;
  /** Blend mode as stored (may be outside {@link ASE_BLEND_MODES} for files from newer versions). */
  readonly blendModeValue: number;
  /**
   * Effective opacity 0..255. 255 when the header says layer opacity is not valid, or (for
   * groups) when header flag 2 is off.
   */
  readonly opacity: number;
  /** Opacity byte as stored. */
  readonly opacityRaw: number;
  /** Tileset index for tilemap layers, otherwise null. */
  readonly tilesetIndex: number | null;
  /** Layer UUID (32 lowercase hex digits) when the header flag 4 is set, otherwise null. */
  readonly uuid: string | null;
  /** User data that followed this layer chunk. */
  userData?: AseUserData;
}

/** Precise bounds from a cel-extra chunk (0x2006). */
export interface AseCelExtra {
  /** Raw flags (1 = precise bounds set). */
  readonly flags: number;
  /** Precise X position. */
  readonly x: number;
  /** Precise Y position. */
  readonly y: number;
  /** Width of the cel in the sprite. */
  readonly width: number;
  /** Height of the cel in the sprite. */
  readonly height: number;
}

/** Cel content by cel type. */
export type AseCelContent =
  | {
      /** Types 0 (raw) and 2 (zlib-compressed): decoded pixels. */
      readonly type: 'image';
      readonly image: AseImage;
      /** How the pixels were stored in the file. */
      readonly encoding: 'raw' | 'zlib';
    }
  | {
      /** Type 1: shares the image of the cel on the same layer in another frame. */
      readonly type: 'linked';
      /** 0-based frame index of the cel this one links to. */
      readonly framePosition: number;
    }
  | {
      /** Type 3: tilemap. Header fields only; tile data is not decoded and has no pixels. */
      readonly type: 'tilemap';
      readonly widthTiles: number;
      readonly heightTiles: number;
      readonly bitsPerTile: number;
      readonly tileIdMask: number;
      readonly xFlipMask: number;
      readonly yFlipMask: number;
      readonly diagonalFlipMask: number;
    };

/** A cel (chunk 0x2005): an image placed on one layer in one frame. */
export interface AseCel {
  /** 0-based index of the frame this cel appears in. */
  readonly frameIndex: number;
  /** Index into {@link AseFile.layers}. */
  readonly layerIndex: number;
  /** X position of the cel's top-left corner on the canvas (may be negative). */
  readonly x: number;
  /** Y position of the cel's top-left corner on the canvas (may be negative). */
  readonly y: number;
  /** Cel opacity 0..255. */
  readonly opacity: number;
  /** Z-index (NOTE.5): render order is `layerIndex + zIndex`, then `zIndex`. */
  readonly zIndex: number;
  /** Pixel payload. */
  readonly content: AseCelContent;
  /** Cel-extra chunk that followed, if any. */
  extra?: AseCelExtra;
  /** User data that followed this cel. */
  userData?: AseUserData;
}

/** One palette colour. */
export interface AsePaletteEntry extends AseColor {
  /** Colour name (0x2019 entries with the has-name flag). */
  readonly name?: string;
}

/** A palette. Treat as immutable; each change in a later frame produces a new object. */
export interface AsePalette {
  /** Entries in index order. */
  readonly entries: readonly AsePaletteEntry[];
  /** Which chunk type supplied it: the new 0x2019 chunk or an old 0x0004/0x0011 chunk. */
  readonly source: 'new' | 'old';
}

/** Tag playback direction. */
export type AseTagDirection = 'forward' | 'reverse' | 'pingpong' | 'pingpong_reverse';

/** A tag (chunk 0x2018). `from` and `to` are 0-based and inclusive. */
export interface AseTag {
  /** Tag name. */
  readonly name: string;
  /** First frame (0-based). */
  readonly from: number;
  /** Last frame (0-based, inclusive). */
  readonly to: number;
  /** Playback direction. */
  readonly direction: AseTagDirection;
  /** Repeat count; 0 = unspecified (see the format notes). */
  readonly repeat: number;
  /** Deprecated RGB colour stored in the tag itself (Aseprite 1.2.x); the real colour is in `userData`. */
  readonly legacyColor: { readonly r: number; readonly g: number; readonly b: number };
  /** The user-data chunk that followed the tags chunk for this tag (colour and text). */
  userData?: AseUserData;
}

/** One key of a slice. */
export interface AseSliceKey {
  /** First frame this key applies to. */
  readonly frame: number;
  /** X origin. */
  readonly x: number;
  /** Y origin. */
  readonly y: number;
  /** Width (0 = hidden). */
  readonly width: number;
  /** Height. */
  readonly height: number;
  /** Nine-patch centre rectangle, relative to the slice bounds. */
  readonly center?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Pivot, relative to the slice origin. */
  readonly pivot?: { readonly x: number; readonly y: number };
}

/** A slice (chunk 0x2022). */
export interface AseSlice {
  /** Slice name. */
  readonly name: string;
  /** Raw flags (1 = nine-patch, 2 = has pivot). */
  readonly flags: number;
  /** Keys in file order. */
  readonly keys: readonly AseSliceKey[];
  /** User data that followed this slice. */
  userData?: AseUserData;
}

/** Colour profile (chunk 0x2007). */
export interface AseColorProfile {
  /** 0 = none, 1 = sRGB, 2 = embedded ICC profile. */
  readonly type: number;
  /** Raw flags (1 = fixed gamma). */
  readonly flags: number;
  /** Fixed gamma (1.0 = linear). */
  readonly gamma: number;
  /** ICC profile bytes when type = 2. */
  readonly icc?: Uint8Array;
}

/** One decoded chunk, in file order. */
export type AseChunk =
  | { readonly kind: 'layer'; readonly layer: AseLayer }
  | { readonly kind: 'cel'; readonly cel: AseCel }
  | { readonly kind: 'celExtra'; readonly extra: AseCelExtra }
  | { readonly kind: 'colorProfile'; readonly profile: AseColorProfile }
  | {
      /** 0x2019. `entries` are the replaced range starting at `first`; `size` the new palette size. */
      readonly kind: 'palette';
      readonly size: number;
      readonly first: number;
      readonly entries: readonly AsePaletteEntry[];
    }
  | {
      /** 0x0004 / 0x0011. Ignored for the effective palette when a 0x2019 chunk exists. */
      readonly kind: 'oldPalette';
      readonly chunkType: 0x0004 | 0x0011;
      readonly entries: readonly AseColor[];
    }
  | { readonly kind: 'tags'; readonly tags: readonly AseTag[] }
  | {
      readonly kind: 'userData';
      readonly data: AseUserData;
      /** The object the data was attached to, or null when it has no attachable owner. */
      readonly target: AseUserDataTarget | null;
    }
  | { readonly kind: 'slice'; readonly slice: AseSlice }
  | {
      /** A chunk type the spec documents that this parser deliberately does not decode. */
      readonly kind: 'skipped';
      readonly chunkType: number;
      readonly name: string;
      readonly note: string;
      /** Chunk size in bytes, including the 6-byte chunk header. */
      readonly size: number;
    }
  | {
      /** A chunk type not in the spec; skipped by its size. */
      readonly kind: 'unknown';
      readonly chunkType: number;
      readonly size: number;
    };

/** One animation frame. */
export interface AseFrame {
  /** 0-based position. */
  readonly index: number;
  /** Duration in ms (the frame's own field, or the header speed when that is 0). */
  readonly durationMs: number;
  /** Decoded chunks in file order. */
  readonly chunks: readonly AseChunk[];
  /** The cels of this frame (also present in `chunks`), in file order. */
  readonly cels: readonly AseCel[];
  /** Effective palette once this frame's chunks are applied (null if none seen yet). */
  readonly palette: AsePalette | null;
}

/** A parsed `.aseprite` file. */
export interface AseFile {
  /** Header. */
  readonly header: AseHeader;
  /** Frames in order. */
  readonly frames: readonly AseFrame[];
  /** All layers in layer-index order (parents precede children). */
  readonly layers: readonly AseLayer[];
  /** All tags in file order. */
  readonly tags: readonly AseTag[];
  /** All slices in file order. */
  readonly slices: readonly AseSlice[];
  /** Palette after the last frame (new 0x2019 palette wins over old chunks); null when none was stored. */
  readonly palette: AsePalette | null;
  /** Colour profile, if the file has one. */
  readonly colorProfile: AseColorProfile | null;
  /** Sprite-level user data (the user-data chunk right after the first-frame palette). */
  userData?: AseUserData;
}
