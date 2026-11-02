class_name PixelForgeAdapter
extends RefCounted
## Applies one frame to a target node (contract section 8). This base class is the **duck-typed**
## adapter: it drives any node that has `texture`, `region_rect`, `offset` and `flip_h` properties
## (and optionally `pixel_size`), such as the first consumer game's lit billboard.
##
## `PixelForgeSprite2DAdapter` and `PixelForgeSprite3DAdapter` extend it with the built-in settings
## for `Sprite2D` and `Sprite3D`. `PixelForgeDriver` creates the right one when its `target` is set;
## a game can assign its own subclass to `PixelForgeDriver.adapter`.
##
## The adapter assigns **only properties whose value changed**, in the order `texture`,
## `region_rect`, `offset`, `flip_h` (the billboard rebuilds its quad on every setter).

## Godot's Sprite2D and Sprite3D flip the texture inside the same rectangle: `flip_h` does not
## mirror `offset`. Observed on 4.6.1 by rendering both nodes (contract section 8.1). If a node ever
## does mirror its offset, a subclass overrides `_flip_mirrors_offset()` and the adapter negates x for it.
const FLIP_MIRRORS_OFFSET := false

## The node to drive. Set by `PixelForgeDriver`.
var node: Node = null
## Pixels per metre of the asset, set by the driver before each `apply`; used for `pixel_size`.
var pixels_per_unit: float = 16.0
## Duck-typed option: the node's `offset` has +y moving the picture up (the billboard). `false`: +y
## moves it down (a 2D node). The built-in adapters fix this themselves.
var offset_y_up: bool = true
## Duck-typed option: set `pixel_size = 1 / pixels_per_unit` when the node has that property.
var apply_pixel_size: bool = true


## `offset` is the centre of `region` relative to the origin point, in pixels, y down, already
## flipped for `flip_h` (contract section 8.1). It is never mirrored here.
func apply(texture: Texture2D, region: Rect2i, offset: Vector2, flip_h: bool) -> void:
	if node == null or not is_instance_valid(node):
		return
	_prepare()
	var o := Vector2(offset.x, -offset.y) if _offset_is_y_up() else offset
	if _flip_mirrors_offset() and flip_h:
		o.x = -o.x
	_assign(&"texture", texture)
	_assign(&"region_rect", Rect2(region))
	_assign(&"offset", o)
	_assign(&"flip_h", flip_h)


## Per-class settings, applied before the frame (`region_enabled`, `centered`, `pixel_size`).
func _prepare() -> void:
	if apply_pixel_size and _has_property(&"pixel_size"):
		_assign(&"pixel_size", 1.0 / pixels_per_unit)


func _offset_is_y_up() -> bool:
	return offset_y_up


func _flip_mirrors_offset() -> bool:
	return FLIP_MIRRORS_OFFSET


## Sets `prop` on the node when its current value differs.
func _assign(prop: StringName, value: Variant) -> void:
	if node.get(prop) != value:
		node.set(prop, value)


func _has_property(prop: StringName) -> bool:
	for p: Dictionary in node.get_property_list():
		if p["name"] == prop:
			return true
	return false
