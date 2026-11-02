/**
 * Copy-on-write drafts: a mutable `Proxy` view over a sealed JSON tree. Reads are lazy (a child draft
 * is created only for a container that is read), writes copy only the nodes on the written paths,
 * and `finish()` returns a new sealed tree that shares every untouched node with the base.
 * @packageDocumentation
 */
import { CoreError } from './errors.js';
import { isContainer, isSealed, seal, sealNode } from './json.js';
import type { JsonArray, JsonContainer, JsonObject, JsonValue } from './json.js';

type Bag = Record<string, unknown>;

interface DraftState {
  readonly base: JsonContainer;
  readonly isArray: boolean;
  readonly parent: DraftState | undefined;
  /** Shallow working copy; values are sealed nodes, child drafts, primitives or raw caller values. */
  copy: Bag | undefined;
  /** Child drafts handed out before `copy` exists (reading must not copy the parent). */
  children: Map<string, object> | undefined;
  modified: boolean;
  finalizing: boolean;
  result: JsonValue | undefined;
}

/** A draft over one sealed tree. */
export interface DraftSession<T> {
  /** The mutable view. Valid until {@link finish} or {@link discard}; afterwards any use throws a `TypeError`. */
  readonly draft: T;
  /** Seals the edits into a new tree (sharing untouched nodes with the base) and revokes every draft. */
  finish(): JsonValue;
  /** Revokes every draft without producing a result. */
  discard(): void;
  /** The first error a draft trap threw (even if the recipe caught it), or `undefined`. */
  readonly error: CoreError | undefined;
  /** @internal Counters for tests: shallow copies made and child drafts created so far. */
  readonly stats: { readonly copies: number; readonly childDrafts: number };
}

const INDEX = /^(?:0|[1-9]\d*)$/;

function badValue(message: string): CoreError {
  return new CoreError('BAD_VALUE', message);
}

