// Rotation algorithms for the RotSprite spike.
//
// Image type: { w, h, p: Uint32Array } with packed RGBA (native endianness of a
// Uint32Array view over RGBA bytes). Transparent is canonicalised to 0.
// Rotation results: { w, h, p, ox, oy } where (ox, oy) is the output pixel the
// pivot pixel lands on. Angles are degrees, positive = clockwise on screen (y down).
//
// Pivot convention: a pivot is a pixel (px, py); the rotation centre is that
// pixel's centre (px + 0.5, py + 0.5). Output pixel (X, Y) sits at integer offset
// d = (X - ox, Y - oy) from the pivot pixel, so its centre is exactly d away from
// the rotation centre. Every algorithm maps d = (0,0) back to the pivot pixel.
//
// All sampling arithmetic is integer: cos/sin are Q16 integers (Q16 = 65536).

export const Q = 65536;

export function fromRGBA(img) {
  const p = new Uint32Array(img.w * img.h);
  const v = new Uint32Array(img.d.buffer, img.d.byteOffset, img.w * img.h);
  for (let i = 0; i < p.length; i++) p[i] = img.d[i * 4 + 3] === 0 ? 0 : v[i];
  return { w: img.w, h: img.h, p };
}
export function toRGBA(im) {
  const d = new Uint8ClampedArray(im.w * im.h * 4);
  new Uint32Array(d.buffer).set(im.p);
  return { w: im.w, h: im.h, d };
}
export const alphaOf = (c) => (c >>> 24) & 255; // little-endian: A is the high byte

// Q16 trig. NFR-02 wants a fixed table; for the spike we derive it from Math and
// round once. T1.6 should commit the integer table as literals.
export function trigQ16(deg) {
  // exact quadrants, so 0/90/180/270 are exact
  const n = ((deg % 360) + 360) % 360;
  if (n === 0) return [Q, 0];
  if (n === 90) return [0, Q];
  if (n === 180) return [-Q, 0];
  if (n === 270) return [0, -Q];
  const r = (n * Math.PI) / 180;
  return [Math.round(Math.cos(r) * Q), Math.round(Math.sin(r) * Q)];
}

// Mirror-symmetric floor of n/d (d > 0): floor for n >= 0, ceil(n/d) - 1 for n < 0.
// Differs from floor only when n/d is an exact negative integer (a sample point on an
// x8 pixel boundary left of / above the pivot). Makes the result of rotating the
// mirrored sprite by -θ exactly the mirror of rotating by +θ (up to the pivot column).
export const rnd = (n, d) => (n >= 0 ? Math.floor((2 * n + d) / (2 * d)) : -Math.floor((-2 * n + d) / (2 * d))); // round half away from 0 of n/d
export const sfloor = (n, d) => (n >= 0 ? Math.floor(n / d) : Math.ceil(n / d) - 1);

// ---------------------------------------------------------------- Scale2x
// EPX/Scale2x, edges replicated (same as Aseprite's image_scale2x).
export function scale2x(src) {
  const { w, h, p } = src;
  const W = w * 2, o = new Uint32Array(W * h * 2);
  for (let y = 0; y < h; y++) {
    const row = y * w, up = y > 0 ? row - w : row, dn = y < h - 1 ? row + w : row;
    const o0 = y * 2 * W, o1 = o0 + W;
    for (let x = 0; x < w; x++) {
      const P = p[row + x];
      const A = p[up + x];                       // above
      const D = p[dn + x];                       // below
      const C = x > 0 ? p[row + x - 1] : P;      // left
      const B = x < w - 1 ? p[row + x + 1] : P;  // right
      const X = x * 2;
      o[o0 + X] = C === A && C !== D && A !== B ? A : P;
      o[o0 + X + 1] = A === B && A !== C && B !== D ? B : P;
      o[o1 + X] = D === C && D !== B && C !== A ? C : P;
      o[o1 + X + 1] = B === D && B !== A && D !== C ? D : P;
    }
  }
  return { w: W, h: h * 2, p: o };
}
export function scale8(src) {
  return scale2x(scale2x(scale2x(src)));
}

