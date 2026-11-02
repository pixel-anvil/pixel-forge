extends GutTest
## FR-GD-04: which animations and skins to include, trim on/off, padding.

const S := preload("res://tests/support/pxf_support.gd")


func _build(pxf: String, options: Dictionary, report: Dictionary = {}) -> PixelForgeAsset:
	var reader := S.Reader.new()
	assert_eq(reader.open(pxf), OK, reader.error_message)
	var asset := S.Asset.build(reader, options, report)
	reader.close()
	return asset


## Sorted names as Strings (StringName `<` is not alphabetical).
func _names(keys: Array) -> Array:
	var out: Array = []
	for k in keys:
		out.append(String(k))
	out.sort()
	return out


func _dirs(asset: PixelForgeAsset, group: StringName) -> Array:
	return _names((asset.animations[group] as Dictionary).keys())


func test_defaults_import_everything_trimmed_with_one_pixel_padding() -> void:
	var asset := _build(S.WALKER, {})
	assert_eq(_names(asset.animations.keys()), ["flash", "idle", "walk"])
	assert_eq(_dirs(asset, &"walk"), ["left", "side", "up"])
	assert_ne(asset.frames[4]["region"].size, asset.canvas_size, "trimmed by default")
	var atlas: Image = asset.atlases[&"base"].get_image()
	# padding 1: the region of the first packed frame is at least 1 pixel from the atlas edge
	var min_x := 9999
	var min_y := 9999
	for f: Dictionary in asset.frames:
		min_x = mini(min_x, f["region"].position.x)
		min_y = mini(min_y, f["region"].position.y)
	assert_eq(min_x, 1)
	assert_eq(min_y, 1)
	assert_gt(atlas.get_width(), 0)


func test_animations_option_filters_by_group() -> void:
	var asset := _build(S.WALKER, {"animations": "flash"})
	assert_eq(asset.animations.keys(), [&"flash"])
	assert_eq(asset.frames.size(), 1)
	assert_eq(asset.markers.size(), 1)
	assert_eq(asset.events.size(), 1)
	assert_eq(asset.root_motion.size(), 1)


func test_animations_option_takes_several_names_and_spaces() -> void:
	var asset := _build(S.WALKER, {"animations": " idle , flash/side "})
	assert_eq(_names(asset.animations.keys()), ["flash", "idle"])
	assert_eq(asset.frames.size(), 4)


func test_animations_option_accepts_an_array() -> void:
	var asset := _build(S.WALKER, {"animations": PackedStringArray(["idle"])})
	assert_eq(asset.animations.keys(), [&"idle"])


func test_a_group_filter_keeps_every_direction_and_mirror() -> void:
	var asset := _build(S.WALKER, {"animations": "walk"})
	assert_eq(_dirs(asset, &"walk"), ["left", "side", "up"])
	assert_eq(asset.frames.size(), 5)
	assert_eq(asset.frames[0]["duration_ms"], 80, "frame 0 is now walk/side/0")


func test_filtering_to_a_mirror_imports_its_source_too() -> void:
	var asset := _build(S.WALKER, {"animations": "walk/left"})
	assert_eq(_dirs(asset, &"walk"), ["left", "side"])
	assert_true(asset.animations[&"walk"][&"left"]["mirror"])
	assert_eq(asset.animations[&"walk"][&"left"]["frames"], asset.animations[&"walk"][&"side"]["frames"])
	assert_eq(asset.frames.size(), 3)


func test_filtering_to_a_source_does_not_add_its_mirror() -> void:
	var asset := _build(S.WALKER, {"animations": "walk/side"})
	assert_eq(_dirs(asset, &"walk"), ["side"])


func test_an_unknown_animation_warns_and_nothing_matching_is_an_error() -> void:
	var report: Dictionary = {}
	var asset := _build(S.WALKER, {"animations": "idle,nope"}, report)
	assert_not_null(asset)
	assert_eq((report["warnings"] as Array).size(), 1)
	assert_string_contains(report["warnings"][0], "nope")
	report = {}
	assert_null(_build(S.WALKER, {"animations": "nope"}, report))
	assert_eq((report["errors"] as Array).size(), 1)
	assert_string_contains(report["errors"][0], "no animation")


func test_the_filter_does_not_change_pixels() -> void:
	# The frames of a filtered import are still the PNGs of those frames.
	var asset := _build(S.WALKER, {"animations": "walk/up", "trim": false, "padding": 0})
	var png := S.zip_png(S.WALKER, "base", "walk/up/1.png")
	assert_eq(S.canvas_frame(asset, &"base", 1).get_data(), png.get_data())


func test_skins_option() -> void:
	var all := _build(S.SKINS, {})
	assert_eq(all.skins, PackedStringArray(["base", "ghost", "swap"]))
	var one := _build(S.SKINS, {"skins": "ghost"})
	assert_eq(one.skins, PackedStringArray(["base", "ghost"]))
	assert_eq(one.atlases.keys(), [&"base", &"ghost"])
	var base_only := _build(S.SKINS, {"skins": "base"})
	assert_eq(base_only.skins, PackedStringArray(["base"]))
	var two := _build(S.SKINS, {"skins": "swap, ghost"})
	assert_eq(two.skins, PackedStringArray(["base", "ghost", "swap"]), "file order, base first")


func test_an_unknown_skin_warns() -> void:
	var report: Dictionary = {}
	var asset := _build(S.SKINS, {"skins": "nope"}, report)
	assert_eq(asset.skins, PackedStringArray(["base"]))
	assert_eq((report["warnings"] as Array).size(), 1)


func test_trim_off_keeps_canvas_regions_and_untrimmed_atlas_is_larger() -> void:
	var trimmed := _build(S.WALKER, {"padding": 0})
	var raw := _build(S.WALKER, {"trim": false, "padding": 0})
	for f: Dictionary in raw.frames:
		assert_eq(f["region"].size, Vector2i(24, 24))
	var a := trimmed.atlases[&"base"].get_size()
	var b := raw.atlases[&"base"].get_size()
	assert_lt(a.x * a.y, b.x * b.y)


func test_padding_is_clamped() -> void:
	var asset := _build(S.WALKER, {"padding": 1000})
	var min_x := 9999
	for f: Dictionary in asset.frames:
		min_x = mini(min_x, f["region"].position.x)
	assert_eq(min_x, S.Asset.MAX_PADDING)
	asset = _build(S.WALKER, {"padding": -5})
	min_x = 9999
	for f: Dictionary in asset.frames:
		min_x = mini(min_x, f["region"].position.x)
	assert_eq(min_x, 0)


func test_unknown_options_are_ignored() -> void:
	assert_not_null(_build(S.WALKER, {"future_option": 3}))


func test_build_needs_an_open_reader() -> void:
	var report: Dictionary = {}
	var asset := S.Asset.build(S.Reader.new(), {}, report)
	assert_null(asset)
	assert_string_contains(report["errors"][0], "not open")
