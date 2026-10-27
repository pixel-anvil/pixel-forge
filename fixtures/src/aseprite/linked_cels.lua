-- linked_cels.aseprite: 4 frames; cels in frames 2 and 4 linked to frame 1.
dofile(app.params["dir"] .. "/common.lua")
local spr = Sprite(8, 8, ColorMode.RGB)
app.transaction(function()
  for i = 2, 4 do spr:newFrame() end
  local layer = spr.layers[1]; layer.name = "body"
  for f = 1, 4 do
    local img = Image(8, 8, spr.colorMode)
    if f == 3 then rect(img, 1, 1, 6, 6, Color(0, 120, 220, 255))
    else rect(img, 2, 2, 4, 4, Color(220, 80, 0, 255)) end
    spr:newCel(layer, f, img, Point(0, 0))
  end
end)
-- The Lua API has no "create linked cel" call; use the LinkCels command on a
-- range (links the selected cels to the first one in the range).
for _, target in ipairs({2, 4}) do
  app.range:clear()
  app.range.layers = {spr.layers[1]}
  app.range.frames = {1, target}
  app.command.LinkCels()
end
spr:saveAs(outPath("linked_cels"))
