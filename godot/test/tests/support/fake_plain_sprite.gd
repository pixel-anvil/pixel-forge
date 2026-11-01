extends Node
## A duck-typed target with the four required properties and no `pixel_size`, with a y-down `offset`.

var texture: Texture2D = null
var region_rect: Rect2 = Rect2()
var offset: Vector2 = Vector2.ZERO
var flip_h: bool = false
