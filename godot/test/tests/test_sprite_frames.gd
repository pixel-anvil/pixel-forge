extends GutTest
## `PixelForgeSpriteFrames` (FR-GD-06, E8.1): frame count, durations, loop, direction fallback,
## mirror, skin and the pixels behind every AtlasTexture.

const S := preload("res://tests/support/pxf_support.gd")
const SF := preload("res://addons/pixel_forge/pixel_forge_sprite_frames.gd")


# The ms a SpriteFrames animation shows frame `i` for.
func _ms(sf: SpriteFrames, anim: StringName, i: int) -> float:
	return sf.get_frame_duration(anim, i) * 1000.0 / sf.get_animation_speed(anim)


func test_one_animation_per_group_with_the_authored_frame_count() -> void:
	var asset := S.build(S.WALKER)
	var side := SF.build(asset, &"side")
	var names := Array(side.get_animation_names())
	names.sort()
	assert_eq(names, ["flash", "idle", "walk"], "idle is undirected, found through default")
	assert_eq(side.get_frame_count(&"walk"), asset.frame_count(&"walk", &"side"))
	assert_eq(side.get_frame_count(&"idle"), 3)
	assert_eq(side.get_frame_count(&"flash"), 1)


func test_durations_are_exact() -> void:
	var asset := S.build(S.WALKER)
	var side := SF.build(asset, &"side")
	# walk/side is 80, 120, 100 ms: gcd 20, so 50 fps and relative 4, 6, 5.
	assert_eq(side.get_animation_speed(&"walk"), 50.0)
	assert_eq(side.get_frame_duration(&"walk", 0), 4.0)
	assert_eq(side.get_frame_duration(&"walk", 1), 6.0)
	assert_eq(side.get_frame_duration(&"walk", 2), 5.0)
	# idle is 100, 50, 100 ms: gcd 50.
	assert_eq(side.get_animation_speed(&"idle"), 20.0)
	assert_eq(side.get_frame_duration(&"idle", 0), 2.0)
	assert_eq(side.get_frame_duration(&"idle", 1), 1.0)
	# one pass in ms equals the asset's
	for g: StringName in [&"walk", &"idle", &"flash"]:
		var total := 0.0
		for i in side.get_frame_count(g):
			total += _ms(side, g, i)
		assert_almost_eq(total, float(asset.duration_ms(g, &"side")), 0.001, "%s one pass" % g)


func test_loop_flag_follows_the_animation() -> void:
	var asset := S.build(S.WALKER)
	var side := SF.build(asset, &"side")
	assert_true(side.get_animation_loop(&"walk"), "loop")
	assert_false(side.get_animation_loop(&"idle"), "once")
	assert_false(side.get_animation_loop(&"flash"), "once")
	var up := SF.build(asset, &"up")
	assert_true(up.get_animation_loop(&"walk"), "pingpong plays forever")


func test_pingpong_lists_the_driver_sequence() -> void:
	var asset := S.build(S.WALKER)
	var up := SF.build(asset, &"up")
	var n := asset.frame_count(&"walk", &"up")
	assert_eq(up.get_frame_count(&"walk"), n if n <= 2 else 2 * n - 2)
	var indices: PackedInt32Array = asset.resolve(&"walk", &"up")["frames"]
	# first pass equals the authored frames
	for i in n:
		assert_eq(up.get_frame_texture(&"walk", i).region, Rect2(asset.frames[indices[i]]["region"]))
	# the walk/up fixture has 2 frames: no extra entries, both durations kept (60, 90)
	assert_eq(n, 2)
	assert_almost_eq(_ms(up, &"walk", 0), 60.0, 0.001)
	assert_almost_eq(_ms(up, &"walk", 1), 90.0, 0.001)


