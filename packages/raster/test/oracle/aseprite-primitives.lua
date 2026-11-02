-- Draws the line / ellipse oracle cases with Aseprite's own tools (app.useTool) and saves 24x24 PNGs.
-- Run from packages/raster/test/oracle:
--   ~/code/aseprite/build/bin/aseprite -b --script aseprite-primitives.lua
-- Each case: opaque red pixels on a transparent canvas, 1px brush. Points are given left-to-right
-- (the order pixel-forge's symmetric line canonicalises to).
local cases = {
  { name = "line-shallow",   tool = "line",    p = { {1, 2},  {20, 9} } },
  { name = "line-steep",     tool = "line",    p = { {3, 1},  {9, 21} } },
  { name = "line-up",        tool = "line",    p = { {2, 20}, {21, 4} } },
  { name = "line-diagonal",  tool = "line",    p = { {2, 3},  {17, 18} } },
  { name = "line-tie",       tool = "line",    p = { {0, 0},  {10, 5} } },
  { name = "ellipse-5x5",    tool = "ellipse", p = { {2, 2},  {6, 6} } },
  { name = "ellipse-8x6",    tool = "ellipse", p = { {1, 1},  {8, 6} } },
  { name = "ellipse-12x7",   tool = "ellipse", p = { {2, 3},  {13, 9} } },
  { name = "ellipse-9x14",   tool = "ellipse", p = { {4, 2},  {12, 15} } },
  { name = "ellipse-4x3",    tool = "ellipse", p = { {5, 5},  {8, 7} } },
  { name = "fellipse-8x6",   tool = "filled_ellipse", p = { {1, 1},  {8, 6} } },
  { name = "fellipse-11x9",  tool = "filled_ellipse", p = { {2, 2},  {12, 10} } },
}
for _, c in ipairs(cases) do
  local spr = Sprite(24, 24, ColorMode.RGB)
  app.useTool{
    tool = c.tool,
    color = Color(255, 0, 0, 255),
    brush = Brush(1),
    points = { Point(c.p[1][1], c.p[1][2]), Point(c.p[2][1], c.p[2][2]) },
  }
  spr:saveCopyAs(c.name .. ".png")
  spr:close()
end
