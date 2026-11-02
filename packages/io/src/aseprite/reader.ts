import { AseError } from './errors.js';
import type { AseErrorCode } from './errors.js';

/** Decode UTF-8 leniently: malformed sequences become U+FFFD. (No TextDecoder: the lib set has no DOM.) */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  const n = bytes.length;
  const cont = (at: number): number => {
    const b = bytes[at];
    return b !== undefined && (b & 0xc0) === 0x80 ? b & 0x3f : -1;
  };
  while (i < n) {
    const b = bytes[i] ?? 0;
    let cp = 0xfffd;
    let len = 1;
    if (b < 0x80) {
      cp = b;
    } else if (b >= 0xc2 && b <= 0xdf) {
      const c1 = cont(i + 1);
      if (c1 >= 0) {
        cp = ((b & 0x1f) << 6) | c1;
        len = 2;
      }
    } else if (b >= 0xe0 && b <= 0xef) {
      const c1 = cont(i + 1);
      const c2 = cont(i + 2);
      if (c1 >= 0 && c2 >= 0) {
        const v = ((b & 0x0f) << 12) | (c1 << 6) | c2;
        if (v >= 0x800 && (v < 0xd800 || v > 0xdfff)) {
          cp = v;
          len = 3;
        }
      }
    } else if (b >= 0xf0 && b <= 0xf4) {
      const c1 = cont(i + 1);
      const c2 = cont(i + 2);
      const c3 = cont(i + 3);
      if (c1 >= 0 && c2 >= 0 && c3 >= 0) {
        const v = ((b & 0x07) << 18) | (c1 << 12) | (c2 << 6) | c3;
        if (v >= 0x10000 && v <= 0x10ffff) {
          cp = v;
          len = 4;
        }
      }
    }
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

/**
 * Bounds-checked little-endian cursor over `bytes[pos..end)`. Every read that would pass `end`
 * throws an {@link AseError} with the code given at construction, so a parser can never read out
 * of bounds.
 */
export class Reader {
  /** Current offset into `bytes`. */
  pos: number;
  private readonly view: DataView;

  /**
   * @param bytes - the whole file
   * @param pos - first readable offset
   * @param end - one past the last readable offset (clamped to the file length)
   * @param overrun - error code thrown when a read passes `end`
   */
  constructor(
    readonly bytes: Uint8Array,
    pos: number,
    readonly end: number,
    private readonly overrun: AseErrorCode,
  ) {
    this.pos = pos;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Bytes left before `end`. */
  get remaining(): number {
    return this.end - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) {
      throw new AseError(
        this.overrun,
        `read of ${String(n)} bytes at offset ${String(this.pos)} passes ${String(this.end)}`,
      );
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** 16.16 fixed point. */
  fixed(): number {
    return this.i32() / 65536;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  /** A copy of the next `n` bytes. */
  take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** A view (no copy) of the next `n` bytes. */
  view8(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** `STRING`: WORD byte length, then UTF-8 bytes. */
  string(): string {
    return decodeUtf8(this.view8(this.u16()));
  }
}
