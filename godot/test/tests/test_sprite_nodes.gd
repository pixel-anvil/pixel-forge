extends GutTest
## `PixelForgeSprite2D` and `PixelForgeSprite3D` (FR-GD-06, E8.2): direction switching, the mirror
## flip, the filter / billboard / scissor settings and the origin anchor.

const S := preload("res://tests/support/pxf_support.gd")

var walker: PixelForgeAsset


func before_all() -> void:
	walker = S.build(S.WALKER)  # canvas 24x24, origin (12, 23)


func _nodes() -> Array:
	var n2 := PixelForgeSprite2D.new()
	var n3 := PixelForgeSprite3D.new()
	add_child_autofree(n2)
	add_child_autofree(n3)
	n2.asset = walker
	n3.asset = walker
	return [n2, n3]


func test_settings_2d() -> void:
	var n := PixelForgeSprite2D.new()
	add_child_autofree(n)
	assert_eq(n.texture_filter, CanvasItem.TEXTURE_FILTER_NEAREST)
	assert_true(n.centered)


func test_settings_3d() -> void:
	var n := PixelForgeSprite3D.new()
	add_child_autofree(n)
	assert_eq(n.billboard, BaseMaterial3D.BILLBOARD_ENABLED, "billboard")
	assert_eq(n.texture_filter, BaseMaterial3D.TEXTURE_FILTER_NEAREST, "nearest")
	assert_eq(n.alpha_cut, SpriteBase3D.ALPHA_CUT_DISCARD, "alpha scissor")
	assert_eq(n.alpha_scissor_threshold, 0.5)
	n.asset = walker
	assert_almost_eq(n.pixel_size, 1.0 / walker.pixels_per_unit, 0.00001)


func test_direction_switch_swaps_frames_and_keeps_the_animation() -> void:
	for n in _nodes():
		n.direction = &"side"
		assert_true(n.play_group(&"walk"))
		var side_frames: SpriteFrames = n.sprite_frames
		assert_eq(side_frames.get_meta(PixelForgeSpriteFrames.META_DIRECTION), &"side")
		n.direction = &"up"
		var up_frames: SpriteFrames = n.sprite_frames
		assert_ne(up_frames, side_frames)
		assert_eq(up_frames.get_meta(PixelForgeSpriteFrames.META_DIRECTION), &"up")
		assert_eq(n.animation, &"walk", "same group after the switch")
		assert_true(n.is_playing())
		n.direction = &"side"
		assert_eq(n.sprite_frames, side_frames, "cached per direction")


func test_play_group_with_direction_and_unknown_group() -> void:
	for n in _nodes():
		assert_true(n.play_group(&"walk", &"side"))
		assert_eq(n.direction, &"side")
		assert_eq(n.animation, &"walk")
		assert_false(n.play_group(&"nothing"))
		assert_eq(n.animation, &"walk", "unchanged")


func test_mirror_direction_sets_flip_h() -> void:
	for n in _nodes():
		n.play_group(&"walk", &"side")
		assert_false(n.flip_h, "side is not a mirror")
		n.direction = &"left"
		assert_true(n.flip_h, "left mirrors side")
		n.direction = &"side"
		assert_false(n.flip_h)


func test_mirror_property_xors_with_the_asset_mirror() -> void:
	for n in _nodes():
		n.play_group(&"walk", &"side")
		n.mirror = true
		assert_true(n.flip_h, "mirror on a non-mirror direction")
		n.direction = &"left"
		assert_false(n.flip_h, "mirror XOR mirrorOf")
		n.mirror = false
		assert_true(n.flip_h)


func test_flip_follows_animation_change() -> void:
	for n in _nodes():
		n.direction = &"left"
		n.play_group(&"walk")
		assert_true(n.flip_h)
		# idle is undirected (default): not a mirror, even in a mirror direction
		n.play_group(&"idle")
		assert_false(n.flip_h)
		n.play(&"walk")  # plain AnimatedSprite play, not play_group
		assert_true(n.flip_h)


func test_offset_puts_the_origin_point_on_the_node_origin() -> void:
	# walker: canvas 24, origin (12, 23): centre (12, 12) vs origin point (12.5, 24) -> (-0.5, -12)
	var n2: PixelForgeSprite2D = _nodes()[0]
	n2.play_group(&"walk", &"side")
	assert_eq(n2.offset, Vector2(-0.5, -12.0))
	n2.mirror = true
	assert_eq(n2.offset, Vector2(0.5, -12.0), "x negated when flipped")
	n2.pixel_edge_origin = true
	assert_eq(n2.offset, Vector2(0.0, -12.0))


func test_offset_is_y_up_in_3d() -> void:
	var n3: PixelForgeSprite3D = _nodes()[1]
	n3.play_group(&"walk", &"side")
	assert_eq(n3.offset, Vector2(-0.5, 12.0))


func test_frames_are_canvas_sized() -> void:
	for n in _nodes():
		n.play_group(&"walk", &"side")
		var tex: Texture2D = n.sprite_frames.get_frame_texture(&"walk", 0)
		assert_eq(tex.get_size(), Vector2(walker.canvas_size))


func test_unknown_skin_and_no_asset_are_safe() -> void:
	for n in _nodes():
		n.skin = &"nope"
		assert_null(n.sprite_frames)
		assert_false(n.play_group(&"walk"))
		n.skin = &"base"
		assert_not_null(n.sprite_frames)
		n.asset = null
		assert_null(n.sprite_frames)
