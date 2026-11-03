/**
 * Colour ramp generator (FR-PAL-03): a dark-to-light run of colours around a base colour, computed
 * in OKLab / OKLCH. Shadows turn toward a cool hue (blue) and lights toward a warm hue (yellow), the
 * usual pixel-art "hue shift". Every parameter can be changed.
 *
 * Determinism: only `+ - * /`, `Math.sqrt`, `Math.floor` and `Math.round` are used. Hue rotation uses a
 * fixed-length Taylor series ({@link sinCosDeg}) instead of `Math.sin` / `Math.cos`, and no `atan2`, so
 * the 8-bit output is bit-identical on every platform. The final rounding is explicit (round half up,
 * in `linearToSrgb8`). OKLab is Bjorn Ottosson's public-domain / MIT reference (see `convert.ts`).
 * @packageDocumentation
 */
import type { RGBA8 } from '@pixel-forge/schema';
import { linearToSrgb8, oklabToLinear, srgb8ToOklab, type Oklab } from './convert.js';

/** Options of {@link generateRamp}. */
export interface RampOptions {
  /** The base colour (alpha is kept on every step). It appears unchanged at `baseIndex`. */
  readonly base: RGBA8;
  /** Number of colours, 1 to {@link MAX_RAMP_STEPS}. Step 0 is the darkest. */
  readonly steps: number;
  /** Index of the base colour in the ramp (default `floor((steps - 1) / 2)`, the middle). */
  readonly baseIndex?: number;
  /**
   * Largest hue rotation in degrees, reached at both ends of the ramp (default 20). Dark steps turn
   * toward `coolHue`, light steps toward `warmHue`, never past them. 0 keeps the base hue.
   */
  readonly hueShift?: number;
  /**
   * Chroma change at the ends as a fraction of the base chroma (default 0): the darkest step gets
   * `1 - satShift` times the base chroma and the lightest `1 + satShift` times (so a negative value
   * saturates shadows and mutes lights). Clamped so chroma stays at 0 or more.
   */
  readonly satShift?: number;
  /**
   * OKLab lightness of the darkest and lightest step, `[min, max]` in `0..1` (default
   * `[0.35 * L, L + 0.75 * (0.97 - L)]` for a base of lightness `L`). The range always includes the
   * base lightness.
   */
  readonly lightRange?: readonly [number, number];
  /** Target hue of shadows, degrees in OKLCH (default {@link COOL_HUE}). */
  readonly coolHue?: number;
  /** Target hue of lights, degrees in OKLCH (default {@link WARM_HUE}). */
  readonly warmHue?: number;
}

/** Most steps {@link generateRamp} makes. */
export const MAX_RAMP_STEPS = 32;
/** Default OKLCH hue of shadows (blue). */
export const COOL_HUE = 265;
/** Default OKLCH hue of lights (yellow). */
export const WARM_HUE = 90;

const PI = 3.141592653589793;

/**
 * Sine and cosine of an angle in degrees by a fixed-length Taylor series on `[-180, 180]`: only basic
 * arithmetic, so the result is a pure function of the input bits (unlike `Math.sin`). Accurate to
 * about 1e-15.
 */
export function sinCosDeg(deg: number): { readonly sin: number; readonly cos: number } {
  const d = deg - 360 * Math.round(deg / 360);
  const x = (d * PI) / 180;
  const x2 = x * x;
  let sin = 0;
  let cos = 0;
  let sTerm = x;
  let cTerm = 1;
  for (let k = 0; k < 18; k++) {
    sin += sTerm;
    cos += cTerm;
    sTerm = (-sTerm * x2) / ((2 * k + 2) * (2 * k + 3));
    cTerm = (-cTerm * x2) / ((2 * k + 1) * (2 * k + 2));
  }
  return { sin, cos };
}

const inGamut = (rgb: readonly [number, number, number]): boolean =>
  rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** OKLab to 8-bit sRGB; an out-of-gamut colour loses chroma (bisection, fixed count) before it is clamped. */
