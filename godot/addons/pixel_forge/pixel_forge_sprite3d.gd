class_name PixelForgeSprite3D
extends AnimatedSprite3D
## Plays a `PixelForgeAsset` in 3D (FR-GD-06). An `AnimatedSprite3D` whose `sprite_frames` come from
## `PixelForgeSpriteFrames` for the current `direction`. Defaults: billboard on, nearest filter,
## alpha cut `DISCARD` (alpha scissor, threshold 0.5), `pixel_size = 1 / pixels_per_unit`. The node
## sets `flip_h` itself (`mirror` XOR the animation's `mirrorOf`); do not set it by hand. The node
## origin sits on the asset's origin point.
##
## Use `play_group(group, direction)`. Markers, events and root motion: use `PixelForgeDriver`.

@export var asset: PixelForgeAsset = null:
	set(value):
		asset = value
		if asset != null:
			pixel_size = 1.0 / asset.pixels_per_unit
		_rebuild()
@export var skin: StringName = &"base":
	set(value):
		skin = value
		_rebuild()
@export var direction: StringName = &"default":
	set(value):
		if value != direction:
			direction = value
			_swap_direction()
## Flips the picture on top of the asset's own mirror rule.
@export var mirror: bool = false:
	set(value):
		mirror = value
		_update_flip()
## Contract section 6.3.
@export var pixel_edge_origin: bool = false:
	set(value):
		pixel_edge_origin = value
		_update_flip()

var _cache: Dictionary = {}


func _init() -> void:
	billboard = BaseMaterial3D.BILLBOARD_ENABLED
	texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	alpha_cut = SpriteBase3D.ALPHA_CUT_DISCARD
	alpha_scissor_threshold = 0.5
	centered = true
	animation_changed.connect(_update_flip)


## Plays `group` facing `direction_name` (kept when empty). Restarts only when the group changed or
## `restart` is true. False when the asset has no such group for the direction.
func play_group(group: StringName, direction_name: StringName = &"", restart: bool = false) -> bool:
	if direction_name != &"":
		direction = direction_name
	if sprite_frames == null or not sprite_frames.has_animation(group):
		return false
	if restart or animation != group or not is_playing():
		stop()
		play(group)
	_update_flip()
	return true


func _rebuild() -> void:
	_cache = {}
	_swap_direction()


func _swap_direction() -> void:
	var sf := PixelForgeSpriteCommon.frames_for(_cache, asset, skin, direction)
	if sf == sprite_frames:
		_update_flip()
		return
	var anim := animation
	var frame_now := frame
	var progress := frame_progress
	var was_playing := is_playing()
	sprite_frames = sf
	if sf != null and sf.has_animation(anim):
		animation = anim
		set_frame_and_progress(mini(frame_now, sf.get_frame_count(anim) - 1), progress)
		if was_playing:
			play(anim)
	_update_flip()


func _update_flip() -> void:
	flip_h = PixelForgeSpriteCommon.flip_for(sprite_frames, animation, mirror)
	var o := PixelForgeSpriteCommon.anchor_offset(asset, flip_h, pixel_edge_origin)
	offset = Vector2(o.x, -o.y)  # y up
