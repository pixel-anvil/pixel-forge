-- indexed_palette.aseprite: indexed mode, 16-colour palette, transparent index 0.
-- Aseprite writes cels as compressed (type 2) by default.
dofile(app.params["dir"] .. "/common.lua")
local spr = Sprite(8, 8, ColorMode.INDEXED)
spr.transparentColor = 0
local pal = spr.palettes[1]
pal:resize(16)
pal:setColor(0, Color(0, 0, 0, 0))
for i = 1, 15 do
  pal:setColor(i, Color((i * 37) % 256, (i * 91) % 256, (i * 151) % 256, 255))
end
app.transaction(function()
  local layer = spr.layers[1]; layer.name = "body"
  local img = Image(8, 8, spr.colorMode)
  for y = 0, 7 do for x = 0, 7 do
    img:drawPixel(x, y, (x + y) % 16) -- index 0 stays transparent
  end end
  spr:newCel(layer, 1, img, Point(0, 0))
end)
spr:saveAs(outPath("indexed_palette"))
