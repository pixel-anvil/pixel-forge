/**
 * The one commit sequence every transactional path shares (`mutate`/`destructive` ops in the
 * registry, `ctx.transact` in `io` ops): the validate guard, then `tx.commit()`, then the
 * handling of a change listener that throws after the change is already applied.
 * @packageDocumentation
 */
import { validate } from '@pixel-forge/core';
import type { ChangeEvent, DocumentStore, Transaction, ValidateOptions } from '@pixel-forge/core';
import type { ImageId } from '@pixel-forge/schema';
import { OpError } from './errors.js';

/** What a commit produced. */
export interface CommitOutcome {
  /** The history entry recorded, or `undefined` when the change was a no-op. */
  readonly entryId: number | undefined;
  /**
   * Change listeners that threw. The change **is** committed (core delivers events after applying
   * the change), so this is a warning, never a failure of the op.
   */
  readonly warnings: readonly string[];
}

/** The part of the op logger the commit uses (structural, so this module does not import `context`). */
interface WarnLog {
  warn(message: string, data?: Readonly<Record<string, unknown>>): void;
}

type Counts = ReadonlyMap<string, number>;

/**
 * `validate()` error counts (per code) of a store's committed state with the image content checks
 * off, valid for one store version. Keyed on the store and its version, so undo, redo and
 * pixel-only commits never see counts from another state.
 */
const COMMITTED = new WeakMap<
  DocumentStore,
  { readonly version: number; readonly counts: Counts }
>();

function countErrors(findings: ReturnType<typeof validate>): Counts {
  const counts = new Map<string, number>();
  for (const f of findings) {
    if (f.severity === 'error') counts.set(f.code, (counts.get(f.code) ?? 0) + 1);
  }
  return counts;
}

/**
 * The images whose pixels need the content checks after `tx`: those that differ from the committed
 * ones. `undefined` means all of them (the palette or colour mode changed, which affects every
 * image).
 */
function changedImages(store: DocumentStore, tx: Transaction): Set<ImageId> | undefined {
  const a = store.doc;
  const b = tx.doc;
  if (
    a.palettes !== b.palettes ||
    a.activePaletteId !== b.activePaletteId ||
    a.meta.colorMode !== b.meta.colorMode ||
    a.meta.paletteLocked !== b.meta.paletteLocked
  ) {
    return undefined;
  }
  const changed = new Set<ImageId>();
  for (const id of tx.imageIds()) if (tx.image(id) !== store.image(id)) changed.add(id);
  return changed;
}

/**
 * Refuses a transaction that adds `validate()` errors (per code) over the committed state.
 * Returns the transaction's error counts when they equal what `validate()` would report for the
 * committed result without image content checks (so the next call can start from them), else
 * `undefined`. Nothing is cached for a rejected state.
 */
function checkValid(op: string, store: DocumentStore, tx: Transaction): Counts | undefined {
  const changed = changedImages(store, tx);
  if (changed?.size === 0 && tx.doc === store.doc) return undefined; // nothing to validate
  const docOnly = changed?.size === 0; // no pixel scan at all, on either side
  const options: ValidateOptions = docOnly
    ? { images: false }
    : changed === undefined
      ? {}
      : { images: changed };
  let before: Counts;
  const cached = COMMITTED.get(store);
  if (docOnly && cached?.version === store.version) {
    before = cached.counts;
  } else {
    before = countErrors(validate(store, options));
    if (docOnly) COMMITTED.set(store, { version: store.version, counts: before });
  }
  const findings = validate(tx, options).filter((f) => f.severity === 'error');
  const after = countErrors(findings);
  const added = [...after].filter(([code, n]) => n > (before.get(code) ?? 0)).map(([c]) => c);
  if (added.length > 0) {
    throw new OpError(
      'INTERNAL',
      `${op} would leave the document invalid (${added.join(', ')}); nothing was changed`,
      {
        reason: 'invalid-document',
        findings: findings
          .filter((f) => added.includes(f.code))
          .slice(0, 10)
          .map((f) => ({ code: f.code, path: f.path.join('.'), message: f.message })),
      },
    );
  }
  return docOnly ? after : undefined;
}

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Commits `tx`: the validate guard (when `guard`), then `tx.commit()`.
 *
 * A change listener that throws does not undo the change (core applies it first), so that is
 * returned as a {@link CommitOutcome.warnings} entry and logged, not thrown. Any other failure of
 * the guard or the commit throws and leaves the transaction open for the caller to cancel.
 * @throws OpError `INTERNAL` (`invalid-document`) from the guard; a `CoreError` from the commit.
 */
export function commitChange(
  op: string,
  store: DocumentStore,
  tx: Transaction,
  guard: boolean,
  log: WarnLog,
): CommitOutcome {
  const primed = guard ? checkValid(op, store, tx) : undefined;
  const versionBefore = store.version;
  // Subscribed last, so it runs after (and despite) any listener that throws.
  const seen: { event?: ChangeEvent } = {};
  const off = store.subscribe((event) => {
    seen.event = event;
  });
  let event: ChangeEvent | undefined;
  const warnings: string[] = [];
  try {
    event = tx.commit();
  } catch (e) {
    if (seen.event === undefined || store.version === versionBefore) throw e;
    event = seen.event;
    const errors = e instanceof AggregateError ? (e.errors as unknown[]) : [e];
    for (const err of errors) {
      const message = `a change listener threw after ${op} was committed: ${describeError(err)}`;
      warnings.push(message);
      log.warn(message, { op });
    }
  } finally {
    off();
  }
  if (primed !== undefined && store.version !== versionBefore) {
    COMMITTED.set(store, { version: store.version, counts: primed });
  }
  return { entryId: event?.entryId, warnings };
}
