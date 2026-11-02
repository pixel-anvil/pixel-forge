import { unzlibSync } from 'fflate';
import { AseError } from './errors.js';
import { Reader } from './reader.js';
import { ASE_BLEND_MODES } from './types.js';
import type {
  AseBlendMode,
  AseCel,
  AseCelContent,
  AseCelExtra,
  AseChunk,
  AseColor,
  AseColorProfile,
  AseFile,
  AseFrame,
  AseHeader,
  AseImage,
  AseLayer,
  AseLayerType,
  AsePalette,
  AsePaletteEntry,
  AseSlice,
  AseSliceKey,
  AseTag,
  AseTagDirection,
  AseUserData,
  AseUserDataTarget,
} from './types.js';

/** Largest accepted canvas width or height, in pixels. */
export const ASE_MAX_DIMENSION = 16384;
/** Largest accepted frame count (the header field is a 16-bit WORD, so this is also its maximum). */
export const ASE_MAX_FRAMES = 65535;
/** Cap on the total bytes of decoded cel pixels in one file. */
export const ASE_MAX_DECODED_BYTES = 512 * 1024 * 1024;
/** Largest palette a 0x2019 chunk may declare. */
const MAX_PALETTE = 65536;
/** Deepest layer nesting accepted. */
const MAX_CHILD_LEVEL = 255;

const HEADER_SIZE = 128;
const FRAME_HEADER_SIZE = 16;
const FILE_MAGIC = 0xa5e0;
const FRAME_MAGIC = 0xf1fa;

const TAG_DIRECTIONS: readonly AseTagDirection[] = [
  'forward',
  'reverse',
  'pingpong',
  'pingpong_reverse',
];
const LAYER_TYPES: readonly AseLayerType[] = ['normal', 'group', 'tilemap'];

/** Documented chunk types that are recognised but deliberately not decoded. */
const SKIPPED: Readonly<Record<number, { name: string; note: string }>> = {
  0x2008: { name: 'externalFiles', note: 'external files list is not needed for import' },
  0x2016: { name: 'mask', note: 'deprecated by Aseprite' },
  0x2017: { name: 'path', note: 'never used by Aseprite' },
  0x2023: {
    name: 'tileset',
    note: 'tilesets and tilemap pixels are not supported (tilemap cels keep their header only)',
  },
};

/** Mutable parse state shared by the chunk decoders. */
interface Ctx {
  readonly header: AseHeader;
  readonly layers: AseLayer[];
  /** Index of the last layer seen at each child level. */
  readonly lastAtLevel: number[];
  readonly tags: AseTag[];
  readonly slices: AseSlice[];
  colorProfile: AseColorProfile | null;
  decodedBytes: number;
  /** Palette built from 0x2019 chunks, and from old chunks. */
  newPalette: AsePaletteEntry[] | null;
  oldPalette: AseColor[] | null;
  /** Bumped whenever a palette chunk changes either palette. */
  paletteVersion: number;
  spriteUserData: AseUserData | undefined;
}