/** Opens a draft session over the sealed container `base`. */
export function openDraft<T>(base: JsonContainer): DraftSession<T> {
  let firstError: CoreError | undefined;
  /** Builds a trap error and remembers the first one, so a recipe cannot swallow it silently. */
  const bad = (message: string): CoreError => {
    const e = badValue(message);
    firstError ??= e;
    return e;
  };
  const stats = { copies: 0, childDrafts: 0 };
  const byTarget = new WeakMap<object, DraftState>();
  const byProxy = new WeakMap<object, DraftState>();
  const revokers: (() => void)[] = [];

  const stateOf = (target: object): DraftState => {
    const s = byTarget.get(target);
    if (s === undefined) throw badValue('not a draft');
    return s;
  };
  const source = (s: DraftState): Bag => s.copy ?? (s.base as unknown as Bag);
  const ensureCopy = (s: DraftState): Bag => {
    if (s.copy === undefined) {
      stats.copies++;
      s.copy = s.isArray
        ? ((s.base as JsonArray).slice() as unknown as Bag)
        : { ...(s.base as JsonObject) };
      if (s.children !== undefined) {
        for (const [k, child] of s.children) s.copy[k] = child;
        s.children = undefined;
      }
    }
    return s.copy;
  };
  const markModified = (s: DraftState): void => {
    for (let t: DraftState | undefined = s; t !== undefined && !t.modified; t = t.parent) {
      t.modified = true;
      ensureCopy(t);
    }
  };

  const handler: ProxyHandler<object> = {
    get(target, key) {
      const s = stateOf(target);
      const src = source(s);
      if (typeof key === 'symbol' || !Object.hasOwn(src, key))
        return Reflect.get(src, key) as unknown;
      const v = src[key];
      if (isContainer(v) && isSealed(v)) {
        if (s.copy === undefined) {
          // reading never copies the parent: park the child until a write needs the copy
          const known = s.children?.get(key);
          if (known !== undefined) return known;
          const child = create(v, s).proxy;
          (s.children ??= new Map()).set(key, child);
          return child;
        }
        const child = create(v, s).proxy;
        s.copy[key] = child;
        return child;
      }
      return v;
    },
    set(target, key, value) {
      const s = stateOf(target);
      if (typeof key === 'symbol') throw bad('symbol keys are not JSON');
      if (key === '__proto__') throw bad('reserved key "__proto__"');
      if (s.isArray && key !== 'length' && !INDEX.test(key)) {
        throw bad(`arrays take only indices and length, not "${key}"`);
      }
      if (value === undefined)
        throw bad(`undefined at "${key}" is not JSON (delete the key instead)`);
      const src = source(s);
      if (Object.hasOwn(src, key) && src[key] === value) return true;
      ensureCopy(s)[key] = value;
      markModified(s);
      return true;
    },
    deleteProperty(target, key) {
      const s = stateOf(target);
      if (typeof key === 'symbol' || !Object.hasOwn(source(s), key)) return true;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- deleting a JSON key is the edit
      delete ensureCopy(s)[key];
      markModified(s);
      return true;
    },
    has(target, key) {
      return Reflect.has(source(stateOf(target)), key);
    },
    ownKeys(target) {
      return Reflect.ownKeys(source(stateOf(target)));
    },
    getOwnPropertyDescriptor(target, key) {
      const s = stateOf(target);
      const src = source(s);
      const d = Reflect.getOwnPropertyDescriptor(src, key);
      if (d === undefined) return undefined;
      if (s.isArray && key === 'length') {
        return {
          value: (src as unknown as unknown[]).length,
          writable: true,
          enumerable: false,
          configurable: false,
        };
      }
      return {
        // no child draft here (enumeration only needs the key and `enumerable`): a sealed container is
        // reported as the frozen node itself; `get`, which entries and spread also call, returns drafts
        value: Reflect.get(src, key) as unknown,
        writable: true,
        enumerable: d.enumerable ?? true,
        configurable: true,
      };
    },
    defineProperty(target, key, desc) {
      if (!('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
        throw bad('accessor properties are not JSON');
      }
      return handler.set?.(target, key, desc.value, undefined) ?? false;
    },
    setPrototypeOf() {
      throw bad('drafts are plain JSON; their prototype cannot change');
    },
    preventExtensions() {
      throw bad('drafts cannot be frozen or sealed; the store freezes the result');
    },
  };

  function create(
    b: JsonContainer,
    parent: DraftState | undefined,
  ): { proxy: object; state: DraftState } {
    stats.childDrafts++;
    const isArray = Array.isArray(b);
    const target: object = isArray ? [] : {};
    const state: DraftState = {
      base: b,
      isArray,
      parent,
      copy: undefined,
      children: undefined,
      modified: false,
      finalizing: false,
      result: undefined,
    };
    const { proxy, revoke } = Proxy.revocable(target, handler);
    byTarget.set(target, state);
    byProxy.set(proxy, state);
    revokers.push(revoke);
    return { proxy, state };
  }

  const resolve = (o: object): JsonValue | undefined => {
    const s = byProxy.get(o);
    return s === undefined ? undefined : finalizeState(s);
  };

  function finalizeState(s: DraftState): JsonValue {
    if (s.result !== undefined) return s.result;
    if (!s.modified) {
      s.result = s.base;
      return s.base;
    }
    if (s.finalizing) throw bad('cyclic value: a draft was assigned inside itself');
    s.finalizing = true;
    const copy = ensureCopy(s);
    let same: boolean;
    let out: JsonContainer;
    if (s.isArray) {
      const arr = copy as unknown as unknown[];
      const baseArr = s.base as JsonArray;
      const res: JsonValue[] = new Array<JsonValue>(arr.length);
      same = arr.length === baseArr.length;
      for (let i = 0; i < arr.length; i++) {
        if (!(i in arr)) throw bad(`array hole at index ${String(i)}`);
        const v = seal(arr[i], resolve);
        res[i] = v;
        if (v !== baseArr[i]) same = false;
      }
      out = res;
    } else {
      const baseObj = s.base as JsonObject;
      const res: Record<string, JsonValue> = {};
      const keys = Object.keys(copy);
      same = keys.length === Object.keys(baseObj).length;
      for (const k of keys) {
        const v = seal(copy[k], resolve);
        res[k] = v;
        if (!Object.hasOwn(baseObj, k) || v !== baseObj[k]) same = false;
      }
      out = res;
    }
    s.finalizing = false;
    s.result = same ? s.base : sealNode(out);
    return s.result;
  }

  const root = create(base, undefined);
  const revokeAll = (): void => {
    for (const r of revokers) r();
    revokers.length = 0;
  };

  return {
    draft: root.proxy as T,
    finish() {
      try {
        return finalizeState(root.state);
      } finally {
        revokeAll();
      }
    },
    discard: revokeAll,
    get error() {
      return firstError;
    },
    stats,
  };
}
