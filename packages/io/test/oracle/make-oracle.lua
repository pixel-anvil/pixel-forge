-- Generates the Aseprite oracle sprite for the sheet-export test (see make-oracle.sh).
-- 8x6 sprite, 6 frames: tag "idle/side" = frames 1..3 (forward), tag "run/side" = 4..6 (pingpong).
-- Every frame draws a deterministic pattern so any misplaced cell is visible.
local spr = Sprite(8, 6)
local durations = { 100, 120, 140, 60, 80, 90 }
local layer = spr.layers[1]
for i = 1, 6 do
  if i > 1 then spr:newEmptyFrame() end
  spr.frames[i].duration = durations[i] / 1000
  local img = Image(spr.spec)
  img:clear(Color(0, 0, 0, 0))
  for y = 0, 5 do
    for x = 0, 7 do
      if (x + y * 3 + i) % 4 ~= 0 then
        img:putPixel(x, y, Color((i * 40) % 256, (x * 30 + i * 7) % 256, (y * 40) % 256, 255))
      end
    end
  end
  -- a half transparent pixel to exercise straight alpha
  img:putPixel(0, 0, Color(255, 255, 255, 128))
  spr:newCel(layer, i, img, Point(0, 0))
end
local a = spr:newTag(1, 3)
a.name = "idle/side"
a.aniDir = AniDir.FORWARD
local b = spr:newTag(4, 6)
b.name = "run/side"
b.aniDir = AniDir.PING_PONG
spr:saveAs(app.params["out"])
