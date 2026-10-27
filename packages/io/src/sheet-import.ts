/**
 * Spritesheet import (FR-DOC-05): cut a grid sheet into cels, map `[row, col]` cell lists to
 * animations, optionally import a matching outline sheet as a second layer.
 *
 * All functions here are pure byte-in/byte-out: PNG bytes in, document edits out. File access is
 * the caller's business (the `FileSystem` port lives with the `.pxf` code).
 * @packageDocumentation
 */
import { DocumentStore } from '@pixel-forge/core';
import type { Transaction } from '@pixel-forge/core';
import { decodePng } from '@pixel-forge/png';
import { TiledImage } from '@pixel-forge/raster';
import type { RgbaImage } from '@pixel-forge/raster';
import { DirectionName, Name, SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type {
  AnimationId,
  Cel,
  Document,
  FrameId,
  LayerId,
  LoopMode,
  PixelLayer,
} from '@pixel-forge/schema';
import { IoError } from './errors.js';

/** Default frame duration when an animation gives neither `durationMs` nor `fps`. */
export const DEFAULT_FRAME_MS = 100;

/** One animation cut from the sheet. */
export interface SheetAnimationSpec {
  /** Animation group, a schema `Name` (e.g. `run`). */
  group: string;
  /** Direction, a schema `DirectionName`; missing means undirected. */
  direction?: string;
  /** Cells in playback order, each `[row, col]` (0-based, row 0 on top). */
  frames: readonly (readonly [number, number])[];
  /** Duration of every frame in ms (integer >= 1). */
  durationMs?: number;
  /** Frames per second; `durationMs = round(1000 / fps)`. `durationMs` wins if both are given. */
  fps?: number;
  /** Loop mode; default `loop`. */
  loop?: LoopMode;
}

/** Input of {@link importSpritesheetTx}. */
export interface SheetImportInput {
  /** The sheet, PNG bytes. */
  png: Uint8Array;
  /** Cell size `[w, h]` in pixels. The sheet must hold at least the cells that are referenced. */
  cell: readonly [number, number];
  animations: readonly SheetAnimationSpec[];
  /** Matching outline sheet (same pixel size as `png`), imported as a separate layer above. */
  outlinePng?: Uint8Array;
  /** Name of the main layer (reused when a top-level pixel layer of that name exists). Default `body`. */
  layerName?: string;
  /** Name of the outline layer. Default `outline`. */
  outlineLayerName?: string;
  /** Duration used when an animation has neither `durationMs` nor `fps`. Default 100. */
  defaultDurationMs?: number;
}

/** What {@link importSpritesheetTx} created. */
export interface SheetImportResult {
  /** The created animations, in input order. */
  animations: AnimationId[];
  /** The main layer. */
  layer: LayerId;
  /** The outline layer, when an outline sheet was given. */
  outlineLayer?: LayerId;
  /** Number of frames created. */
  frames: number;
  /** Number of cels that own pixels (empty cells and repeated cells create none; repeats link). */
  imageCels: number;
}

/**
 * Where the cell sits on the canvas: the cell's bottom-centre pixel `(floor(w / 2), h - 1)` lands on
 * the document `origin`. With a canvas equal to the cell and the default origin the offset is `(0, 0)`.
 */
export function cellOffset(
  cell: readonly [number, number],
  origin: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  return { x: origin.x - Math.floor(cell[0] / 2), y: origin.y - (cell[1] - 1) };
}

/** The default document origin for a canvas of the cell size: bottom-centre of the cell. */
export function defaultOrigin(cell: readonly [number, number]): { x: number; y: number } {
  return { x: Math.floor(cell[0] / 2), y: cell[1] - 1 };
}

function positiveInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new IoError('BAD_INPUT', `${what} must be an integer >= 1, got ${String(v)}`);
  }
  return v;
}

function durationOf(spec: SheetAnimationSpec, fallback: number): number {
  if (spec.durationMs !== undefined) return positiveInt(spec.durationMs, 'durationMs');
  if (spec.fps !== undefined) {
    if (typeof spec.fps !== 'number' || !Number.isFinite(spec.fps) || spec.fps <= 0) {
      throw new IoError('BAD_INPUT', `fps must be > 0, got ${String(spec.fps)}`);
    }
    return Math.max(1, Math.round(1000 / spec.fps));
  }
  return fallback;
}

