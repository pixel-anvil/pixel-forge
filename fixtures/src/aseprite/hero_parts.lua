-- hero_parts.aseprite: the T3.9 synthetic hero (48x48 RGBA, 1 frame), one layer per part with
-- `part:<bone>[@variant]` names, bottom layer first (ascending template z). Hand-kept copy of
-- HERO_PARTS in fixtures/src/hero.ts; packages/io/test/hero-fixture.test.ts compares the two.
dofile(app.params["dir"] .. "/common.lua")

local SKIN, SKIN_FAR = {232, 190, 150}, {190, 150, 120}
local HAIR, EYE = {70, 45, 30}, {30, 30, 40}
local SHIRT, SHIRT_FAR = {60, 110, 190}, {40, 75, 140}
local PANTS, PANTS_FAR = {70, 70, 100}, {45, 45, 68}
local SHOE, SHOE_FAR = {120, 75, 40}, {85, 52, 28}
local SLEEVE, CUFF = {200, 70, 60}, {240, 220, 90}

-- { layer name, { {x, y, w, h, colour}, ... } }
local PARTS = {
  {"part:thigh_l", {{20, 24, 6, 16, PANTS_FAR}}},
  {"part:shin_l", {{21, 34, 4, 13, PANTS_FAR}}},
  {"part:foot_l", {{21, 46, 9, 2, SHOE_FAR}, {21, 45, 4, 1, SHOE_FAR}}},
  {"part:upper_arm_l", {{22, 11, 3, 10, SHIRT_FAR}}},
  {"part:lower_arm_l", {{22, 18, 3, 9, SKIN_FAR}}},
  {"part:hand_l", {{22, 24, 4, 4, SKIN_FAR}}},
  {"part:pelvis", {{21, 23, 7, 7, PANTS}}},
  {"part:torso", {{21, 10, 7, 15, SHIRT}}},
  {"part:neck", {{22, 8, 5, 4, SKIN}}},
  {"part:thigh_r", {{21, 24, 6, 16, PANTS}}},
  {"part:shin_r", {{22, 34, 4, 13, PANTS}}},
  {"part:foot_r", {{22, 46, 9, 2, SHOE}, {22, 45, 4, 1, SHOE}}},
  {"part:head", {{21, 0, 8, 10, SKIN}, {22, 10, 5, 2, SKIN}, {21, 0, 8, 3, HAIR}, {21, 3, 2, 3, HAIR}, {27, 4, 1, 1, EYE}}},
  {"part:upper_arm_r", {{23, 11, 3, 10, SHIRT}}},
  {"part:lower_arm_r", {{23, 18, 3, 9, SKIN}}},
  {"part:lower_arm_r@sleeve", {{22, 18, 5, 9, SLEEVE}, {22, 25, 5, 2, CUFF}}},
  {"part:hand_r", {{23, 24, 4, 4, SKIN}}},
}

local spr = Sprite(48, 48, ColorMode.RGB)
app.transaction(function()
  for i, part in ipairs(PARTS) do
    local layer = (i == 1) and spr.layers[1] or spr:newLayer()
    layer.name = part[1]
    -- Bounding box of the rectangles; the cel holds only that box.
    local x0, y0, x1, y1 = 48, 48, 0, 0
    for _, r in ipairs(part[2]) do
      x0 = math.min(x0, r[1]); y0 = math.min(y0, r[2])
      x1 = math.max(x1, r[1] + r[3]); y1 = math.max(y1, r[2] + r[4])
    end
    local img = Image(x1 - x0, y1 - y0, spr.colorMode)
    for _, r in ipairs(part[2]) do
      local c = r[5]
      rect(img, r[1] - x0, r[2] - y0, r[3], r[4], Color(c[1], c[2], c[3], 255))
    end
    spr:newCel(layer, 1, img, Point(x0, y0))
  end
end)
spr:saveAs(outPath("hero_parts"))
