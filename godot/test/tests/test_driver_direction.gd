extends GutTest
## PixelForgeDriver direction (fallback chain, explicit and auto), mirroring (mirror XOR mirrorOf) and
## the marker, event and root-motion queries (contract sections 3.4 and 6). Numbers are worked by hand
## for the synthetic asset of support/driver_support.gd: origin (8, 15), 16 pixels per metre, and
## marker `m` of the frame with global index n at `(9 + n, 15 - 2n)`.

const S := preload("res://tests/support/driver_support.gd")

var asset: PixelForgeAsset
var driver: PixelForgeDriver


func before_all() -> void:
	asset = S.make_asset()


func before_each() -> void:
	driver = S.make_driver(asset)
	add_child_autofree(driver)


# --- fallback -------------------------------------------------------------------------------


func test_play_follows_the_fallback_chain() -> void:
	assert_true(driver.play(&"dirs", &"down"))
	assert_eq(driver.direction, &"down", "the property keeps the requested direction")
	assert_eq(driver.frame_index, 11, "down is not authored: the side entry plays")
	assert_false(driver.is_flipped())


func test_an_authored_direction_wins_over_its_fallback() -> void:
	driver.play(&"dirs", &"up")
	assert_eq(driver.frame_index, 13)


func test_the_chain_ends_at_default() -> void:
	assert_true(driver.play(&"lin", &"left"))
	assert_eq(driver.frame_index, 0)
	assert_true(driver.play(&"lin", &"up"))
	assert_eq(driver.frame_index, 0)


func test_the_direction_property_re_resolves_the_playing_group() -> void:
	driver.play(&"dirs", &"up")
	driver.direction = &"down"
	assert_eq(driver.frame_index, 11, "now the side art")
	driver.direction = &"up"
	assert_eq(driver.frame_index, 13)
	driver.direction = &"nowhere"
	assert_eq(driver.frame_index, 13, "unresolvable: the current entry keeps playing")
	assert_eq(driver.direction, &"nowhere")


func test_play_with_an_empty_direction_uses_the_current_one() -> void:
	driver.direction = &"up"
	driver.play(&"dirs")
	assert_eq(driver.frame_index, 13)


func test_direction_change_keeps_position_and_wraps_in_the_new_timeline() -> void:
	driver.play(&"dirs", &"side")  # side: T = 375
	driver.seek_ms(1000.0)  # 1000 mod 375 = 250: frame 1
	driver.direction = &"up"  # up: T = 500, 1000 mod 500 = 0: frame 0
	assert_eq(driver.position_ms, 1000.0)
	assert_eq(driver.frame, 0)
	assert_eq(driver.frame_index, 13)


# --- mirroring ------------------------------------------------------------------------------


func test_applied_flip_is_mirror_xor_the_animations_mirror_flag() -> void:
	driver.play(&"dirs", &"side")
	assert_false(driver.is_flipped())
	driver.mirror = true
	assert_true(driver.is_flipped())
	driver.play(&"dirs", &"left")  # mirrorOf side: frames of side, mirror flag set
	assert_eq(driver.frame_index, 11, "a mirror plays the frames of its source")
	assert_true(driver.is_flipped() != driver.mirror, "mirror true XOR flag true is false")
	assert_false(driver.is_flipped())
	driver.mirror = false
	assert_true(driver.is_flipped())
	driver.play(&"dirs", &"right")  # a mirror with overrides: a normal entry, flag false
	assert_false(driver.is_flipped())
	driver.mirror = true
	assert_true(driver.is_flipped())


