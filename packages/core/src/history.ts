/**
 * Patches, history entries and the linear undo/redo stack with memory accounting.
 * @packageDocumentation
 */
import { CoreError } from './errors.js';
import { isSealed } from './json.js';
import type { JsonArray, JsonObject, JsonValue } from './json.js';
import { tileBuffers } from './images.js';
import type { ImagePatch } from './images.js';
import { invertOps } from './patch.js';
import type { StructuralOp } from './patch.js';

/** Everything one transaction changed: structural operations, then image changes (sorted by id). */
export interface Patch {
  /** Structural operations, applied in order to the document JSON. */
  readonly ops: readonly StructuralOp[];
  /** Image changes; at most one per image id, sorted by id. Independent of `ops`. */
  readonly images: readonly ImagePatch[];
}

/** The patch that undoes `patch`: inverted operations in reverse order, create/delete swapped, tiles swapped. */
export function invertPatch(patch: Patch): Patch {
  return {
    ops: invertOps(patch.ops),
    images: patch.images.map((p): ImagePatch => {
      switch (p.kind) {
        case 'create':
          return { kind: 'delete', id: p.id, image: p.image };
        case 'delete':
          return { kind: 'create', id: p.id, image: p.image };
        case 'tiles':
          return { kind: 'tiles', id: p.id, before: p.after, after: p.before };
      }
    }),
  };
}

/** One labelled, committed transaction in the history. */
export interface HistoryEntry {
  /** Sequence number, unique per store (1, 2, 3...), never reused. */
  readonly id: number;
  /** The transaction label, e.g. `Draw` or `AI: rig.setPose` (FR-AI-14). */
  readonly label: string;
  /** The forward patch (what the commit did); undo applies {@link invertPatch} of it. */
  readonly patch: Patch;
  /** Bytes of the distinct tile buffers this entry references (shared buffers count here and elsewhere). */
  readonly tileBytes: number;
  /** Estimated bytes of the structural part (see {@link estimatePatchBytes}). */
  readonly structBytes: number;
}

/** A history entry as listed for a UI: `applied` entries can be undone, the others redone. */
export interface HistoryEntryInfo {
  readonly id: number;
  readonly label: string;
  /** True for entries on the undo side (applied to the current document). */
  readonly applied: boolean;
  readonly tileBytes: number;
  readonly structBytes: number;
}

/** History summary: entries oldest first (applied ones, then the redo side), and memory use. */
export interface HistoryInfo {
  /** Oldest first: `applied` entries (undo side), then the undone ones (redo side, next redo first). */
  readonly entries: readonly HistoryEntryInfo[];
  /** Number of applied entries (`entries.slice(0, applied)` are on the undo side). */
  readonly applied: number;
  /** Bytes of the distinct tile buffers referenced by any entry (exact; each buffer counted once). */
  readonly tileBytes: number;
  /** Sum of the structural estimates of all entries. */
  readonly structBytes: number;
  /** `tileBytes + structBytes`, compared with `cap`. */
  readonly bytes: number;
  /** Memory cap in bytes (FR-DOC-02; default {@link DEFAULT_MEMORY_CAP}). */
  readonly cap: number;
}

/** Default history memory cap: 512 MiB (FR-DOC-02). */
export const DEFAULT_MEMORY_CAP = 512 * 1024 * 1024;

/** Estimated fixed cost of one structural operation (op object and path array). */
export const OP_OVERHEAD_BYTES = 64;
/** Estimated fixed cost of one image patch, plus {@link SNAPSHOT_OVERHEAD_BYTES} per tile snapshot. */
export const IMAGE_PATCH_OVERHEAD_BYTES = 64;
/** Estimated fixed cost of one tile snapshot record (excluding its pixel buffer). */
export const SNAPSHOT_OVERHEAD_BYTES = 32;

const SIZE_MEMO = new WeakMap<object, number>();

/**
 * Estimated heap bytes of a JSON value: 8 per number, boolean or null; 16 + 2 per UTF-16 unit for a
 * string; 16 + 8 per element for an array; 16 + (16 + 2 per key unit) per key for an object; children
 * added. Shared sub-trees are counted in full, so this is an upper bound. Memoised per sealed node.
 */
export function estimateJsonBytes(v: JsonValue): number {
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return 8;
  if (typeof v === 'string') return 16 + 2 * v.length;
  const memo = SIZE_MEMO.get(v);
  if (memo !== undefined) return memo;
  let n = 16;
  if (Array.isArray(v)) {
    for (const x of v as JsonArray) n += 8 + estimateJsonBytes(x);
  } else {
    const o = v as JsonObject;
    for (const k of Object.keys(o)) n += 16 + 2 * k.length + estimateJsonBytes(o[k] as JsonValue);
  }
  if (isSealed(v)) SIZE_MEMO.set(v, n);
  return n;
}

/**
 * The structural estimate of a patch: per operation {@link OP_OVERHEAD_BYTES} + 8 per path segment
 * (+ 2 per UTF-16 unit of string segments) + {@link estimateJsonBytes} of `before` and `after`; per
 * image patch {@link IMAGE_PATCH_OVERHEAD_BYTES} + {@link SNAPSHOT_OVERHEAD_BYTES} per tile snapshot.
 * Pixel buffers are not included: they are counted exactly as tile bytes.
 */
export function estimatePatchBytes(patch: Patch): number {
  let n = 0;
  for (const op of patch.ops) {
    n += OP_OVERHEAD_BYTES;
    for (const seg of op.path) n += 8 + (typeof seg === 'string' ? 2 * seg.length : 0);
    if (op.op !== 'add') n += estimateJsonBytes(op.before);
    if (op.op !== 'remove') n += estimateJsonBytes(op.after);
  }
  for (const p of patch.images) {
    n += IMAGE_PATCH_OVERHEAD_BYTES;
    if (p.kind === 'tiles') n += SNAPSHOT_OVERHEAD_BYTES * (p.before.length + p.after.length);
  }
  return n;
}

