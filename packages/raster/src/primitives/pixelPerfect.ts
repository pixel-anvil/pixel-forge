/** A stroke point. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * "Pixel-perfect" stroke filter for freehand strokes. A 1-pixel-wide stroke drawn with a mouse often contains
 * L-shaped corners: three consecutive points `a, b, c` where `a` and `c` are diagonal neighbours
 * (`|dx| = 1` and `|dy| = 1`) and `b` is orthogonally adjacent to both. `b` is redundant (the diagonal step
 * already connects `a` and `c`), so it is dropped, leaving a thin 8-connected line.
 *
 * Algorithm (as in most pixel editors): consecutive duplicate points are skipped; points are
 * appended one at a time, and after each append the last three kept points are tested once for the L pattern;
 * on a match the middle one is removed. The first and last points of the stroke are always kept. The input is
 * not modified; the result is a new array holding the same point objects.
 */
export function pixelPerfect<P extends Point>(points: readonly P[]): P[] {
  const out: P[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last?.x === p.x && last.y === p.y) continue;
    out.push(p);
    if (out.length >= 3) {
      const a = out[out.length - 3];
      const b = out[out.length - 2];
      if (a && b && isL(a, b, p)) out.splice(out.length - 2, 1);
    }
  }
  return out;
}

function isL(a: Point, b: Point, c: Point): boolean {
  const diagonal = Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1;
  const orthoAB = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
  const orthoBC = Math.abs(b.x - c.x) + Math.abs(b.y - c.y) === 1;
  return diagonal && orthoAB && orthoBC;
}
