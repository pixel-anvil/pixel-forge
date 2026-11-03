---
'@pixel-forge/convert': patch
---

Fix E4.2 review findings. `downscale` with a grid and `edges: 'keep'` drops an edge cell thinner than half a cell (no spurious 1 pixel column); `kcentroid` assigns once more against the final centres and counts one RGB at several alphas as one colour (exact RGB, mean alpha). `detectGrid` counts a plateau of equal differences once, no longer returns `flat` or `too-small` for bars in one direction or a one-pixel-high strip (the empty axis takes the other axis' cell size, offset 0 and score 0), and `too-small` now needs both sides under 6 pixels.
