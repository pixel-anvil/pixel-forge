/** Brush shape. */
export type BrushShape = 'square' | 'round';

/** A brush: a `size x size` stamp, size 1..8. */
export interface Brush {
  readonly shape: BrushShape;
  readonly size: number;
}

/** Stamp mask: `size x size` booleans, row-major, plus the offset of its top-left from the stamp point. */
export interface BrushMask {
  readonly size: number;
  readonly offset: number;
  readonly cells: readonly boolean[];
}

/**
 * Builds the stamp mask of a brush. The stamp point is at `offset = -floor(size / 2)` from the mask's top-left,
 * so odd sizes are centred and even sizes extend one more pixel towards the top/left.
 *
 * Round brushes: with coordinates doubled around the centre, `u = 2x - (size-1)`, `v = 2y - (size-1)`, a cell is
 * set when `u*u + v*v <= size*size - size` (integer only, symmetric in both axes). Gives 1: one pixel,
 * 2: full 2x2, 3: plus, 4: 4x4 without corners, 5: 5x5 without corners, ...
 */
export function brushMask(brush: Brush): BrushMask {
  const { shape, size } = brush;
  if (!Number.isInteger(size) || size < 1 || size > 8) {
    throw new RangeError(`brush size must be an integer 1..8, got ${String(size)}`);
  }
  const cells: boolean[] = [];
  const limit = size * size - size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = 2 * x - (size - 1);
      const v = 2 * y - (size - 1);
      cells.push(shape === 'square' || u * u + v * v <= limit);
    }
  }
  return { size, offset: -(size >> 1), cells };
}
