// W1 source image (card E4.5): `photo_ball.png`, a 192x192 "photo-like" picture of a red ball on a
// wall and floor, rendered here from scratch (no photograph, no third-party pixels). Licence: made
// for this repository, released under CC0 1.0 (public domain dedication); see fixtures/README.md.
//
// What makes it photo-like: smooth gradients (thousands of distinct colours), a shaded sphere with a
// soft terminator, a specular highlight, an anti-aliased edge, a soft contact shadow and a little
// pixel noise. The background is a flat-ish beige (wall and floor within RGB distance 70 of each other), so
// `flood` background removal with tolerance 80 separates the ball; the soft shadow is much darker and stays.
//
// Deterministic: only + - * / and sqrt on doubles (exact in IEEE 754) and an integer hash for the noise.
interface Ctx {
  writePng(relPath: string, img: { width: number; height: number; data: Uint8Array }): void;
}

const SIZE = 192;
const CX = 96;
const CY = 92;
const R = 62;
const HORIZON = 128;

/** Integer hash of a pixel position, 0..255 (no randomness API). */
function hash(x: number, y: number): number {
  let h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) & 255;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** x^16 by four squarings: the highlight sharpness. */
function pow16(v: number): number {
  let r = v;
  for (let i = 0; i < 4; i++) r *= r;
  return r;
}

export default function generate(ctx: Ctx): void {
  const data = new Uint8Array(SIZE * SIZE * 4);
  // Unit light direction (towards the light): up, left, and towards the viewer.
  const lx = -0.5;
  const ly = -0.6;
  const lz = 0.62;
  const ll = Math.sqrt(lx * lx + ly * ly + lz * lz);
  const L = [lx / ll, ly / ll, lz / ll] as const;
  // Half vector between the light and the view direction (0, 0, 1).
  const hx = L[0];
  const hy = L[1];
  const hz = L[2] + 1;
  const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const H = [hx / hl, hy / hl, hz / hl] as const;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Wall above the horizon, floor below; both with a soft vertical gradient.
      const t = y / SIZE;
      let r: number;
      let g: number;
      let b: number;
      if (y < HORIZON) {
        r = 212 - 14 * t;
        g = 202 - 16 * t;
        b = 182 - 18 * t;
      } else {
        const f = (y - HORIZON) / (SIZE - HORIZON);
        r = 196 - 14 * f;
        g = 180 - 16 * f;
        b = 154 - 18 * f;
      }
      // Soft contact shadow on the floor: an ellipse right of and below the ball.
      const sx = (x - (CX + 22)) / 78;
      const sy = (y - (CY + R - 4)) / 16;
      const sd = Math.sqrt(sx * sx + sy * sy);
      if (y >= HORIZON - 6 && sd < 1.4) {
        const k = 1 - clamp((sd - 0.35) / 1.05, 0, 1);
        const dark = 0.55 * k;
        r *= 1 - dark;
        g *= 1 - dark;
        b *= 1 - dark;
      }
      // The ball: a Lambert-shaded sphere, ambient light, a specular highlight, an anti-aliased edge.
      const dx = x + 0.5 - CX;
      const dy = y + 0.5 - CY;
      const d = Math.sqrt(dx * dx + dy * dy);
      const cover = clamp(R - d + 0.5, 0, 1);
      if (cover > 0) {
        const nx = dx / R;
        const ny = dy / R;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const diffuse = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
        const spec = pow16(Math.max(0, nx * H[0] + ny * H[1] + nz * H[2]));
        const light = 0.22 + 0.78 * diffuse;
        // Bounce light from the floor tints the underside warm.
        const bounce = Math.max(0, ny) * 0.12;
        const br = clamp(206 * light + 255 * 0.55 * spec + 60 * bounce, 0, 255);
        const bg = clamp(52 * light + 255 * 0.55 * spec + 30 * bounce, 0, 255);
        const bb = clamp(40 * light + 255 * 0.55 * spec + 18 * bounce, 0, 255);
        r = r * (1 - cover) + br * cover;
        g = g * (1 - cover) + bg * cover;
        b = b * (1 - cover) + bb * cover;
      }
      // Sensor noise, -3..+3, the same on all three channels.
      const n = ((hash(x, y) % 7) - 3) | 0;
      const o = (y * SIZE + x) * 4;
      data[o] = Math.round(clamp(r + n, 0, 255));
      data[o + 1] = Math.round(clamp(g + n, 0, 255));
      data[o + 2] = Math.round(clamp(b + n, 0, 255));
      data[o + 3] = 255;
    }
  }
  ctx.writePng('photo_ball.png', { width: SIZE, height: SIZE, data });
}