function parseHeader(bytes: Uint8Array): AseHeader {
  if (bytes.length < 6) throw new AseError('TRUNCATED', 'input shorter than the file magic');
  const r = new Reader(bytes, 0, bytes.length, 'TRUNCATED');
  const fileSize = r.u32();
  if (r.u16() !== FILE_MAGIC)
    throw new AseError('BAD_MAGIC', 'not an .aseprite file (magic 0xA5E0 expected)');
  if (bytes.length < HEADER_SIZE)
    throw new AseError('TRUNCATED', 'input shorter than the 128-byte header');
  const frameCount = r.u16();
  const width = r.u16();
  const height = r.u16();
  const depth = r.u16();
  const flags = r.u32();
  const speedMs = r.u16();
  r.skip(8);
  const transparentIndex = r.u8();
  r.skip(3);
  const ncolors = r.u16();
  const pw = r.u8();
  const ph = r.u8();
  const gridX = r.i16();
  const gridY = r.i16();
  const gridWidth = r.u16();
  const gridHeight = r.u16();
  if (depth !== 32 && depth !== 16 && depth !== 8) {
    throw new AseError('BAD_HEADER', `colour depth ${String(depth)} is not 8, 16 or 32`);
  }
  if (width === 0 || height === 0)
    throw new AseError('BAD_HEADER', 'canvas has zero width or height');
  if (frameCount === 0) throw new AseError('BAD_HEADER', 'file has no frames');
  if (width > ASE_MAX_DIMENSION || height > ASE_MAX_DIMENSION) {
    throw new AseError(
      'TOO_LARGE',
      `canvas ${String(width)}x${String(height)} exceeds ${String(ASE_MAX_DIMENSION)}x${String(ASE_MAX_DIMENSION)}`,
    );
  }
  if (frameCount > ASE_MAX_FRAMES) {
    throw new AseError(
      'TOO_LARGE',
      `${String(frameCount)} frames exceeds ${String(ASE_MAX_FRAMES)}`,
    );
  }
  return {
    fileSize,
    frameCount,
    width,
    height,
    colorDepth: depth,
    flags,
    layerOpacityValid: (flags & 1) !== 0,
    groupBlendValid: (flags & 2) !== 0,
    layerUuids: (flags & 4) !== 0,
    speedMs,
    transparentIndex,
    paletteEntryCount: ncolors === 0 ? 256 : ncolors,
    pixelWidth: pw === 0 || ph === 0 ? 1 : pw,
    pixelHeight: pw === 0 || ph === 0 ? 1 : ph,
    gridX,
    gridY,
    gridWidth,
    gridHeight,
  };
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function decodeLayer(r: Reader, ctx: Ctx): AseLayer {
  const flags = r.u16();
  const typeValue = r.u16();
  const childLevel = r.u16();
  r.skip(4); // default width/height, ignored
  const blendModeValue = r.u16();
  const opacityRaw = r.u8();
  r.skip(3);
  const name = r.string();
  const type = LAYER_TYPES[typeValue];
  if (type === undefined)
    throw new AseError('BAD_CHUNK', `unknown layer type ${String(typeValue)}`);
  const tilesetIndex = type === 'tilemap' ? r.u32() : null;
  const uuid = ctx.header.layerUuids ? hex(r.view8(16)) : null;

  if (childLevel > MAX_CHILD_LEVEL)
    throw new AseError('BAD_CHUNK', `layer child level ${String(childLevel)} too deep`);
  const index = ctx.layers.length;
  let parentIndex: number | null = null;
  if (childLevel > 0) {
    parentIndex = ctx.lastAtLevel[childLevel - 1] ?? null;
    const parent = parentIndex === null ? undefined : ctx.layers[parentIndex];
    if (parent?.type !== 'group') {
      throw new AseError(
        'BAD_CHUNK',
        `layer "${name}" at child level ${String(childLevel)} has no enclosing group`,
      );
    }
  }
  ctx.lastAtLevel.length = childLevel;
  ctx.lastAtLevel[childLevel] = index;

  // NOTE.6: blend mode is always valid for image/tilemap layers; for groups only with header
  // flag 2. Opacity additionally needs header flag 1.
  const blendValid = type !== 'group' || ctx.header.groupBlendValid;
  const opacityValid = ctx.header.layerOpacityValid && blendValid;
  const known: AseBlendMode | undefined = ASE_BLEND_MODES[blendModeValue];
  return {
    index,
    name,
    type,
    childLevel,
    parentIndex,
    flags,
    visible: (flags & 1) !== 0,
    editable: (flags & 2) !== 0,
    lockMovement: (flags & 4) !== 0,
    background: (flags & 8) !== 0,
    preferLinkedCels: (flags & 16) !== 0,
    collapsed: (flags & 32) !== 0,
    reference: (flags & 64) !== 0,
    blendMode: blendValid ? (known ?? 'normal') : 'normal',
    blendModeValue,
    opacity: opacityValid ? opacityRaw : 255,
    opacityRaw,
    tilesetIndex,
    uuid,
  };
}

/** Inflate a zlib stream to exactly `expected` bytes, never allocating more than `expected + 1`. */
function inflateExact(data: Uint8Array, expected: number): Uint8Array {
  // DEFLATE cannot expand by more than ~1032:1, so a larger claim is a lie (decompression bomb).
  if (expected > data.length * 1032 + 1024) {
    throw new AseError(
      'DECOMPRESS_FAILED',
      `${String(data.length)} compressed bytes cannot yield ${String(expected)}`,
    );
  }
  let out: Uint8Array;
  try {
    out = unzlibSync(data, { out: new Uint8Array(expected + 1) });
  } catch (e) {
    throw new AseError(
      'DECOMPRESS_FAILED',
      `zlib stream is corrupt (${e instanceof Error ? e.message : 'unknown'})`,
    );
  }
  if (out.length !== expected) {
    throw new AseError(
      'DECOMPRESS_FAILED',
      `inflated ${String(out.length)} bytes, expected ${String(expected)}`,
    );
  }
  return out;
}

function imageSize(ctx: Ctx, width: number, height: number): number {
  const bytes = width * height * (ctx.header.colorDepth / 8);
  ctx.decodedBytes += bytes;
  if (ctx.decodedBytes > ASE_MAX_DECODED_BYTES) {
    throw new AseError('TOO_LARGE', 'decoded cel pixels exceed the size limit');
  }
  return bytes;
}

function decodeCel(r: Reader, ctx: Ctx, frameIndex: number): AseCel {
  const layerIndex = r.u16();
  const x = r.i16();
  const y = r.i16();
  const opacity = r.u8();
  const celType = r.u16();
  const zIndex = r.i16();
  r.skip(5);
  const depth = ctx.header.colorDepth;
  let content: AseCelContent;
  switch (celType) {
    case 0:
    case 2: {
      const width = r.u16();
      const height = r.u16();
      const bytes = imageSize(ctx, width, height);
      const data = celType === 0 ? r.take(bytes) : inflateExact(r.view8(r.remaining), bytes);
      const image: AseImage = { width, height, depth, data };
      content = { type: 'image', image, encoding: celType === 0 ? 'raw' : 'zlib' };
      break;
    }
    case 1:
      content = { type: 'linked', framePosition: r.u16() };
      break;
    case 3: {
      const widthTiles = r.u16();
      const heightTiles = r.u16();
      const bitsPerTile = r.u16();
      content = {
        type: 'tilemap',
        widthTiles,
        heightTiles,
        bitsPerTile,
        tileIdMask: r.u32(),
        xFlipMask: r.u32(),
        yFlipMask: r.u32(),
        diagonalFlipMask: r.u32(),
      };
      break;
    }
    default:
      throw new AseError('BAD_CHUNK', `unknown cel type ${String(celType)}`);
  }
  return { frameIndex, layerIndex, x, y, opacity, zIndex, content };
}

function decodeCelExtra(r: Reader): AseCelExtra {
  const flags = r.u32();
  return { flags, x: r.fixed(), y: r.fixed(), width: r.fixed(), height: r.fixed() };
}

function decodeColorProfile(r: Reader): AseColorProfile {
  const type = r.u16();
  const flags = r.u16();
  const gamma = r.fixed();
  r.skip(8);
  if (type === 2) return { type, flags, gamma, icc: r.take(r.u32()) };
  return { type, flags, gamma };
}

const DEFAULT_ENTRY: AsePaletteEntry = { r: 0, g: 0, b: 0, a: 255 };

function decodeNewPalette(r: Reader, ctx: Ctx): Extract<AseChunk, { kind: 'palette' }> {
  const size = r.u32();
  const first = r.u32();
  const last = r.u32();
  r.skip(8);
  if (size > MAX_PALETTE) throw new AseError('TOO_LARGE', `palette of ${String(size)} entries`);
  if (first > last || last >= size) {
    throw new AseError(
      'BAD_CHUNK',
      `palette range ${String(first)}..${String(last)} outside size ${String(size)}`,
    );
  }
  const entries: AsePaletteEntry[] = [];
  for (let i = first; i <= last; i++) {
    const flags = r.u16();
    const e = { r: r.u8(), g: r.u8(), b: r.u8(), a: r.u8() };
    entries.push((flags & 1) !== 0 ? { ...e, name: r.string() } : e);
  }
  const next: AsePaletteEntry[] = (ctx.newPalette ?? []).slice(0, size);
  while (next.length < size) next.push(DEFAULT_ENTRY);
  entries.forEach((e, i) => {
    next[first + i] = e;
  });
  ctx.newPalette = next;
  ctx.paletteVersion++;
  return { kind: 'palette', size, first, entries };
}

function decodeOldPalette(r: Reader, ctx: Ctx, chunkType: 0x0004 | 0x0011): AseChunk {
  const packets = r.u16();
  const entries: AseColor[] = [];
  const next: AseColor[] = (ctx.oldPalette ?? []).slice();
  let at = 0;
  // 0x0011 stores 6-bit components (0..63); widen to 8 bits by bit replication.
  const comp = (v: number): number => (chunkType === 0x0004 ? v : (v << 2) | (v >> 4));
  for (let p = 0; p < packets; p++) {
    at += r.u8();
    const count = r.u8() || 256;
    if (at + count > 256) throw new AseError('BAD_CHUNK', 'old palette packet passes entry 255');
    for (let i = 0; i < count; i++) {
      const c = { r: comp(r.u8()), g: comp(r.u8()), b: comp(r.u8()), a: 255 };
      entries.push(c);
      while (next.length < at) next.push(DEFAULT_ENTRY);
      next[at++] = c;
    }
  }
  ctx.oldPalette = next;
  ctx.paletteVersion++;
  return { kind: 'oldPalette', chunkType, entries };
}

function decodeTags(r: Reader): AseTag[] {
  const n = r.u16();
  r.skip(8);
  const tags: AseTag[] = [];
  for (let i = 0; i < n; i++) {
    const from = r.u16();
    const to = r.u16();
    const dirValue = r.u8();
    const repeat = r.u16();
    r.skip(6);
    const legacyColor = { r: r.u8(), g: r.u8(), b: r.u8() };
    r.skip(1);
    const name = r.string();
    const direction = TAG_DIRECTIONS[dirValue];
    if (direction === undefined)
      throw new AseError('BAD_CHUNK', `tag "${name}" has unknown direction ${String(dirValue)}`);
    tags.push({ name, from, to, direction, repeat, legacyColor });
  }
  return tags;
}

function decodeUserData(r: Reader): AseUserData {
  const flags = r.u32();
  const data: AseUserData = {};
  if ((flags & 1) !== 0) data.text = r.string();
  if ((flags & 2) !== 0) data.color = { r: r.u8(), g: r.u8(), b: r.u8(), a: r.u8() };
  if ((flags & 4) !== 0) {
    const start = r.pos;
    const size = r.u32();
    if (size < 8)
      throw new AseError('BAD_CHUNK', `user-data properties block of ${String(size)} bytes`);
    r.pos = start;
    data.properties = r.take(size);
  }
  return data;
}

function decodeSlice(r: Reader): AseSlice {
  const n = r.u32();
  const flags = r.u32();
  r.skip(4);
  const name = r.string();
  const keys: AseSliceKey[] = [];
  for (let i = 0; i < n; i++) {
    const frame = r.u32();
    const x = r.i32();
    const y = r.i32();
    const width = r.u32();
    const height = r.u32();
    const center =
      (flags & 1) !== 0 ? { x: r.i32(), y: r.i32(), width: r.u32(), height: r.u32() } : undefined;
    const pivot = (flags & 2) !== 0 ? { x: r.i32(), y: r.i32() } : undefined;
    keys.push({
      frame,
      x,
      y,
      width,
      height,
      ...(center === undefined ? {} : { center }),
      ...(pivot === undefined ? {} : { pivot }),
    });
  }
  return { name, flags, keys };
}

function snapshot(ctx: Ctx): AsePalette | null {
  if (ctx.newPalette !== null) return { entries: ctx.newPalette, source: 'new' };
  if (ctx.oldPalette !== null) return { entries: ctx.oldPalette, source: 'old' };
  return null;
}

/** Decode every frame's chunks. */
function parseFrame(
  bytes: Uint8Array,
  start: number,
  index: number,
  ctx: Ctx,
  prev: AsePalette | null,
) {
  const fr = new Reader(bytes, start, bytes.length, 'TRUNCATED');
  if (fr.remaining < FRAME_HEADER_SIZE)
    throw new AseError('TRUNCATED', `frame ${String(index)} header cut off`);
  const frameSize = fr.u32();
  const magic = fr.u16();
  const oldCount = fr.u16();
  const duration = fr.u16();
  fr.skip(2);
  const newCount = fr.u32();
  if (magic !== FRAME_MAGIC)
    throw new AseError('BAD_CHUNK', `frame ${String(index)} has bad magic`);
  if (frameSize < FRAME_HEADER_SIZE)
    throw new AseError('BAD_CHUNK', `frame ${String(index)} size ${String(frameSize)}`);
  const end = start + frameSize;
  if (end > bytes.length)
    throw new AseError('TRUNCATED', `frame ${String(index)} runs past the end of the input`);
  const count = newCount !== 0 ? newCount : oldCount;

  const body = new Reader(bytes, fr.pos, end, 'BAD_CHUNK');
  const chunks: AseChunk[] = [];
  const cels: AseCel[] = [];
  const versionBefore = ctx.paletteVersion;

  // User data belongs to the object of the previous chunk (spec: "last read chunk/object").
  const owner: { fn: ((ud: AseUserData) => AseUserDataTarget | null) | null } = { fn: null };
  const single = (set: (ud: AseUserData) => void, target: AseUserDataTarget) => {
    owner.fn = (ud) => {
      set(ud);
      owner.fn = null;
      return target;
    };
  };
  let lastCel: AseCel | undefined;
  let pendingFirstFramePalette = false;

  for (let c = 0; c < count; c++) {
    if (body.remaining < 6)
      throw new AseError('BAD_CHUNK', `frame ${String(index)} has fewer chunks than declared`);
    const chunkStart = body.pos;
    const size = body.u32();
    const type = body.u16();
    if (size < 6 || chunkStart + size > end) {
      throw new AseError(
        'BAD_CHUNK',
        `chunk 0x${type.toString(16)} size ${String(size)} at offset ${String(chunkStart)}`,
      );
    }
    const r = new Reader(bytes, body.pos, chunkStart + size, 'BAD_CHUNK');
    body.pos = chunkStart + size;

    if (type !== 0x2020) pendingFirstFramePalette = false;
    switch (type) {
      case 0x2004: {
        const layer = decodeLayer(r, ctx);
        ctx.layers.push(layer);
        chunks.push({ kind: 'layer', layer });
        single(
          (ud) => {
            layer.userData = ud;
          },
          { kind: 'layer', layerIndex: layer.index },
        );
        break;
      }
      case 0x2005: {
        const cel = decodeCel(r, ctx, index);
        cels.push(cel);
        chunks.push({ kind: 'cel', cel });
        lastCel = cel;
        single(
          (ud) => {
            cel.userData = ud;
          },
          { kind: 'cel', frameIndex: index, layerIndex: cel.layerIndex },
        );
        break;
      }
      case 0x2006: {
        const extra = decodeCelExtra(r);
        chunks.push({ kind: 'celExtra', extra });
        if (lastCel !== undefined) lastCel.extra = extra; // user data still belongs to the cel
        break;
      }
      case 0x2007: {
        const profile = decodeColorProfile(r);
        ctx.colorProfile = profile;
        chunks.push({ kind: 'colorProfile', profile });
        owner.fn = null;
        break;
      }
      case 0x2019:
        chunks.push(decodeNewPalette(r, ctx));
        owner.fn = null;
        pendingFirstFramePalette = index === 0 && ctx.spriteUserData === undefined;
        break;
      case 0x0004:
      case 0x0011:
        chunks.push(decodeOldPalette(r, ctx, type));
        owner.fn = null;
        break;
      case 0x2018: {
        const tags = decodeTags(r);
        const base = ctx.tags.length;
        ctx.tags.push(...tags);
        chunks.push({ kind: 'tags', tags });
        let next = 0;
        owner.fn = (ud) => {
          const tag = tags[next];
          if (tag === undefined) return null;
          tag.userData = ud;
          return { kind: 'tag', tagIndex: base + next++ };
        };
        break;
      }
      case 0x2022: {
        const slice = decodeSlice(r);
        const sliceIndex = ctx.slices.length;
        ctx.slices.push(slice);
        chunks.push({ kind: 'slice', slice });
        single(
          (ud) => {
            slice.userData = ud;
          },
          { kind: 'slice', sliceIndex },
        );
        break;
      }
      case 0x2020: {
        const data = decodeUserData(r);
        let target: AseUserDataTarget | null = null;
        if (pendingFirstFramePalette) {
          ctx.spriteUserData = data;
          target = { kind: 'sprite' };
        } else if (owner.fn !== null) {
          target = owner.fn(data);
        }
        pendingFirstFramePalette = false;
        chunks.push({ kind: 'userData', data, target });
        break;
      }
      default: {
        const skipped = SKIPPED[type];
        chunks.push(
          skipped === undefined
            ? { kind: 'unknown', chunkType: type, size }
            : { kind: 'skipped', chunkType: type, name: skipped.name, note: skipped.note, size },
        );
        owner.fn = null;
      }
    }
  }
  const palette = ctx.paletteVersion !== versionBefore ? snapshot(ctx) : prev;
  const frame: AseFrame = {
    index,
    durationMs: duration > 0 ? duration : ctx.header.speedMs,
    chunks,
    cels,
    palette,
  };
  return { frame, end };
}

/** Cross-reference checks that need the whole file. */
function validate(
  header: AseHeader,
  layers: readonly AseLayer[],
  tags: readonly AseTag[],
  frames: readonly AseFrame[],
): void {
  for (const tag of tags) {
    if (tag.from > tag.to || tag.to >= header.frameCount) {
      throw new AseError(
        'BAD_CHUNK',
        `tag "${tag.name}" range ${String(tag.from)}..${String(tag.to)} outside ${String(header.frameCount)} frames`,
      );
    }
  }
  const have = frames.map((f) => new Set(f.cels.map((c) => c.layerIndex)));
  for (const frame of frames) {
    for (const cel of frame.cels) {
      if (cel.layerIndex >= layers.length) {
        throw new AseError(
          'BAD_CHUNK',
          `cel in frame ${String(frame.index)} uses missing layer ${String(cel.layerIndex)}`,
        );
      }
      if (cel.content.type === 'linked') {
        const target = cel.content.framePosition;
        if (
          target === frame.index ||
          target >= frames.length ||
          !have[target]?.has(cel.layerIndex)
        ) {
          throw new AseError(
            'BAD_CHUNK',
            `linked cel (frame ${String(frame.index)}, layer ${String(cel.layerIndex)}) points at missing frame ${String(target)}`,
          );
        }
      }
    }
  }
}

/**
 * Parse a `.aseprite` / `.ase` file.
 *
 * Pure: reads only `bytes` (little-endian), uses fflate for zlib. Every failure is an
 * {@link AseError}; no input can make it read out of bounds or allocate more than the documented
 * limits ({@link ASE_MAX_DIMENSION}, {@link ASE_MAX_FRAMES}, {@link ASE_MAX_DECODED_BYTES}).
 * Unknown chunks are skipped by size. Parsing is driven by the header's frame count and each
 * frame's own size, not by the header's file-size field.
 *
 * User data (0x2020) is attached to the object of the chunk before it: layer, cel (a cel-extra
 * chunk in between does not change that), slice; after a tags chunk the next user-data chunks
 * go to the tags in order; the one after the first-frame palette is the sprite's.
 *
 * Implemented from the published Aseprite file-format specification only.
 *
 * @param bytes - the whole file
 * @returns the parsed file
 * @throws AseError on any malformed or oversized input
 */
export function parseAseprite(bytes: Uint8Array): AseFile {
  const header = parseHeader(bytes);
  const ctx: Ctx = {
    header,
    layers: [],
    lastAtLevel: [],
    tags: [],
    slices: [],
    colorProfile: null,
    decodedBytes: 0,
    newPalette: null,
    oldPalette: null,
    paletteVersion: 0,
    spriteUserData: undefined,
  };
  const frames: AseFrame[] = [];
  let pos = HEADER_SIZE;
  let palette: AsePalette | null = null;
  for (let i = 0; i < header.frameCount; i++) {
    const { frame, end } = parseFrame(bytes, pos, i, ctx, palette);
    frames.push(frame);
    palette = frame.palette;
    pos = end;
  }
  validate(header, ctx.layers, ctx.tags, frames);
  const file: AseFile = {
    header,
    frames,
    layers: ctx.layers,
    tags: ctx.tags,
    slices: ctx.slices,
    palette,
    colorProfile: ctx.colorProfile,
  };
  if (ctx.spriteUserData !== undefined) file.userData = ctx.spriteUserData;
  return file;
}