// ---------------------------------------------------------------- bounds
// Integer offset range (relative to the pivot pixel) that can receive content.
function outRange(w, h, px, py, C, S) {
  const xs = [-px - 0.5, w - px - 0.5], ys = [-py - 0.5, h - py - 0.5];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const x of xs) for (const y of ys) {
    const fx = (C * x - S * y) / Q, fy = (S * x + C * y) / Q;
    x0 = Math.min(x0, fx); x1 = Math.max(x1, fx); y0 = Math.min(y0, fy); y1 = Math.max(y1, fy);
  }
  return [Math.floor(x0) - 1, Math.ceil(x1) + 1, Math.floor(y0) - 1, Math.ceil(y1) + 1];
}
function makeOut(dx0, dx1, dy0, dy1) {
  const w = dx1 - dx0 + 1, h = dy1 - dy0 + 1;
  return { w, h, p: new Uint32Array(w * h), ox: -dx0, oy: -dy0 };
}

// Crop a result to its opaque bbox (always keeping the pivot pixel inside), keep pivot tracking.
export function trim(r) {
  let x0 = r.ox, x1 = r.ox, y0 = r.oy, y1 = r.oy;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (r.p[y * r.w + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1, p = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p[y * w + x] = r.p[(y + y0) * r.w + x + x0];
  return { w, h, p, ox: r.ox - x0, oy: r.oy - y0 };
}

// ---------------------------------------------------------------- nearest
export function rotNearest(src, px, py, deg) {
  const [C, S] = trigQ16(deg);
  const [dx0, dx1, dy0, dy1] = outRange(src.w, src.h, px, py, C, S);
  const r = makeOut(dx0, dx1, dy0, dy1);
  for (let dy = dy0; dy <= dy1; dy++) for (let dx = dx0; dx <= dx1; dx++) {
    // inverse rotation of the output pixel centre; source pixel containing it
    const sx = px + rnd(C * dx + S * dy, Q);
    const sy = py + rnd(-S * dx + C * dy, Q);
    if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) continue;
    r.p[(dy - dy0) * r.w + dx - dx0] = src.p[sy * src.w + sx];
  }
  return trim(r);
}

// ---------------------------------------------------------------- RotSprite
// big = scale8(src) can be passed in (cached per variant).
// downsample: 'center' (default) — one sample per output pixel: the output pixel
//   centre, inverse-rotated into x8 space, picks the x8 pixel that contains it
//   (floor). At 0 deg that is sub-pixel (4,4) of the 8x8 block.
// 'mode' — majority colour of the 64 x8 sub-pixel centres of the output pixel
//   (ties -> the 'center' sample if tied, else first max).
export function rotSprite(src, px, py, deg, opts = {}) {
  const big = opts.big || scale8(src);
  const mode = opts.downsample || 'center';
  const [C, S] = trigQ16(deg);
  const [dx0, dx1, dy0, dy1] = outRange(src.w, src.h, px, py, C, S);
  const r = makeOut(dx0, dx1, dy0, dy1);
  const BW = big.w, BH = big.h, bp = big.p;
  const cx8 = 8 * px + 4, cy8 = 8 * py + 4; // pivot centre in x8 space (a pixel corner)
  if (mode === 'center') {
    for (let dy = dy0; dy <= dy1; dy++) {
      let row = (dy - dy0) * r.w - dx0;
      for (let dx = dx0; dx <= dx1; dx++) {
        // x8 offset = 8 * R^-1 d ; in Q16 -> divide by Q/8
        const sx = cx8 + sfloor(C * dx + S * dy, 8192);
        const sy = cy8 + sfloor(-S * dx + C * dy, 8192);
        if (sx < 0 || sy < 0 || sx >= BW || sy >= BH) continue;
        r.p[row + dx] = bp[sy * BW + sx];
      }
    }
    return trim(r);
  }
  // mode downsample
  const counts = new Map();
  for (let dy = dy0; dy <= dy1; dy++) for (let dx = dx0; dx <= dx1; dx++) {
    counts.clear();
    for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
      // x8 sub-pixel centre relative to the pivot centre, in x8 units, times 2 (to stay integer)
      const ux2 = 2 * (8 * dx - 4 + u) + 1, vy2 = 2 * (8 * dy - 4 + v) + 1;
      const sx = cx8 + sfloor(C * ux2 + S * vy2, 2 * Q);
      const sy = cy8 + sfloor(-S * ux2 + C * vy2, 2 * Q);
      const c = sx < 0 || sy < 0 || sx >= BW || sy >= BH ? 0 : bp[sy * BW + sx];
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    const scx = cx8 + sfloor(C * dx + S * dy, 8192), scy = cy8 + sfloor(-S * dx + C * dy, 8192);
    const centre = scx < 0 || scy < 0 || scx >= BW || scy >= BH ? 0 : bp[scy * BW + scx];
    let best = centre, bn = counts.get(centre) || 0;
    for (const [c, n] of counts) if (n > bn) { best = c; bn = n; }
    r.p[(dy - dy0) * r.w + dx - dx0] = best;
  }
  return trim(r);
}

// ---------------------------------------------------------------- 3-shear (Paeth)
// Forward mapping, bijective on Z^2, so it is a pixel permutation: no colour or
// area change, pivot exactly fixed. Quadrant handled by exact 90-degree steps.
const rnd_unused = (n, d) => (n >= 0 ? Math.floor((2 * n + d) / (2 * d)) : -Math.floor((-2 * n + d) / (2 * d))); // round half away from 0 of n/d
export function rotShear(src, px, py, deg) {
  let ang = ((deg % 360) + 360) % 360; if (ang > 180) ang -= 360; // (-180, 180]
  const k = Math.sign(ang) * Math.ceil(Math.abs(ang) / 90 - 0.5); // mirror-symmetric: k(-a) = -k(a)
  const res = ang - 90 * k; // [-45, 45]
  const T = Math.round(-Math.tan((res * Math.PI) / 360) * Q); // -tan(res/2)
  const Sn = trigQ16(res)[1];
  const pts = [];
  let minx = 0, maxx = 0, miny = 0, maxy = 0;
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    const c = src.p[y * src.w + x];
    if (!c) continue;
    let a = x - px, b = y - py;
    for (let i = 0; i < k; i++) { const t = a; a = -b; b = t; } // 90 cw: (a,b)->(-b,a)
    for (let i = 0; i < -k; i++) { const t = a; a = b; b = -t; } // 90 ccw
    a += rnd(T * b, Q);
    b += rnd(Sn * a, Q);
    a += rnd(T * b, Q);
    pts.push(a, b, c);
    minx = Math.min(minx, a); maxx = Math.max(maxx, a); miny = Math.min(miny, b); maxy = Math.max(maxy, b);
  }
  const r = makeOut(minx, maxx, miny, maxy);
  for (let i = 0; i < pts.length; i += 3) r.p[(pts[i + 1] + r.oy) * r.w + pts[i] + r.ox] = pts[i + 2];
  return r;
}

