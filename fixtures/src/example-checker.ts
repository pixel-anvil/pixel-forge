// Example fixture generator: an 8x8 two-colour checkerboard. Dependency-free on purpose.
interface Ctx {
  writePng(relPath: string, img: { width: number; height: number; data: Uint8Array }): void;
}

export default function generate(ctx: Ctx): void {
  const size = 8;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = (x + y) % 2 === 0;
      data.set(on ? [200, 60, 60, 255] : [30, 30, 90, 255], (y * size + x) * 4);
    }
  }
  ctx.writePng('generated/example-checker.png', { width: size, height: size, data });
}
