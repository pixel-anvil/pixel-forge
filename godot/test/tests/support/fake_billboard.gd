extends Node
## A stand-in for the first consumer game's lit billboard node, named generically: a node with
## `texture`, `region_rect` (empty = whole texture), `flip_h`, `pixel_size` (metres per pixel) and
## `offset` (pixels, +y moves the picture up). Each setter records its name in `calls`, because the
## real node rebuilds its quad on every setter and the adapter must assign only what changed.

var calls: Array[String] = []

var texture: Texture2D = null:
	set(v):
		texture = v
		calls.append("texture")
var region_rect: Rect2 = Rect2():
	set(v):
		region_rect = v
		calls.append("region_rect")
var offset: Vector2 = Vector2.ZERO:
	set(v):
		offset = v
		calls.append("offset")
var flip_h: bool = false:
	set(v):
		flip_h = v
		calls.append("flip_h")
var pixel_size: float = 0.01:
	set(v):
		pixel_size = v
		calls.append("pixel_size")


func take_calls() -> Array[String]:
	var out := calls.duplicate()
	calls.clear()
	return out