function cropCell(
  sheet: RgbaImage,
  row: number,
  col: number,
  cw: number,
  ch: number,
): TiledImage | undefined {
  const out = new Uint8Array(cw * ch * 4);
  let any = false;
  for (let y = 0; y < ch; y++) {
    const from = ((row * ch + y) * sheet.width + col * cw) * 4;
    const rowBytes = sheet.data.subarray(from, from + cw * 4);
    out.set(rowBytes, y * cw * 4);
    if (!any) {
      for (let x = 3; x < rowBytes.length; x += 4) {
        if (rowBytes[x] !== 0) {
          any = true;
          break;
        }
      }
    }
  }
  return any ? TiledImage.fromRGBA({ width: cw, height: ch, data: out }) : undefined;
}

function checkName(value: string, what: string, schema: typeof Name): void {
  if (!schema.safeParse(value).success) {
    throw new IoError('BAD_INPUT', `${what} "${value}" is not a valid name`);
  }
}

interface Plan {
  layerName: string;
  sheet: RgbaImage;
  outline: RgbaImage | undefined;
  outlineName: string;
}

/**
 * Imports a grid spritesheet inside an open transaction: one frame per listed cell, one animation per
 * spec, one pixel cel per non-empty cell. A cell that is fully transparent creates a frame without a
 * cel. A cell that repeats an earlier cell of the same sheet becomes a link to that earlier cel
 * (`linkTo`), so repeated cells share one image. With `outlinePng` a second pixel layer (above the
 * main one) gets the matching outline cels.
 *
 * Layers: a top-level pixel layer with the given name is reused (so several sheets, e.g. the CC0
 * one-file-per-animation layout, can be imported into one layer); otherwise it is created on top of
 * the layer stack. Cels are placed with {@link cellOffset} relative to the document origin.
 *
 * All arguments are validated before the document is touched; on `IoError` the transaction is
 * unchanged (the caller may still cancel it).
 *
 * @throws IoError `BAD_INPUT`, `CELL_OUT_OF_RANGE`, `SIZE_MISMATCH`, `DUPLICATE_ANIMATION`.
 */
