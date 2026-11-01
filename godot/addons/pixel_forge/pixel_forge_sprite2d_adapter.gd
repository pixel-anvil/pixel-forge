class_name PixelForgeSprite2DAdapter
extends PixelForgeAdapter
## Built-in adapter for `Sprite2D` (contract section 8.2): `region_enabled = true`, `centered = true`,
## `offset = c` (y down).


func _prepare() -> void:
	_assign(&"region_enabled", true)
	_assign(&"centered", true)


func _offset_is_y_up() -> bool:
	return false