func test_markers_follow_the_applied_flip() -> void:
	# lin frame 0 (n = 0): marker pixel (9, 15): x - ox = 1, y - oy - 0.5 = -0.5
	driver.play(&"lin")
	assert_true(driver.has_marker(&"m"))
	assert_eq(driver.marker(&"m"), Vector2(1, -0.5))
	assert_eq(driver.marker_metres(&"m"), Vector2(1, 0.5) / 16.0, "y up, from the centre of the pixel")
	driver.mirror = true
	assert_eq(driver.marker(&"m"), Vector2(-1, -0.5))
	assert_eq(driver.marker_metres(&"m"), Vector2(-1, 0.5) / 16.0)
	# frame 1 (n = 1): pixel (10, 13): (2, -2.5) px, (2, 2.5) px up
	driver.mirror = false
	driver.set_frame(1)
	assert_eq(driver.marker(&"m"), Vector2(2, -2.5))
	assert_eq(driver.marker_metres(&"m"), Vector2(2, 2.5) / 16.0)
	driver.mirror = true
	assert_eq(driver.marker(&"m"), Vector2(-2, -2.5))


func test_markers_of_a_mirror_entry_are_mirrored_without_the_game_asking() -> void:
	driver.play(&"dirs", &"side")
	var plain := driver.marker(&"m")
	driver.play(&"dirs", &"left")
	var mirrored := driver.marker(&"m")
	assert_eq(mirrored, Vector2(-plain.x, plain.y))
	# the same pixel that the asset helper reports for frame 11 with the flip set
	assert_eq(mirrored, asset.marker_px(11, &"m", true))


func test_marker_is_a_valid_point_for_a_frame_without_markers() -> void:
	driver.play(&"lin")
	assert_false(driver.has_marker(&"hand_r"))
	assert_eq(driver.marker(&"hand_r"), Vector2.ZERO)
	assert_eq(driver.marker_metres(&"hand_r"), Vector2.ZERO)


func test_root_motion_negates_dx_when_flipped() -> void:
	driver.play(&"lin")
	driver.set_frame(1)  # n = 1: (2, -1)
	assert_eq(driver.root_motion(), Vector2i(2, -1))
	driver.mirror = true
	assert_eq(driver.root_motion(), Vector2i(-2, -1))


func test_frame_events_is_the_flag_query() -> void:
	driver.play(&"lin")
	assert_eq(driver.frame_events(), PackedStringArray(["l0"]))
	assert_true(driver.frame_events().has("l0"))
	driver.set_frame(2)
	assert_eq(driver.frame_events(), PackedStringArray(["l2"]))
	driver.paused = true
	driver.advance(1.0)
	assert_eq(driver.frame_events(), PackedStringArray(["l2"]), "a query, whatever the clock does")


func test_frame_offset_is_the_region_centre_relative_to_the_origin_point() -> void:
	# lin frame 1: region (4, 0, 4, 4) untrimmed offset_px (0, 0): centre (2, 2)
	# c = (2 - 8 - 0.5, 2 - 15 - 1) = (-6.5, -14); mirrored x flips
	driver.play(&"lin")
	driver.set_frame(1)
	assert_eq(driver.frame_offset(), Vector2(-6.5, -14.0))
	driver.mirror = true
	assert_eq(driver.frame_offset(), Vector2(6.5, -14.0))


# --- auto_direction ---------------------------------------------------------------------------


func test_sector_direction_with_four_sectors() -> void:
	# [angle, direction, mirror]; positive angles are the character's left
	var rows := [
		[0.0, &"down", false], [44.0, &"down", false], [-44.0, &"down", false],
		[45.0, &"side", true], [-45.0, &"side", false], [90.0, &"side", true], [-90.0, &"side", false],
		[134.0, &"side", true], [135.0, &"up", false], [-135.0, &"up", false], [180.0, &"up", false],
		[-180.0, &"up", false], [540.0, &"up", false], [360.0, &"down", false],
	]
	for row: Array in rows:
		var r := PixelForgeDriver.sector_direction(row[0], 4)
		assert_eq(r["direction"], row[1], "4 sectors, %s deg" % row[0])
		assert_eq(r["mirror"], row[2], "4 sectors mirror, %s deg" % row[0])


