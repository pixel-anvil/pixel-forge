extends GutTest
## The atlas oracle (contract section 11): every atlas region, cropped, equals the render/*.png
## frame it came from, pixel for pixel, with trim on and off and with several paddings.

const S := preload("res://tests/support/pxf_support.gd")


func _expected_frame(table: Array, key: String) -> Dictionary:
	for f: Dictionary in table:
		if f["key"] == key:
			return f
	return {}


# Walks every frame of `pxf` and compares the atlas with the independently decoded PNGs.
func _check_atlas_matches_png(pxf: String, options: Dictionary, label: String) -> void:
	var asset := S.build(pxf, options)
	var index := S.zip_index(pxf)
	var authored := S.authored_frames(index)
	assert_eq(asset.frames.size(), authored.size(), "%s: one frame entry per authored frame" % label)
	var atlas_size: Vector2i = Vector2i.ZERO
	for skin: StringName in asset.atlases:
		var atlas: Image = asset.atlases[skin].get_image()
		if atlas_size == Vector2i.ZERO:
			atlas_size = atlas.get_size()
		assert_eq(atlas.get_size(), atlas_size, "%s: skin %s shares the atlas size" % [label, skin])
		for i in authored.size():
			var png := S.zip_png(pxf, skin, authored[i]["image"])
			assert_eq(png.get_size(), asset.canvas_size, "%s: %s is canvas sized" % [label, authored[i]["key"]])
			var region: Rect2i = asset.frames[i]["region"]
			var offset: Vector2i = asset.frames[i]["offset_px"]
			var where := "%s %s %s" % [label, skin, authored[i]["key"]]
			# 1. the atlas crop is the PNG crop at offset_px, byte for byte
			assert_true(Rect2i(Vector2i.ZERO, atlas.get_size()).encloses(region), "%s: region inside atlas" % where)
			assert_eq(
				atlas.get_region(region).get_data(),
				png.get_region(Rect2i(offset, region.size)).get_data(),
				"%s: region pixels" % where
			)
			# 2. nothing visible was cropped away
			assert_true(
				S.transparent_outside(png, Rect2i(offset, region.size)),
				"%s: the PNG is transparent outside the region" % where
			)
			# 3. offset_px + region rebuild the whole canvas-sized frame
			assert_eq(S.canvas_frame(asset, skin, i).get_data(), png.get_data(), "%s: canvas frame" % where)


func test_atlas_matches_render_png_walker_default_options() -> void:
	_check_atlas_matches_png(S.WALKER, {}, "walker default")


func test_atlas_matches_render_png_walker_no_trim() -> void:
	_check_atlas_matches_png(S.WALKER, {"trim": false}, "walker untrimmed")


func test_atlas_matches_render_png_walker_paddings() -> void:
	for pad in [0, 3]:
		_check_atlas_matches_png(S.WALKER, {"padding": pad}, "walker padding %d" % pad)
		_check_atlas_matches_png(S.WALKER, {"padding": pad, "trim": false}, "walker padding %d untrimmed" % pad)


func test_atlas_matches_render_png_skins() -> void:
	_check_atlas_matches_png(S.SKINS, {}, "skins default")
	_check_atlas_matches_png(S.SKINS, {"trim": false, "padding": 2}, "skins untrimmed padded")


func test_trim_boxes_match_the_generator() -> void:
	var asset := S.build(S.WALKER, {"padding": 0})
	var table: Array = S.expected()["walker"]["frames"]
	assert_eq(table.size(), asset.frames.size())
	for i in table.size():
		var want: Dictionary = table[i]
		var f: Dictionary = asset.frames[i]
		if want["box"] == null:
			# a fully transparent frame is one transparent pixel
			assert_eq(f["region"].size, Vector2i.ONE, "%s: empty frame region" % want["key"])
			assert_eq(f["offset_px"], Vector2i.ZERO, "%s: empty frame offset" % want["key"])
		else:
			var box := S.box_rect(want["box"])
			assert_eq(f["region"].size, box.size, "%s: trimmed size" % want["key"])
			assert_eq(f["offset_px"], box.position, "%s: trimmed offset" % want["key"])


