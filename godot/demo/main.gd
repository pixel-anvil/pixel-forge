extends Node2D
## Plays walker.pxf on a Sprite2D with PixelForgeDriver.
## Left / Right: mirror off / on. Space: next animation group.

const WALKER := "res://walker.pxf"
const SPRITE_SCALE := Vector2(8, 8)
const DIRECTION := &"side"

var _driver: PixelForgeDriver
var _sprite: Sprite2D
var _groups: Array[StringName] = []
var _index := 0


func _ready() -> void:
	var asset := load(WALKER) as PixelForgeAsset
	if asset == null:
		push_error("demo: could not load %s" % WALKER)
		return
	for group in asset.animations.keys():
		_groups.append(StringName(group))
	_groups.sort()

	_sprite = Sprite2D.new()
	_sprite.scale = SPRITE_SCALE
	_sprite.position = get_viewport_rect().size / 2.0
	add_child(_sprite)

	_driver = PixelForgeDriver.new()
	_driver.asset = asset
	add_child(_driver)
	_driver.target = _sprite
	_play_current()


func _unhandled_input(event: InputEvent) -> void:
	var key := event as InputEventKey
	if key == null or not key.pressed or key.echo:
		return
	match key.keycode:
		KEY_LEFT:
			_driver.mirror = true
		KEY_RIGHT:
			_driver.mirror = false
		KEY_SPACE:
			_index = (_index + 1) % _groups.size()
			_play_current()


func _play_current() -> void:
	_driver.play(_groups[_index], DIRECTION, true)
