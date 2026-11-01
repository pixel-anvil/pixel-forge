/**
 * `OpContext`: what a handler receives (spec 6.3: "the transaction, read-model, renderer, logger
 * and ports"). Handlers do no direct I/O and never begin, commit or cancel a transaction.
 * @packageDocumentation
 */
import { renderFrame } from '@pixel-forge/core';
import type { DocumentView, RenderOptions, RigRenderer, Transaction } from '@pixel-forge/core';
import type { Safety } from './safety.js';
import { commitChange } from './commit.js';
import { OpError } from './errors.js';
import type { HostedDocument, OpHost } from './host.js';
import type { AnimRef, FrameRef, ReadonlyDocument } from './refs.js';

/** A logger port. Messages go to the transport's trace (`pf mcp --trace`), never to stdout. */
export interface OpLogger {
  debug(message: string, data?: Readonly<Record<string, unknown>>): void;
  info(message: string, data?: Readonly<Record<string, unknown>>): void;
  warn(message: string, data?: Readonly<Record<string, unknown>>): void;
}

/** A logger that drops everything. */
export const silentLogger: OpLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

/** The rendered frame type (`renderFrame`'s RGBA `TiledImage`). */
export type RenderedFrame = ReturnType<typeof renderFrame>;

/** The handler's view of the world. */
export interface OpContext {
  /** The op being run (`rig.setPose`). */
  readonly op: string;
  /** Its safety class. */
  readonly safety: Safety;
  /** The host: open documents and the `fs` / `clock` ports. */
  readonly host: OpHost;
  /** The host's rig renderer; pass it to `renderFrame` (or use {@link OpContext.renderFrame}). */
  readonly renderer: RigRenderer;
  /** Trace logger. */
  readonly log: OpLogger;
  /** True when the op's input named a document (`doc` field). */
  readonly hasDocument: boolean;
  /**
   * The document named by the `doc` input field.
   * @throws OpError `INTERNAL` for an op without a `doc` field.
   */
  readonly document: HostedDocument;
  /**
   * The read model: the open transaction (it sees the op's own edits so far), else the live store.
   * @throws OpError `INTERNAL` for an op without a `doc` field.
   */
  readonly view: DocumentView;
  /** Shortcut for `view.doc`. */
  readonly doc: ReadonlyDocument;
  /**
   * The op's transaction: `mutate`/`destructive` ops (with `transaction` left on), and `io` ops
   * inside {@link OpContext.transact}.
   * @throws OpError `INTERNAL` anywhere else.
   */
  readonly tx: Transaction;
  /**
   * `io` ops only: runs `fn` in the op's single transaction on {@link OpContext.document} and
   * commits it (one undo step, labelled like a mutate op). At most once per call; `fn` must be
   * synchronous. If `fn` throws, nothing is recorded and the error propagates.
   * @throws OpError `INTERNAL` when not an `io` op, without a document, or called twice.
   */
  transact<T>(fn: (tx: Transaction) => T): T;
  /** `renderFrame(ctx.view, animation, frame, {...options, rig: ctx.renderer})`. */
  renderFrame(
    animation: AnimRef,
    frame: FrameRef,
    options?: Omit<RenderOptions, 'rig'>,
  ): RenderedFrame;
}

/** Internal state the registry needs back from a context. */
export interface ContextInit {
  readonly op: string;
  readonly safety: Safety;
  readonly host: OpHost;
  readonly log: OpLogger;
  readonly document: HostedDocument | undefined;
  readonly label: string;
  /** Run the validate guard before `ctx.transact` commits. */
  readonly guard: boolean;
}

const misuse = (message: string): OpError => new OpError('INTERNAL', message);

/** The registry's implementation of {@link OpContext}. Not exported from the package. */
export class RunContext implements OpContext {
  readonly op: string;
  readonly safety: Safety;
  readonly host: OpHost;
  readonly log: OpLogger;
  readonly label: string;
  /** The open transaction, set by the registry or by {@link RunContext.transact}. */
  current: Transaction | undefined;
  /** Whether {@link RunContext.transact} ran. */
  transacted = false;
  /** The change committed by {@link RunContext.transact}, if any. */
  committedEntry: number | undefined;
  /** Change listeners that threw after `ctx.transact` committed (see `CommitOutcome.warnings`). */
  readonly warnings: string[] = [];
  private readonly hosted: HostedDocument | undefined;
  private readonly guard: boolean;

  constructor(init: ContextInit) {
    this.guard = init.guard;
    this.op = init.op;
    this.safety = init.safety;
    this.host = init.host;
    this.log = init.log;
    this.hosted = init.document;
    this.label = init.label;
  }

  get renderer(): RigRenderer {
    return this.host.renderer;
  }

  get hasDocument(): boolean {
    return this.hosted !== undefined;
  }

  get document(): HostedDocument {
    if (this.hosted === undefined) {
      throw misuse(`${this.op} has no "doc" input field, so ctx.document is unavailable`);
    }
    return this.hosted;
  }

  get view(): DocumentView {
    return this.current ?? this.document.store;
  }

  get doc(): ReadonlyDocument {
    return this.view.doc;
  }

  get tx(): Transaction {
    if (this.current === undefined) {
      throw misuse(
        `${this.op}: ctx.tx exists only in mutate/destructive ops (or inside ctx.transact in io ops)`,
      );
    }
    return this.current;
  }

  transact<T>(fn: (tx: Transaction) => T): T {
    if (this.safety !== 'io') {
      throw misuse(`${this.op}: ctx.transact is for io ops; ${this.safety} ops use ctx.tx`);
    }
    if (this.transacted) throw misuse(`${this.op}: ctx.transact may run once per call`);
    this.transacted = true;
    const tx = this.document.store.begin(this.label);
    this.current = tx;
    try {
      const result = fn(tx);
      if (isThenable(result)) {
        swallowRejection(result);
        throw misuse(`${this.op}: the ctx.transact callback must be synchronous`);
      }
      const outcome = commitChange(this.op, this.document.store, tx, this.guard, this.log);
      this.committedEntry = outcome.entryId;
      this.warnings.push(...outcome.warnings);
      return result;
    } finally {
      if (tx.isOpen) tx.cancel();
      this.current = undefined;
    }
  }

  renderFrame(
    animation: AnimRef,
    frame: FrameRef,
    options: Omit<RenderOptions, 'rig'> = {},
  ): RenderedFrame {
    return renderFrame(this.view, animation, frame, { ...options, rig: this.renderer });
  }
}

/**
 * Marks a promise-like we are about to discard as handled, so a handler that wrongly returned a
 * rejecting promise cannot raise an `unhandledRejection` after we threw `INTERNAL` for it.
 */
export function swallowRejection(value: PromiseLike<unknown>): void {
  value.then(undefined, () => undefined);
}

/** True for a promise-like value (a handler that should have been synchronous). */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