func test_direction_fallback_and_default() -> void:
	var asset := S.build(S.WALKER)
	# down is not authored; its fallback is [down, side]
	var down := SF.build(asset, &"down")
	assert_true(down.has_animation(&"walk"))
	assert_eq(down.get_frame_count(&"walk"), asset.frame_count(&"walk", &"down"))
	var side := SF.build(asset, &"side")
	assert_eq(down.get_frame_texture(&"walk", 0).region, side.get_frame_texture(&"walk", 0).region)
	# up has a fallback list, so the group without up or side (idle) still reaches default
	var up := SF.build(asset, &"up")
	assert_true(up.has_animation(&"idle"), "default is the last candidate")
	# a direction nobody has: only the undirected groups remain
	var nowhere := SF.build(asset, &"northwest")
	assert_false(nowhere.has_animation(&"walk"))
	assert_true(nowhere.has_animation(&"idle"))
	assert_false(nowhere.has_animation(&"flash"), "flash is authored for side only")
	# the directions list includes fallback keys that are not authored
	var dirs := SF.directions(asset)
	for d: StringName in [&"down", &"up", &"side", &"left", &"default"]:
		assert_true(dirs.has(d), str(d))
	var all := SF.build_all(asset)
	assert_eq(all.size(), dirs.size())
	assert_eq(all[&"down"].get_frame_count(&"walk"), down.get_frame_count(&"walk"))


func test_mirror_is_recorded_and_uses_the_source_frames() -> void:
	var asset := S.build(S.WALKER)
	var left := SF.build(asset, &"left")
	var side := SF.build(asset, &"side")
	assert_true(SF.is_mirrored(left, &"walk"), "walk/left mirrors side")
	assert_false(SF.is_mirrored(side, &"walk"))
	assert_false(SF.is_mirrored(left, &"nothing"))
	assert_false(SF.is_mirrored(SpriteFrames.new(), &"default"), "a foreign SpriteFrames")
	assert_eq(left.get_frame_count(&"walk"), side.get_frame_count(&"walk"))
	assert_eq(left.get_frame_texture(&"walk", 1).region, side.get_frame_texture(&"walk", 1).region)
	assert_eq(left.get_meta(SF.META_DIRECTION), &"left")


func test_atlas_textures_rebuild_the_canvas_frame() -> void:
	# Margin + region must put the pixels where the PNG has them (trim on and off).
	for trim in [true, false]:
		var asset := S.build(S.WALKER, {"trim": trim})
		var side := SF.build(asset, &"side")
		var indices: PackedInt32Array = asset.resolve(&"walk", &"side")["frames"]
		for k in indices.size():
			var tex := side.get_frame_texture(&"walk", k)
			assert_true(tex is AtlasTexture)
			assert_eq(tex.get_size(), Vector2(asset.canvas_size), "canvas sized (trim %s)" % trim)
			var drawn := Image.create_empty(
				asset.canvas_size.x, asset.canvas_size.y, false, Image.FORMAT_RGBA8
			)
			var at := tex as AtlasTexture
			var pos := Vector2i(at.margin.position)
			drawn.blit_rect(at.atlas.get_image(), Rect2i(at.region), pos)
			assert_eq(
				drawn.get_data(), S.canvas_frame(asset, &"base", indices[k]).get_data(), "frame %d" % k
			)


func test_skin_picks_that_skins_atlas() -> void:
	var asset := S.build(S.SKINS)
	var base := SF.build(asset, &"side")
	var swap := SF.build(asset, &"side", &"swap")
	assert_not_null(swap)
	var group: StringName = base.get_animation_names()[0]
	assert_eq(base.get_frame_texture(group, 0).atlas, asset.atlases[&"base"])
	assert_eq(swap.get_frame_texture(group, 0).atlas, asset.atlases[&"swap"])
	assert_eq(swap.get_frame_texture(group, 0).region, base.get_frame_texture(group, 0).region)
	assert_eq(swap.get_meta(SF.META_SKIN), &"swap")


func test_unknown_skin_is_an_error() -> void:
	var asset := S.build(S.WALKER)
	var report: Dictionary = {}
	assert_null(SF.build(asset, &"side", &"ghost", report))
	assert_eq((report["errors"] as Array).size(), 1)
	assert_true(SF.build_all(asset, &"ghost").is_empty())
