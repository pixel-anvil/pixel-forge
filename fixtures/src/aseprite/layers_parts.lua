-- layers_parts.aseprite: RGBA, 3 frames, layer naming + group + hidden + opacity.
dofile(app.params["dir"] .. "/common.lua")
local spr = Sprite(16, 16, ColorMode.RGB)
app.transaction(function()
  spr:newFrame(); spr:newFrame()
  for f = 1, 3 do spr.frames[f].duration = 0.1 end

  local body = spr.layers[1]
  body.name = "body"
  local group = spr:newGroup(); group.name = "arm"
  local function mk(name, parent)
    local l = spr:newLayer(); l.name = name
    if parent then l.parent = parent end
    return l
  end
  local upper = mk("part:upper_arm_r", group)
  local lower = mk("part:lower_arm_r@45", group)
  local hand  = mk("part:hand_r#side", group)
  local hidden = mk("hidden_guide")
  hidden.isVisible = false
  lower.opacity = 128

  for f = 1, 3 do
    local function cel(layer, x, y, w, h, c)
      local img = Image(w, h, spr.colorMode)
      rect(img, 0, 0, w, h, c)
      spr:newCel(layer, f, img, Point(x, y))
    end
    cel(body, 4, 2, 8, 8, Color(200, 60, 60, 255))
    cel(upper, 12, 3 + f, 3, 4, Color(60, 160, 60, 255))
    cel(lower, 12, 8 + f, 3, 3, Color(60, 60, 200, 255))
    cel(hand, 11 + f, 12, 2, 2, Color(240, 220, 40, 255))
    cel(hidden, 0, 0, 16, 1, Color(255, 0, 255, 255))
  end
end)
spr:saveAs(outPath("layers_parts"))
