---
'@pixel-forge/convert': minor
---

Add pixel grid detection and downscaling (E4.2, FR-CONV-03, FR-CONV-04). `detectGrid` finds the cell size and phase of upscaled or "fake" pixel art from an edge histogram (folded per trial size), or returns a definite "no grid" with a reason. `downscale` makes one pixel per cell by a target width/height or a detected grid, with the methods `box`, `kcentroid` (k-means in OKLab), `nearest` and `mode`, and one alpha rule for all (a transparent-majority cell becomes transparent).
