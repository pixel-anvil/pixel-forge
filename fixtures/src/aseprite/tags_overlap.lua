-- tags_overlap.aseprite: 7 frames. "run" = frames 1-4 forward, "turn" = frames
-- 4-6 pingpong (overlap on frame 4). Frame 7 is untagged (-> `default`
-- animation semantics in FR-DOC-04 apply to untagged frames). Varied durations.
dofile(app.params["dir"] .. "/common.lua")
local spr = Sprite(8, 8, ColorMode.RGB)
local durs = {0.05, 0.08, 0.1, 0.12, 0.2, 0.25, 0.5}
app.transaction(function()
  for i = 2, 7 do spr:newFrame() end
  local layer = spr.layers[1]; layer.name = "body"
  for f = 1, 7 do
    local img = Image(8, 8, spr.colorMode)
    rect(img, f - 1, 2, 2, 4, Color(30 * f, 255 - 30 * f, 128, 255))
    spr:newCel(layer, f, img, Point(0, 0))
    spr.frames[f].duration = durs[f]
  end
  local run = spr:newTag(1, 4); run.name = "run"; run.aniDir = AniDir.FORWARD
  local turn = spr:newTag(4, 6); turn.name = "turn"; turn.aniDir = AniDir.PING_PONG
end)
spr:saveAs(outPath("tags_overlap"))
