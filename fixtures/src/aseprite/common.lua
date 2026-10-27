-- Shared helpers for fixture scripts. Synthetic art only: rectangles/pixels.
function rect(img, x, y, w, h, color)
  for yy = y, y + h - 1 do
    for xx = x, x + w - 1 do img:drawPixel(xx, yy, color) end
  end
end

function outPath(name)
  local dir = app.params["out"]
  assert(dir, "pass --script-param out=<dir>")
  return dir .. "/" .. name .. ".aseprite"
end