func test_sector_direction_with_eight_sectors() -> void:
	var rows := [
		[0.0, &"down", false], [22.0, &"down", false], [22.5, &"down_side", true], [-22.5, &"down_side", false],
		[67.0, &"down_side", true], [67.5, &"side", true], [112.0, &"side", true], [112.5, &"up_side", true],
		[-157.0, &"up_side", false], [157.5, &"up", false], [180.0, &"up", false],
	]
	for row: Array in rows:
		var r := PixelForgeDriver.sector_direction(row[0], 8)
		assert_eq(r["direction"], row[1], "8 sectors, %s deg" % row[0])
		assert_eq(r["mirror"], row[2], "8 sectors mirror, %s deg" % row[0])


func _auto_setup(count: int) -> Array:
	var sprite := Sprite3D.new()  # a Node3D facing -Z at the origin
	add_child_autofree(sprite)
	var cam := Node3D.new()
	add_child_autofree(cam)
	driver.target = sprite
	driver.auto_direction = count
	driver.auto_direction_camera = cam
	driver.play(&"dirs", &"side")
	return [sprite, cam]


func test_auto_direction_follows_the_camera_sector() -> void:
	var nodes := _auto_setup(4)
	var cam: Node3D = nodes[1]
	# facing is -Z: a camera at -Z is in front (down), +Z behind (up), -X on the left, +X on the right
	var cases := [
		[Vector3(0, 0, -5), &"down", false],
		[Vector3(0, 0, 5), &"up", false],
		[Vector3(-5, 0, 0), &"side", true],
		[Vector3(5, 0, 0), &"side", false],
		[Vector3(5, 7, 0), &"side", false],
	]
	for c: Array in cases:
		cam.position = c[0]
		driver.advance(0.0)
		assert_eq(driver.direction, c[1], "camera at %s" % c[0])
		assert_eq(driver.mirror, c[2], "mirror, camera at %s" % c[0])


func test_auto_direction_with_eight_sectors_and_a_turned_character() -> void:
	var nodes := _auto_setup(8)
	var sprite: Sprite3D = nodes[0]
	var cam: Node3D = nodes[1]
	cam.position = Vector3(-5, 0, -5)  # front-left of a character facing -Z
	driver.advance(0.0)
	assert_eq(driver.direction, &"down_side")
	assert_true(driver.mirror)
	sprite.rotation_degrees.y = 180.0  # now facing +Z: the same camera is behind-right
	driver.advance(0.0)
	assert_eq(driver.direction, &"up_side")
	assert_false(driver.mirror)


func test_auto_direction_off_leaves_the_game_in_charge() -> void:
	var nodes := _auto_setup(4)
	var cam: Node3D = nodes[1]
	driver.auto_direction = 0
	driver.direction = &"up"
	driver.mirror = true
	cam.position = Vector3(0, 0, -5)
	driver.advance(0.0)
	assert_eq(driver.direction, &"up")
	assert_true(driver.mirror)


func test_auto_direction_without_a_camera_does_nothing() -> void:
	var sprite := Sprite3D.new()
	add_child_autofree(sprite)
	driver.target = sprite
	driver.auto_direction = 4
	driver.direction = &"up"
	driver.advance(0.0)  # no camera in this headless tree
	assert_eq(driver.direction, &"up")


func test_pixel_edge_origin_moves_the_point_to_the_pixel_edge() -> void:
	# Same frames as above with the pixel-edge convention (contract section 6.3):
	# frame offset x loses the 0.5; markers are measured at the pixel's top-left corner.
	driver.pixel_edge_origin = true
	driver.play(&"lin")
	assert_eq(driver.marker(&"m"), Vector2(1, -1), "pixel (9, 15): (9 - 8, 15 - 15 - 1)")
	assert_eq(driver.marker_metres(&"m"), Vector2(1, 1) / 16.0)
	driver.mirror = true
	assert_eq(driver.marker(&"m"), Vector2(-1, -1))
	driver.mirror = false
	driver.set_frame(1)
	assert_eq(driver.frame_offset(), Vector2(-6.0, -14.0), "c = (2 - 8, 2 - 15 - 1)")
	driver.mirror = true
	assert_eq(driver.frame_offset(), Vector2(6.0, -14.0))
