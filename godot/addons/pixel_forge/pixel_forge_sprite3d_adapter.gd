class_name PixelForgeSprite3DAdapter
extends PixelForgeAdapter
## Built-in adapter for `Sprite3D` (contract section 8.2): `region_enabled = true`, `centered = true`,
## `pixel_size = 1 / pixels_per_unit`, `offset = (c.x, -c.y)` (y up).


func _prepare() -> void:
	_assign(&"region_enabled", true)
	_assign(&"centered", true)
	_assign(&"pixel_size", 1.0 / pixels_per_unit)


func _offset_is_y_up() -> bool:
	return true