func test_untrimmed_regions_are_the_canvas() -> void:
	var asset := S.build(S.WALKER, {"trim": false})
	assert_eq(asset.canvas_size, Vector2i(24, 24))
	for f: Dictionary in asset.frames:
		assert_eq(f["region"].size, asset.canvas_size)
		assert_eq(f["offset_px"], Vector2i.ZERO)


func test_the_full_canvas_frame_is_known_pixel_by_pixel() -> void:
	# flash/side/0 paints pixel (x, y) as (x*10, y*10, (x*7 + y*3) & 255), a formula that does not
	# depend on the render pipeline.
	var asset := S.build(S.WALKER)
	var i := (asset.animations[&"flash"][&"side"]["frames"] as PackedInt32Array)[0]
	assert_eq(asset.frames[i]["region"].size, Vector2i(24, 24), "no empty border to trim")
	var img := S.canvas_frame(asset, &"base", i)
	for y in 24:
		for x in 24:
			var want := Color8(x * 10, y * 10, (x * 7 + y * 3) & 255, 255)
			assert_eq(img.get_pixel(x, y), want, "pixel %d,%d" % [x, y])


func test_equal_images_share_a_region_but_keep_their_own_frame_entry() -> void:
	var asset := S.build(S.WALKER)
	var idle: PackedInt32Array = asset.animations[&"idle"][&"default"]["frames"]
	assert_eq(idle.size(), 3)
	assert_eq(asset.frames[idle[0]]["region"], asset.frames[idle[2]]["region"], "same pixels, same region")
	assert_ne(asset.frames[idle[0]]["region"], asset.frames[idle[1]]["region"])
	assert_ne(idle[0], idle[2], "never deduplicated as entries")
	assert_eq(asset.events[idle[0]], PackedStringArray())
	assert_eq(asset.events[idle[2]], PackedStringArray(["release"]))
	assert_true(asset.has_marker(idle[0], &"ball"))
	assert_false(asset.has_marker(idle[2], &"ball"))


func test_regions_with_padding_never_overlap() -> void:
	for pad in [0, 1, 4]:
		var asset := S.build(S.WALKER, {"padding": pad})
		var atlas: Image = asset.atlases[&"base"].get_image()
		var seen: Array[Rect2i] = []
		for f: Dictionary in asset.frames:
			var padded: Rect2i = (f["region"] as Rect2i).grow(pad)
			assert_true(Rect2i(Vector2i.ZERO, atlas.get_size()).encloses(padded), "padded region inside the atlas")
			if padded in seen:
				continue
			for other in seen:
				assert_false(padded.intersects(other), "padded regions %s and %s overlap" % [padded, other])
			seen.append(padded)


func test_padding_ring_is_transparent() -> void:
	var asset := S.build(S.WALKER, {"padding": 2})
	var atlas: Image = asset.atlases[&"base"].get_image()
	for f: Dictionary in asset.frames:
		var region: Rect2i = f["region"]
		var ring := region.grow(2)
		for y in range(ring.position.y, ring.end.y):
			for x in range(ring.position.x, ring.end.x):
				if not region.has_point(Vector2i(x, y)):
					assert_eq(atlas.get_pixel(x, y).a, 0.0, "padding pixel %d,%d" % [x, y])


func test_frames_follow_sorted_group_direction_index_order() -> void:
	var asset := S.build(S.WALKER)
	var table: Array = S.expected()["walker"]["frames"]
	var keys: Array[String] = []
	for f: Dictionary in table:
		keys.append(f["key"])
	assert_eq(
		keys,
		[
			"flash/side/0",
			"idle/default/0", "idle/default/1", "idle/default/2",
			"walk/side/0", "walk/side/1", "walk/side/2",
			"walk/up/0", "walk/up/1",
		] as Array[String]
	)
	assert_eq(asset.animations[&"flash"][&"side"]["frames"], PackedInt32Array([0]))
	assert_eq(asset.animations[&"idle"][&"default"]["frames"], PackedInt32Array([1, 2, 3]))
	assert_eq(asset.animations[&"walk"][&"side"]["frames"], PackedInt32Array([4, 5, 6]))
	assert_eq(asset.animations[&"walk"][&"up"]["frames"], PackedInt32Array([7, 8]))