/** Distinct tile buffers referenced by a patch. */
function patchBuffers(patch: Patch): Uint8Array[] {
  const set = new Set<Uint8Array>();
  for (const p of patch.images) {
    if (p.kind === 'tiles') {
      for (const s of p.before) if (s.data !== undefined) set.add(s.data);
      for (const s of p.after) if (s.data !== undefined) set.add(s.data);
    } else {
      for (const b of tileBuffers(p.image)) set.add(b);
    }
  }
  return [...set];
}

interface Entry extends HistoryEntry {
  readonly buffers: readonly Uint8Array[];
}

/**
 * The linear history of one document. `done` holds applied entries (oldest first), `undone` the
 * redo stack (next redo last). Memory: distinct tile buffers are reference-counted across entries, so
 * a buffer that is the `after` of one entry and the `before` of the next counts once.
 */
export class History {
  private done: Entry[] = [];
  private undone: Entry[] = [];
  private readonly refs = new Map<Uint8Array, number>();
  private nextId = 1;
  private tileTotal = 0;
  private structTotal = 0;
  private capBytes: number;

  constructor(cap: number = DEFAULT_MEMORY_CAP) {
    this.capBytes = History.checkCap(cap);
  }

  private static checkCap(cap: number): number {
    if (typeof cap !== 'number' || Number.isNaN(cap) || cap < 0) {
      throw new CoreError('BAD_ARGUMENT', `memory cap must be a number >= 0, got ${String(cap)}`);
    }
    return cap;
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  get cap(): number {
    return this.capBytes;
  }

  get bytes(): number {
    return this.tileTotal + this.structTotal;
  }

  /** Records a committed patch: clears the redo side, pushes the entry, then evicts to the cap. */
  record(label: string, patch: Patch): HistoryEntry {
    for (const e of this.undone) this.release(e);
    this.undone = [];
    const buffers = patchBuffers(patch);
    let tileBytes = 0;
    for (const b of buffers) tileBytes += b.byteLength;
    const entry: Entry = {
      id: this.nextId++,
      label,
      patch,
      tileBytes,
      structBytes: estimatePatchBytes(patch),
      buffers,
    };
    this.retain(entry);
    this.done.push(entry);
    this.evict();
    return entry;
  }

  /** The entry `undo` would revert, without moving it. */
  peekUndo(): HistoryEntry | undefined {
    return this.done.at(-1);
  }

  /** The entry `redo` would re-apply, without moving it. */
  peekRedo(): HistoryEntry | undefined {
    return this.undone.at(-1);
  }

  /** Moves the top applied entry to the redo side (after the store applied its inverse). */
  markUndone(): void {
    const e = this.done.pop();
    if (e !== undefined) this.undone.push(e);
  }

  /** Moves the next redo entry back to the applied side (after the store re-applied it). */
  markRedone(): void {
    const e = this.undone.pop();
    if (e !== undefined) this.done.push(e);
  }

  /** Changes the cap and evicts at once if needed. */
  setCap(cap: number): void {
    this.capBytes = History.checkCap(cap);
    this.evict();
  }

  /** Drops every entry on both sides. */
  clear(): void {
    for (const e of this.done) this.release(e);
    for (const e of this.undone) this.release(e);
    this.done = [];
    this.undone = [];
  }

  info(): HistoryInfo {
    const row = (e: Entry, applied: boolean): HistoryEntryInfo => ({
      id: e.id,
      label: e.label,
      applied,
      tileBytes: e.tileBytes,
      structBytes: e.structBytes,
    });
    return {
      entries: [
        ...this.done.map((e) => row(e, true)),
        ...[...this.undone].reverse().map((e) => row(e, false)),
      ],
      applied: this.done.length,
      tileBytes: this.tileTotal,
      structBytes: this.structTotal,
      bytes: this.bytes,
      cap: this.capBytes,
    };
  }

  /**
   * Evicts while `bytes` exceeds the cap. The cap covers both sides, and the entry farthest from the
   * current position goes first: the oldest applied entry is `done.length` steps from the current
   * state (that many undos), the farthest undone entry `undone.length` steps (that many redos). The
   * farther end is evicted; on a tie the redo end, so the undo depth is the last thing to shrink.
   * Never evicts the newest applied entry (the one `undo` reverts), so a single entry larger than the
   * cap is kept. Stops when nothing else may be evicted.
   */
  private evict(): void {
    while (this.bytes > this.capBytes) {
      const canUndoEnd = this.done.length > 1;
      const canRedoEnd = this.undone.length > 0;
      if (!canUndoEnd && !canRedoEnd) return;
      const e =
        canRedoEnd && (!canUndoEnd || this.undone.length >= this.done.length)
          ? this.undone.shift()
          : this.done.shift();
      if (e !== undefined) this.release(e);
    }
  }

  private retain(e: Entry): void {
    for (const b of e.buffers) {
      const n = this.refs.get(b) ?? 0;
      if (n === 0) this.tileTotal += b.byteLength;
      this.refs.set(b, n + 1);
    }
    this.structTotal += e.structBytes;
  }

  private release(e: Entry): void {
    for (const b of e.buffers) {
      const n = this.refs.get(b) ?? 0;
      if (n <= 1) {
        this.refs.delete(b);
        this.tileTotal -= b.byteLength;
      } else {
        this.refs.set(b, n - 1);
      }
    }
    this.structTotal -= e.structBytes;
  }
}
