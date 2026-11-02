/**
 * sRGB / linear / OKLab / OKLCH conversions.
 *
 * Determinism: every function here uses only IEEE-754 basic operations (`+ - * /` and `Math.sqrt`,
 * which are correctly rounded). Fractional powers and cube roots are computed with fixed-iteration
 * Newton solvers instead of `Math.pow` / `Math.cbrt`, whose last-bit results may differ between
 * engines and platforms. Hence {@link srgb8ToOklab}, {@link oklabToSrgb8}, {@link oklabDistanceSq}
 * and everything built on them give bit-identical results anywhere. The one exception is the
 * OKLCH pair, which uses `Math.atan2` / `Math.cos` / `Math.sin` (hue only): never use OKLCH values
 * for a pixel-affecting choice that must be identical across platforms without quantising first.
 * @packageDocumentation
 */

/** OKLab triple: `L` lightness (0..1 for in-gamut sRGB), `a` green-red, `b` blue-yellow. */
export interface Oklab {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

/** OKLCH triple: lightness, chroma (`>= 0`), hue in degrees `[0, 360)`. */
export interface Oklch {
  readonly L: number;
  readonly C: number;
  readonly h: number;
}

/**
 * Real `n`th root of `x > 0` by Newton iteration using only `+ - * /`.
 * `x` is first scaled by an exact power of two so the iteration always starts in a well-behaved
 * interval; the iteration count is fixed, so the result is a pure function of the input bits.
 * Returns 0 for `x <= 0` and NaN (callers handle sign).
 */
function nthRoot(x: number, n: number): number {
  if (!(x > 0)) return 0;
  if (!Number.isFinite(x)) return x;
  const scale = 2 ** n; // exact
  let v = x;
  let k = 0;
  while (v < 1 / scale) {
    v *= scale;
    k++;
  }
  while (v > 1) {
    v /= scale;
    k--;
  }
  // v in [1/scale, 1]: Newton started at 1 (above the root) converges monotonically.
  let y = 1;
  for (let i = 0; i < 40; i++) {
    let p = 1;
    for (let j = 1; j < n; j++) p *= y;
    y = ((n - 1) * y + v / p) / n;
  }
  // v = x * scale^k, so root(x) = y / 2^k (exact power-of-two scaling)
  let r = y;
  while (k > 0) {
    r /= 2;
    k--;
  }
  while (k < 0) {
    r *= 2;
    k++;
  }
  return r;
}

/** Sign-preserving cube root built from Newton iteration (deterministic stand-in for `Math.cbrt`). */
export function cbrt(x: number): number {
  return x < 0 ? -nthRoot(-x, 3) : nthRoot(x, 3);
}

/**
 * sRGB electro-optical transfer (decode): encoded `0..1` to linear light.
 * Exact piecewise sRGB curve (IEC 61966-2-1): `c / 12.92` up to `0.04045`, else
 * `((c + 0.055) / 1.055) ^ 2.4` (computed as the fifth root raised to the 12th power).
 */
export function srgbToLinear(c: number): number {
  if (c <= 0.04045) return c / 12.92;
  const r = nthRoot((c + 0.055) / 1.055, 5);
  const r2 = r * r;
  const r4 = r2 * r2;
  return r4 * r4 * r4; // x^(12/5) = (x^(1/5))^12
}

/**
 * sRGB transfer (encode): linear light to encoded. Inverse of {@link srgbToLinear}: `12.92 * c`
 * up to `0.0031308`, else `1.055 * c ^ (1/2.4) - 0.055` (`c^(5/12)` = twelfth root of `c^5`).
 */
export function linearToSrgb(c: number): number {
  if (c <= 0.0031308) return c * 12.92;
  const c2 = c * c;
  const c5 = c2 * c2 * c;
  // twelfth root = sqrt(sqrt(cbrt(x)))
  const twelfth = Math.sqrt(Math.sqrt(nthRoot(c5, 3)));
  return 1.055 * twelfth - 0.055;
}

let decodeTable: Float64Array | undefined;

/** Linear value of an 8-bit sRGB channel (table-backed, built once, deterministic). */
export function srgb8ToLinear(v: number): number {
  if (decodeTable === undefined) {
    const t = new Float64Array(256);
    for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
    decodeTable = t;
  }
  return decodeTable[v & 255] ?? 0;
}

/** Linear light to an 8-bit sRGB channel: encode, scale by 255, round half up, clamp to 0..255. */
export function linearToSrgb8(c: number): number {
  const v = Math.floor(linearToSrgb(c) * 255 + 0.5);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Linear sRGB to OKLab (Ottosson's reference matrices, 2021 revision). */
export function linearToOklab(r: number, g: number, b: number): Oklab {
  const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** OKLab to linear sRGB (unclamped: out-of-gamut colours give components outside 0..1). */
export function oklabToLinear(lab: Oklab): readonly [number, number, number] {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** 8-bit sRGB (alpha ignored) to OKLab. */
export function srgb8ToOklab(r: number, g: number, b: number): Oklab {
  return linearToOklab(srgb8ToLinear(r), srgb8ToLinear(g), srgb8ToLinear(b));
}

/** OKLab to 8-bit sRGB, clamping out-of-gamut channels. Exact inverse of {@link srgb8ToOklab} on 8-bit input. */
export function oklabToSrgb8(lab: Oklab): readonly [number, number, number] {
  const [r, g, b] = oklabToLinear(lab);
  return [linearToSrgb8(r), linearToSrgb8(g), linearToSrgb8(b)];
}

/** OKLab to OKLCH. Chroma is `sqrt(a² + b²)`; hue is degrees in `[0, 360)` (0 when chroma is 0). */
export function oklabToOklch(lab: Oklab): Oklch {
  const C = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  if (C === 0) return { L: lab.L, C: 0, h: 0 };
  let h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (h < 0) h += 360;
  if (h >= 360) h -= 360;
  return { L: lab.L, C, h };
}

/** OKLCH to OKLab. */
export function oklchToOklab(lch: Oklch): Oklab {
  const rad = (lch.h * Math.PI) / 180;
  return { L: lch.L, a: lch.C * Math.cos(rad), b: lch.C * Math.sin(rad) };
}

/** Squared Euclidean distance in OKLab (FR-CONV-05). Monotonic in the true distance; no `sqrt`. */
export function oklabDistanceSq(a: Oklab, b: Oklab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dL * dL + da * da + db * db;
}