export function importSpritesheetTx(tx: Transaction, input: SheetImportInput): SheetImportResult {
  const [cw, ch] = input.cell;
  positiveInt(cw, 'cell width');
  positiveInt(ch, 'cell height');
  if (input.animations.length === 0) {
    throw new IoError('BAD_INPUT', 'at least one animation is required');
  }
  const fallbackMs = positiveInt(input.defaultDurationMs ?? DEFAULT_FRAME_MS, 'defaultDurationMs');
  const sheet = decodePng(input.png);
  const outline = input.outlinePng ? decodePng(input.outlinePng) : undefined;
  if (outline && (outline.width !== sheet.width || outline.height !== sheet.height)) {
    throw new IoError(
      'SIZE_MISMATCH',
      `outline sheet is ${String(outline.width)}x${String(outline.height)}, sheet is ${String(sheet.width)}x${String(sheet.height)}`,
    );
  }
  const plan: Plan = {
    layerName: input.layerName ?? 'body',
    outlineName: input.outlineLayerName ?? 'outline',
    sheet,
    outline,
  };
  checkName(plan.layerName, 'layer name', Name);
  if (outline) checkName(plan.outlineName, 'outline layer name', Name);
  const cols = Math.floor(sheet.width / cw);
  const rows = Math.floor(sheet.height / ch);

  const seen = new Set<string>();
  const durations: number[] = [];
  for (const spec of input.animations) {
    checkName(spec.group, 'group', Name);
    if (spec.direction !== undefined) checkName(spec.direction, 'direction', DirectionName);
    const key = `${spec.group}\u0000${spec.direction ?? ''}`;
    const exists = tx.doc.animations.some(
      (a) => a.group === spec.group && a.direction === spec.direction,
    );
    if (seen.has(key) || exists) {
      throw new IoError(
        'DUPLICATE_ANIMATION',
        `animation ${spec.group}${spec.direction ? '/' + spec.direction : ''} already exists`,
      );
    }
    seen.add(key);
    if (spec.frames.length === 0) {
      throw new IoError('BAD_INPUT', `animation ${spec.group} has no frames`);
    }
    for (const [r, c] of spec.frames) {
      if (
        !Number.isInteger(r) ||
        !Number.isInteger(c) ||
        r < 0 ||
        c < 0 ||
        r >= rows ||
        c >= cols
      ) {
        throw new IoError(
          'CELL_OUT_OF_RANGE',
          `cell [${String(r)}, ${String(c)}] of ${spec.group} is outside the ${String(rows)} x ${String(cols)} grid`,
        );
      }
    }
    durations.push(durationOf(spec, fallbackMs));
  }

  const offset = cellOffset([cw, ch], tx.doc.meta.origin);
  const mainLayer = findOrPlan(tx, plan.layerName);
  const outlineLayer = outline ? findOrPlan(tx, plan.outlineName) : undefined;

  const celsMain = new Map<FrameId, Cel>();
  const celsOutline = new Map<FrameId, Cel>();
  const firstUse = new Map<string, FrameId>(); // "layer:row:col" -> frame holding the image cel
  let imageCels = 0;
  let frameCount = 0;

  const place = (
    which: 'main' | 'outline',
    img: RgbaImage,
    row: number,
    col: number,
    frameId: FrameId,
    into: Map<FrameId, Cel>,
  ): void => {
    const key = `${which}:${String(row)}:${String(col)}`;
    const earlier = firstUse.get(key);
    if (earlier !== undefined) {
      into.set(frameId, { linkTo: earlier });
      return;
    }
    const cell = cropCell(img, row, col, cw, ch);
    if (!cell) return;
    firstUse.set(key, frameId);
    imageCels += 1;
    into.set(frameId, { imageId: tx.createImage(cell), offset: { ...offset }, opacity: 255 });
  };

  const animSpecs = input.animations.map((spec, i) => {
    const id = tx.newId('animation');
    const frames = spec.frames.map(([row, col]) => {
      const frameId = tx.newId('frame');
      frameCount += 1;
      place('main', sheet, row, col, frameId, celsMain);
      if (outline) place('outline', outline, row, col, frameId, celsOutline);
      return { frameId, durationMs: durations[i] ?? fallbackMs };
    });
    return { id, spec, frames };
  });

  tx.update((d) => {
    const ensure = (
      target: { id: LayerId; name: string; isNew: boolean },
      cels: Map<FrameId, Cel>,
    ): void => {
      let layer = d.layers.find((l) => l.kind === 'pixel' && l.name === target.name) as
        PixelLayer | undefined;
      if (!layer) {
        layer = {
          kind: 'pixel',
          id: target.id,
          name: target.name,
          visible: true,
          opacity: 255,
          export: true,
          cels: {},
        };
        d.layers.push(layer);
        layer = d.layers[d.layers.length - 1] as PixelLayer;
      }
      for (const [fid, cel] of cels) layer.cels[fid] = cel;
    };
    ensure(mainLayer, celsMain);
    if (outlineLayer) ensure(outlineLayer, celsOutline);
    for (const { id, spec, frames } of animSpecs) {
      d.animations.push({
        id,
        group: spec.group,
        ...(spec.direction !== undefined ? { direction: spec.direction } : {}),
        loop: spec.loop ?? 'loop',
        frames: frames.map((f) => ({
          id: f.frameId,
          durationMs: f.durationMs,
          markers: {},
          events: [],
          rootMotion: { dx: 0, dy: 0 },
          boneKeys: {},
          partKeys: {},
        })),
        overrides: [],
      });
    }
  });

  return {
    animations: animSpecs.map((a) => a.id),
    layer: mainLayer.id,
    ...(outlineLayer ? { outlineLayer: outlineLayer.id } : {}),
    frames: frameCount,
    imageCels,
  };
}

function findOrPlan(tx: Transaction, name: string): { id: LayerId; name: string; isNew: boolean } {
  const existing = tx.doc.layers.find((l) => l.kind === 'pixel' && l.name === name);
  if (existing) return { id: existing.id, name, isNew: false };
  return { id: tx.newId('layer'), name, isNew: true };
}

