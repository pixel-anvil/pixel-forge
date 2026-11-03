
- **GRID-01** (convert, E4.2 review): `detectGrid` returns the coarsest grid that explains the edges. A sprite whose edges sit only on every k-th true boundary (wide flat features) gives a multiple of the true cell size, and `downscale` then merges true pixels. `GridFound` gives callers no signal. Option for later: report the finer candidates, or a `maxCell` hint.
- **GRID-02** (convert, E4.2 review): the fold is computed again for the chosen period in `axisScoreAt`, and option validation is duplicated between `grid.ts` and `downscale.ts`. Cleanup only.
