extends GutTest
## PixelForgeAsset helpers (contract section 2): resolve, has_animation, frame_count, duration_ms,
## has_marker, marker_px, marker_metres. Numbers are worked by hand for the walker fixture: canvas
## 24x24, origin (12, 23), 16 pixels per metre. Frame order: flash/side 0; idle/default 1-3;
## walk/side 4-6; walk/up 7-8.

const S := preload("res://tests/support/pxf_support.gd")

var asset: PixelForgeAsset


func before_all() -> void:
	asset = S.build(S.WALKER)


func test_resolve_authored_direction() -> void:
	var r := asset.resolve(&"walk", &"side")
	assert_eq(r["group"], &"walk")
	assert_eq(r["direction"], &"side")
	assert_eq(r["frames"], PackedInt32Array([4, 5, 6]))
	assert_eq(r["loop"], &"loop")
	assert_false(r["mirror"])


func test_resolve_mirror_direction() -> void:
	var r := asset.resolve(&"walk", &"left")
	assert_eq(r["direction"], &"left")
	assert_eq(r["frames"], PackedInt32Array([4, 5, 6]))
	assert_true(r["mirror"])


func test_resolve_follows_direction_fallback_in_order() -> void:
	# down: [down, side]: down is not authored, so the side entry plays
	var r := asset.resolve(&"walk", &"down")
	assert_eq(r["direction"], &"side", "the key actually found")
	assert_eq(r["frames"], PackedInt32Array([4, 5, 6]))
	# up: [up, side]: up is authored and wins
	assert_eq(asset.resolve(&"walk", &"up")["direction"], &"up")
	# a group with only side and no fallback list for the request: [left], then default
	assert_eq(asset.resolve(&"flash", &"left"), {})


func test_resolve_ends_with_default() -> void:
	var r := asset.resolve(&"idle", &"side")
	assert_eq(r["direction"], &"default")
	assert_eq(r["frames"], PackedInt32Array([1, 2, 3]))
	assert_eq(r["loop"], &"once")
	assert_eq(asset.resolve(&"idle", &"default")["direction"], &"default")
	assert_eq(asset.resolve(&"idle", &"")["direction"], &"default")


func test_resolve_unknown_group_or_direction_is_empty() -> void:
	assert_eq(asset.resolve(&"nope", &"side"), {})
	assert_eq(asset.resolve(&"walk", &"default"), {}, "walk has no default entry")
	assert_eq(asset.resolve(&"walk", &"sideways"), {})


func test_has_animation() -> void:
	assert_true(asset.has_animation(&"walk", &"side"))
	assert_true(asset.has_animation(&"walk", &"left"))
	assert_true(asset.has_animation(&"walk", &"down"), "through the fallback")
	assert_true(asset.has_animation(&"idle", &"side"), "through default")
	assert_false(asset.has_animation(&"flash", &"left"))
	assert_false(asset.has_animation(&"nope", &"side"))
	assert_true(asset.has_animation(&"walk"), "empty direction: any entry")
	assert_true(asset.has_animation(&"flash"))
	assert_false(asset.has_animation(&"nope"))


func test_frame_count_and_duration() -> void:
	assert_eq(asset.frame_count(&"walk", &"side"), 3)
	assert_eq(asset.frame_count(&"walk", &"left"), 3, "a mirror plays its source's frames")
	assert_eq(asset.frame_count(&"walk", &"up"), 2)
	assert_eq(asset.frame_count(&"walk", &"down"), 3, "through the fallback")
	assert_eq(asset.frame_count(&"nope", &"side"), 0)
	assert_eq(asset.duration_ms(&"walk", &"side"), 80 + 120 + 100)
	assert_eq(asset.duration_ms(&"walk", &"left"), 300)
	assert_eq(asset.duration_ms(&"walk", &"up"), 60 + 90)
	assert_eq(asset.duration_ms(&"idle", &"default"), 100 + 50 + 100)
	assert_eq(asset.duration_ms(&"flash", &"side"), 50)
	assert_eq(asset.duration_ms(&"flash", &"left"), 0)


func test_has_marker() -> void:
	assert_true(asset.has_marker(4, &"ball"))
	assert_true(asset.has_marker(4, &"hand_r"))
	assert_true(asset.has_marker(5, &"ball"))
	assert_false(asset.has_marker(5, &"hand_r"), "absent in that frame")
	assert_false(asset.has_marker(6, &"ball"))
	assert_false(asset.has_marker(4, &"nope"))
	assert_false(asset.has_marker(-1, &"ball"))
	assert_false(asset.has_marker(99, &"ball"))


func test_marker_px_is_relative_to_the_origin_point() -> void:
	# ball of walk/side/0 is canvas pixel (15, 12); the origin pixel is (12, 23), so the origin
	# point is (12.5, 24): dx = 15 - 12 = 3, dy = 12 - 23 - 0.5 = -11.5 (y down, up is negative).
	assert_eq(asset.marker_px(4, &"ball", false), Vector2(3.0, -11.5))
	assert_eq(asset.marker_px(4, &"hand_r", false), Vector2(2.0, -9.5))
	assert_eq(asset.marker_px(5, &"ball", false), Vector2(4.0, -12.5))
	# the very first pixel of the canvas (flash marker at (0, 0))
	assert_eq(asset.marker_px(0, &"ball", false), Vector2(-12.0, -23.5))


func test_marker_px_mirror_flips_x_only() -> void:
	assert_eq(asset.marker_px(4, &"ball", true), Vector2(-3.0, -11.5))
	assert_eq(asset.marker_px(0, &"ball", true), Vector2(12.0, -23.5))


func test_mirrored_marker_matches_the_mirrored_pixel_index() -> void:
	# FR-RIG-16: x' = 2 * ox - mx. The mirrored marker's x must equal x' - ox for every marker.
	for i in asset.markers.size():
		for name: StringName in asset.markers[i]:
			var m: Vector2i = asset.markers[i][name]
			var mirrored_x := 2 * asset.origin.x - m.x
			assert_eq(asset.marker_px(i, name, true).x, float(mirrored_x - asset.origin.x), "frame %d %s" % [i, name])
			assert_eq(asset.marker_px(i, name, false).y, asset.marker_px(i, name, true).y)


func test_marker_metres_is_y_up_over_pixels_per_unit() -> void:
	# (3, 23 + 0.5 - 12 = 11.5) / 16
	assert_eq(asset.marker_metres(4, &"ball", false), Vector2(3.0 / 16.0, 11.5 / 16.0))
	assert_eq(asset.marker_metres(4, &"ball", true), Vector2(-3.0 / 16.0, 11.5 / 16.0))
	var px := asset.marker_px(5, &"ball", false)
	assert_eq(asset.marker_metres(5, &"ball", false), Vector2(px.x, -px.y) / 16.0)


func test_absent_marker_is_zero_and_pushes_no_error() -> void:
	assert_eq(asset.marker_px(5, &"hand_r", false), Vector2.ZERO)
	assert_eq(asset.marker_metres(5, &"hand_r", true), Vector2.ZERO)
	assert_eq(asset.marker_px(99, &"ball", false), Vector2.ZERO)
	assert_eq(asset.marker_metres(-3, &"ball", false), Vector2.ZERO)