/** Options of {@link createDocumentFromSpritesheet}. */
export interface CreateFromSheetOptions {
  /** Display name of the document. Default `spritesheet`. */
  name?: string;
  /** Origin pixel on the canvas. Default {@link defaultOrigin}: bottom-centre of the cell. */
  origin?: { x: number; y: number };
  /** Pixels per engine unit. Default 16. */
  pixelsPerUnit?: number;
  /** Id generator seed (ids are deterministic for a seed). Default 1. */
  idSeed?: number;
}

/**
 * Builds a fresh valid RGBA document whose canvas is the cell size and imports the sheet into it
 * (one undoable transaction "Import spritesheet"). Returns the store and the import summary.
 */
export function createDocumentFromSpritesheet(
  input: SheetImportInput,
  options: CreateFromSheetOptions = {},
): { store: DocumentStore; result: SheetImportResult } {
  const [cw, ch] = input.cell;
  positiveInt(cw, 'cell width');
  positiveInt(ch, 'cell height');
  const gen = createIdGenerator({ seed: options.idSeed ?? 1, next: 0 });
  const doc: Document = {
    meta: {
      id: gen.next('doc'),
      name: options.name ?? 'spritesheet',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w: cw, h: ch },
      origin: options.origin ?? defaultOrigin([cw, ch]),
      pixelsPerUnit: options.pixelsPerUnit ?? 16,
      colorMode: 'rgba',
      paletteLocked: false,
      ids: gen.state(),
    },
    palettes: [],
    skins: [],
    layers: [],
    animations: [],
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
  };
  const store = new DocumentStore(doc);
  const tx = store.begin('Import spritesheet');
  try {
    const result = importSpritesheetTx(tx, input);
    tx.commit();
    return { store, result };
  } catch (e) {
    tx.cancel();
    throw e;
  }
}

/**
 * The CC0 `sheet.json` format used by `fixtures/cc0` (`{cell, animations: {name: {file, frames:
 * [[row, col], ...]}}}`): one PNG per animation, cells in playback order. Converts it into one
 * {@link SheetImportInput} per animation (the animation name becomes the group, undirected). Import them
 * in order into the same document; they share the layer `layerName`.
 *
 * @param json parsed `sheet.json`
 * @param readPng returns the bytes of a file named in the JSON
 * @throws IoError `BAD_INPUT` for a malformed JSON.
 */
export function cc0SheetInputs(
  json: unknown,
  readPng: (file: string) => Uint8Array,
  options: { durationMs?: number; fps?: number; layerName?: string; loop?: LoopMode } = {},
): SheetImportInput[] {
  const bad = (m: string): IoError => new IoError('BAD_INPUT', `sheet.json: ${m}`);
  if (typeof json !== 'object' || json === null) throw bad('not an object');
  const o = json as { cell?: unknown; animations?: unknown };
  const cell = o.cell;
  if (
    !Array.isArray(cell) ||
    cell.length !== 2 ||
    !cell.every((n) => typeof n === 'number' && Number.isInteger(n) && n > 0)
  ) {
    throw bad('"cell" must be [w, h]');
  }
  const cellTuple: [number, number] = [cell[0] as number, cell[1] as number];
  if (typeof o.animations !== 'object' || o.animations === null) throw bad('"animations" missing');
  const out: SheetImportInput[] = [];
  for (const [group, value] of Object.entries(o.animations)) {
    const a = value as { file?: unknown; frames?: unknown };
    if (typeof a.file !== 'string') throw bad(`${group}: "file" must be a string`);
    if (!Array.isArray(a.frames)) throw bad(`${group}: "frames" must be an array`);
    const frames = (a.frames as unknown[]).map((f): [number, number] => {
      if (!Array.isArray(f) || f.length !== 2 || f.some((n) => typeof n !== 'number')) {
        throw bad(`${group}: frame must be [row, col]`);
      }
      return [f[0] as number, f[1] as number];
    });
    out.push({
      png: readPng(a.file),
      cell: cellTuple,
      ...(options.layerName !== undefined ? { layerName: options.layerName } : {}),
      animations: [
        {
          group,
          frames,
          ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
          ...(options.fps !== undefined ? { fps: options.fps } : {}),
          ...(options.loop !== undefined ? { loop: options.loop } : {}),
        },
      ],
    });
  }
  return out;
}