function toSrgb8Gamut(lab: Oklab): readonly [number, number, number] {
  let rgb = oklabToLinear(lab);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear({ L: lab.L, a: lab.a * mid, b: lab.b * mid }))) lo = mid;
      else hi = mid;
    }
    rgb = oklabToLinear({ L: lab.L, a: lab.a * lo, b: lab.b * lo });
  }
  return [linearToSrgb8(rgb[0]), linearToSrgb8(rgb[1]), linearToSrgb8(rgb[2])];
}

/**
 * Generates a ramp of `steps` colours from dark (index 0) to light, around `options.base`.
 *
 * With `s` the signed position along the ramp (`-1` at step 0, `0` at `baseIndex`, `+1` at the last
 * step): lightness goes linearly from `lightRange[0]` to the base lightness to `lightRange[1]`; the hue
 * turns by `hueShift * |s|` degrees toward `coolHue` (dark side) or `warmHue` (light side), along the
 * shorter way and not past the target; chroma is `baseChroma * (1 + satShift * s)`. A colour outside
 * the sRGB gamut keeps its lightness and hue and loses chroma. The base colour is returned exactly.
 * A grey base has no hue to turn, so its steps stay grey.
 *
 * @throws RangeError for bad `steps`, `baseIndex`, or `lightRange`.
 */
export function generateRamp(options: RampOptions): RGBA8[] {
  const { base, steps } = options;
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_RAMP_STEPS) {
    throw new RangeError(`generateRamp: steps must be an integer 1..${String(MAX_RAMP_STEPS)}`);
  }
  const at = options.baseIndex ?? Math.floor((steps - 1) / 2);
  if (!Number.isInteger(at) || at < 0 || at >= steps) {
    throw new RangeError(`generateRamp: baseIndex must be an integer 0..${String(steps - 1)}`);
  }
  const hueShift = Math.min(180, Math.max(0, options.hueShift ?? 20));
  const satShift = options.satShift ?? 0;
  const lab = srgb8ToOklab(base[0], base[1], base[2]);
  const bL = lab.L;
  const [lo0, hi0] = options.lightRange ?? [0.35 * bL, bL + 0.75 * (0.97 - bL)];
  if (!(lo0 >= 0 && hi0 <= 1 && lo0 <= hi0)) {
    throw new RangeError('generateRamp: lightRange must satisfy 0 <= min <= max <= 1');
  }
  const lo = Math.min(lo0, bL);
  const hi = Math.max(hi0, bL);
  const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  const ux = chroma === 0 ? 0 : lab.a / chroma;
  const uy = chroma === 0 ? 0 : lab.b / chroma;
  const cool = sinCosDeg(options.coolHue ?? COOL_HUE);
  const warm = sinCosDeg(options.warmHue ?? WARM_HUE);
  const out: RGBA8[] = [];
  for (let i = 0; i < steps; i++) {
    if (i === at) {
      out.push([base[0], base[1], base[2], base[3]]);
      continue;
    }
    const dark = i < at;
    const s = dark ? -(at - i) / at : (i - at) / (steps - 1 - at);
    const f = dark ? -s : s;
    const L = dark ? bL + (lo - bL) * f : bL + (hi - bL) * f;
    const C = Math.max(0, chroma * (1 + satShift * s));
    let dx = ux;
    let dy = uy;
    if (chroma > 0 && hueShift > 0) {
      const t = dark ? cool : warm;
      const dot = ux * t.cos + uy * t.sin;
      const cross = ux * t.sin - uy * t.cos; // > 0: the target is counter-clockwise of the base
      const turn = sinCosDeg(hueShift * f);
      if (turn.cos <= dot) {
        // the rotation would reach or pass the target: stop on it
        dx = t.cos;
        dy = t.sin;
      } else {
        const sign = cross < 0 ? -1 : 1; // opposite hues (cross 0, dot < 0): turn counter-clockwise
        const rs = sign * turn.sin;
        dx = ux * turn.cos - uy * rs;
        dy = ux * rs + uy * turn.cos;
      }
    }
    const [r, g, b] = toSrgb8Gamut({ L, a: C * dx, b: C * dy });
    out.push([r, g, b, base[3]]);
  }
  return out;
}