// ---------------------------------------------------------------- helpers
export function mirrorX(src, px) {
  const p = new Uint32Array(src.w * src.h);
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) p[y * src.w + (src.w - 1 - x)] = src.p[y * src.w + x];
  return { img: { w: src.w, h: src.h, p }, px: src.w - 1 - px };
}
export function colourSet(im) {
  const s = new Set();
  for (const c of im.p) if (c) s.add(c);
  return s;
}
export function opaqueCount(im) {
  let n = 0;
  for (const c of im.p) if (c) n++;
  return n;
}
// set of "dx,dy" keys relative to pivot for opaque pixels
export function relMask(r, flip = false) {
  const s = new Set();
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (r.p[y * r.w + x]) {
    const dx = x - r.ox, dy = y - r.oy;
    s.add((flip ? -dx : dx) + ',' + dy);
  }
  return s;
}
export function iou(a, b) {
  let inter = 0;
  for (const k of a) if (b.has(k)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 1 : inter / uni;
}
export function at(r, dx, dy) {
  const x = r.ox + dx, y = r.oy + dy;
  if (x < 0 || y < 0 || x >= r.w || y >= r.h) return 0;
  return r.p[y * r.w + x];
}

// 8-connected components of the opaque mask
export function components(im) {
  const seen = new Uint8Array(im.w * im.h); let n = 0;
  for (let i = 0; i < im.p.length; i++) {
    if (!im.p[i] || seen[i]) continue;
    n++; const st = [i]; seen[i] = 1;
    while (st.length) {
      const j = st.pop(), x = j % im.w, y = (j / im.w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= im.w || Y >= im.h) continue;
        const k = Y * im.w + X; if (im.p[k] && !seen[k]) { seen[k] = 1; st.push(k); }
      }
    }
  }
  return n;
}
// opaque pixels with no 8-neighbour of the same colour ("orphan" single-pixel islands of a colour)
export function singletons(im) {
  let n = 0;
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
    const c = im.p[y * im.w + x]; if (!c) continue;
    let same = false;
    for (let dy = -1; dy <= 1 && !same; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue; const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < im.w && Y < im.h && im.p[Y * im.w + X] === c) { same = true; break; }
    }
    if (!same) n++;
  }
  return n;
}