func test_durations_markers_events_and_root_motion_survive_unchanged() -> void:
	var asset := S.build(S.WALKER)
	var table: Array = S.expected()["walker"]["frames"]
	for i in table.size():
		var want: Dictionary = table[i]
		var key: String = want["key"]
		assert_eq(asset.frames[i]["duration_ms"], int(want["durationMs"]), "%s: duration" % key)
		var markers: Dictionary = want["markers"]
		assert_eq(asset.markers[i].size(), markers.size(), "%s: marker count" % key)
		for name: String in markers:
			assert_eq(
				asset.markers[i][StringName(name)],
				Vector2i(int(markers[name]["x"]), int(markers[name]["y"])),
				"%s: marker %s" % [key, name]
			)
		var events := PackedStringArray()
		for e: String in want["events"]:
			events.append(e)
		assert_eq(asset.events[i], events, "%s: events in authored order" % key)
		assert_eq(
			asset.root_motion[i],
			Vector2i(int(want["rootMotion"]["dx"]), int(want["rootMotion"]["dy"])),
			"%s: root motion" % key
		)
	# the file has more than one marker and event name, and an event pair in authored order
	assert_eq(asset.events[6], PackedStringArray(["step", "release"]))


func test_animation_table_has_loops_mirror_and_fallback() -> void:
	var asset := S.build(S.WALKER)
	var want: Dictionary = S.expected()["walker"]
	assert_eq(asset.origin, Vector2i(12, 23))
	assert_eq(asset.pixels_per_unit, 16.0)
	assert_eq(asset.canvas_size, Vector2i(24, 24))
	assert_eq(asset.skins, PackedStringArray(["base"]))
	assert_eq(asset.direction_fallback[&"down"], PackedStringArray(["down", "side"]))
	assert_eq(asset.direction_fallback[&"up"], PackedStringArray(["up", "side"]))
	for key: String in want["loops"]:
		var parts := key.split("/")
		assert_eq(
			asset.animations[StringName(parts[0])][StringName(parts[1])]["loop"],
			StringName(want["loops"][key]),
			"%s: loop" % key
		)
		assert_false(asset.animations[StringName(parts[0])][StringName(parts[1])]["mirror"], "%s: not a mirror" % key)
	var left: Dictionary = asset.animations[&"walk"][&"left"]
	assert_true(left["mirror"], "walk/left is a mirror")
	assert_eq(left["frames"], asset.animations[&"walk"][&"side"]["frames"], "a mirror lists its source's frames")
	assert_eq(left["loop"], &"loop")
	assert_eq(asset.frames.size(), 9, "a mirror adds no frame entries")


func test_every_skin_uses_the_same_layout() -> void:
	var asset := S.build(S.SKINS, {"padding": 0})
	assert_eq(asset.skins, PackedStringArray(["base", "ghost", "swap"]))
	assert_eq(asset.atlases.size(), 3)
	var table: Array = S.expected()["skins"]["frames"]
	for i in table.size():
		var box := S.box_rect(table[i]["box"])
		assert_eq(asset.frames[i]["region"].size, box.size, "frame %d: trimmed size" % i)
		assert_eq(asset.frames[i]["offset_px"], box.position, "frame %d: trimmed offset" % i)
	for skin: StringName in asset.atlases:
		assert_eq(asset.atlases[skin].get_size(), asset.atlases[&"base"].get_size(), "%s: same atlas size" % skin)
	for skin: StringName in [&"ghost", &"swap"]:
		assert_ne(
			asset.atlases[&"base"].get_image().get_data(),
			asset.atlases[skin].get_image().get_data(),
			"%s really differs from base" % skin
		)
