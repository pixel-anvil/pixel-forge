extends GutTest
## Adapters (contract section 8): Sprite2D, Sprite3D and the duck-typed adapter on a fake node with
## the lit billboard's properties. The oracle for the picture is independent of the addon: a frame
## is "rendered" by placing every pixel of the node's region the way Godot draws it (centred, y per
## the node, `flip_h` flipping the texture inside the same rectangle, `offset` not mirrored) and the
## result is compared with the canvas frame decoded from the .pxf by a plain ZIPReader, mirrored
## about the origin pixel (FR-RIG-16, `x' = 2*ox - x`).

const S := preload("res://tests/support/pxf_support.gd")
const DS := preload("res://tests/support/driver_support.gd")
const Billboard := preload("res://tests/support/fake_billboard.gd")
const PlainSprite := preload("res://tests/support/fake_plain_sprite.gd")

var walker: PixelForgeAsset
var authored: Array[Dictionary]
var driver: PixelForgeDriver


func before_all() -> void:
	walker = S.build(S.WALKER)  # trim on: the regions are cropped and differ in size
	authored = S.authored_frames(S.zip_index(S.WALKER))


func before_each() -> void:
	driver = DS.make_driver(walker)
	add_child_autofree(driver)


# --- the picture oracle -------------------------------------------------------------------------


## The opaque pixels of what a node draws, keyed by the centre of each cell relative to the origin
## point, y down, in pixels. `y_up`: the node's `offset` has +y up.
func _drawn(node: Object, y_up: bool) -> Dictionary:
	var tex: Texture2D = node.get("texture")
	var atlas := tex.get_image()
	var region: Rect2i = Rect2i(node.get("region_rect"))
	var off: Vector2 = node.get("offset")
	var flip: bool = node.get("flip_h")
	var out := {}
	for j in region.size.y:
		for i in region.size.x:
			var col := atlas.get_pixel(region.position.x + i, region.position.y + j)
			if col.a == 0.0:
				continue
			var shown_i := region.size.x - 1 - i if flip else i
			var x := off.x + shown_i + 0.5 - region.size.x / 2.0
			# y down: the cell centre is off.y + j + 0.5 - h/2; y up: mirrored about the node's centre
			var y := off.y + j + 0.5 - region.size.y / 2.0
			if y_up:
				y = -(off.y + region.size.y / 2.0 - j - 0.5)
			out[Vector2(x, y)] = col
	return out


## The canvas frame (an independent decode) with every opaque pixel placed relative to the origin
## point; `flip` mirrors x about the origin pixel.
func _expected(frame_index: int, flip: bool) -> Dictionary:
	var img := S.zip_png(S.WALKER, "base", authored[frame_index]["image"])
	var s := -1.0 if flip else 1.0
	var out := {}
	for y in img.get_height():
		for x in img.get_width():
			var col := img.get_pixel(x, y)
			if col.a != 0.0:
				out[Vector2(s * (x - walker.origin.x), y - walker.origin.y - 0.5)] = col
	return out


func _assert_same_picture(got: Dictionary, want: Dictionary, label: String) -> void:
	assert_eq(got.size(), want.size(), "%s: pixel count" % label)
	var wrong := 0
	for k: Vector2 in want:
		if not got.has(k) or not got[k].is_equal_approx(want[k]):
			wrong += 1
	assert_eq(wrong, 0, "%s: pixels placed or coloured differently" % label)


## Plays walk/<dir> frame by frame on `node` and checks each frame against the oracle, for the given
## requested mirror.
func _check_frames(node: Node, y_up: bool, direction: StringName, mirror: bool, flipped: bool) -> void:
	driver.target = node
	driver.mirror = mirror
	driver.play(&"walk", direction)
	var n := driver.asset.frame_count(&"walk", direction)
	for i in n:
		driver.set_frame(i, false)
		var label := "walk/%s frame %d mirror=%s" % [direction, i, mirror]
		assert_eq(node.get("flip_h"), flipped, label + ": flip_h")
		_assert_same_picture(_drawn(node, y_up), _expected(driver.frame_index, flipped), label)


func test_the_fixture_frames_are_trimmed_and_asymmetric() -> void:
	var sizes := {}
	for i: int in walker.animations[&"walk"][&"side"]["frames"]:
		sizes[walker.frames[i]["region"].size] = true
	assert_gt(sizes.size(), 1, "regions differ in size")
	assert_lt(walker.frames[4]["region"].size.x, walker.canvas_size.x)


func test_sprite2d_unmirrored_and_mirrored() -> void:
	var node := Sprite2D.new()
	add_child_autofree(node)
	_check_frames(node, false, &"side", false, false)
	_check_frames(node, false, &"side", true, true)


func test_sprite2d_mirror_entry_and_xor() -> void:
	var node := Sprite2D.new()
	add_child_autofree(node)
	_check_frames(node, false, &"left", false, true)  # mirrorOf side: flipped by the entry
	_check_frames(node, false, &"left", true, false)  # mirror XOR mirrorOf = false


func test_sprite3d_unmirrored_and_mirrored() -> void:
	var node := Sprite3D.new()
	add_child_autofree(node)
	_check_frames(node, true, &"side", false, false)
	_check_frames(node, true, &"side", true, true)
	_check_frames(node, true, &"left", false, true)


func test_duck_typed_billboard_unmirrored_and_mirrored() -> void:
	var node := Billboard.new()
	add_child_autofree(node)
	_check_frames(node, true, &"side", false, false)
	_check_frames(node, true, &"side", true, true)
	_check_frames(node, true, &"left", false, true)
	_check_frames(node, true, &"left", true, false)


func test_duck_typed_with_a_y_down_offset() -> void:
	var node := PlainSprite.new()
	add_child_autofree(node)
	driver.target = node
	driver.adapter.offset_y_up = false
	_check_frames(node, false, &"side", true, true)


func test_the_pixel_flip_of_the_trimmed_frame_matches_the_mirrored_render_exactly() -> void:
	# one explicit number: walk/side frame 1 (global 5) is a 9x... box; the mirrored offset has the
	# opposite sign and the region is unchanged
	var node := Sprite2D.new()
	add_child_autofree(node)
	driver.target = node
	driver.play(&"walk", &"side")
	driver.set_frame(1, false)
	var plain: Vector2 = node.offset
	var region: Rect2 = node.region_rect
	driver.mirror = true
	assert_eq(node.offset, Vector2(-plain.x, plain.y))
	assert_eq(node.region_rect, region, "the region never changes with the flip")
	assert_true(node.flip_h)


# --- node settings ------------------------------------------------------------------------------


func test_sprite2d_settings_and_texture() -> void:
	var node := Sprite2D.new()
	add_child_autofree(node)
	driver.target = node
	driver.play(&"walk", &"side")
	assert_true(driver.adapter is PixelForgeSprite2DAdapter)
	assert_true(node.region_enabled)
	assert_true(node.centered)
	assert_eq(node.texture, walker.atlases[&"base"])
	assert_eq(node.region_rect, Rect2(walker.frames[driver.frame_index]["region"]))


func test_sprite3d_settings_and_pixel_size() -> void:
	var node := Sprite3D.new()
	add_child_autofree(node)
	driver.target = node
	driver.play(&"walk", &"side")
	assert_true(driver.adapter is PixelForgeSprite3DAdapter)
	assert_true(node.region_enabled)
	assert_true(node.centered)
	assert_eq(node.pixel_size, 1.0 / 16.0)


func test_skin_change_swaps_the_texture() -> void:
	var asset := DS.make_asset()
	var d := DS.make_driver(asset)
	add_child_autofree(d)
	var node := Sprite2D.new()
	add_child_autofree(node)
	d.target = node
	d.play(&"lin")
	assert_eq(node.texture, asset.atlases[&"base"])
	d.skin = &"alt"
	assert_eq(node.texture, asset.atlases[&"alt"])
	d.skin = &"missing"
	assert_eq(node.texture, asset.atlases[&"base"], "an unknown skin falls back to base")


func test_the_adapter_is_chosen_by_node_type_and_kept_when_custom() -> void:
	var a := Sprite2D.new()
	var b := Sprite3D.new()
	var c := Billboard.new()
	for n: Node in [a, b, c]:
		add_child_autofree(n)
	driver.target = a
	assert_true(driver.adapter is PixelForgeSprite2DAdapter)
	driver.target = b
	assert_true(driver.adapter is PixelForgeSprite3DAdapter)
	driver.target = c
	assert_eq(driver.adapter.get_script(), PixelForgeAdapter)
	var mine := PixelForgeAdapter.new()
	driver.adapter = mine
	driver.target = a
	assert_eq(driver.adapter, mine, "a custom adapter is kept when the target changes")
	driver.target = null
	driver.play(&"walk", &"side")  # no target: nothing to apply, no error
	assert_eq(driver.frame, 0)


func test_a_freed_target_is_ignored() -> void:
	var node := Sprite2D.new()
	driver.target = node
	driver.play(&"walk", &"side")
	node.free()
	driver.advance(1.0)
	driver.mirror = true
	assert_eq(driver.group, &"walk")


# --- the lit billboard, duck-typed (contract section 8.3) -----------------------------------------


func _synthetic_untrimmed() -> PixelForgeAsset:
	# canvas 64x64, origin (32, 55), one untrimmed frame and one trimmed 20x30 region at (22, 26)
	var a := PixelForgeAsset.new()
	a.origin = Vector2i(32, 55)
	a.pixels_per_unit = 16.0
	a.canvas_size = Vector2i(64, 64)
	var img := Image.create_empty(128, 64, false, Image.FORMAT_RGBA8)
	a.atlases = {&"base": ImageTexture.create_from_image(img)}
	a.frames.append({"region": Rect2i(0, 0, 64, 64), "offset_px": Vector2i.ZERO, "duration_ms": 100})
	a.frames.append({"region": Rect2i(64, 0, 20, 30), "offset_px": Vector2i(22, 26), "duration_ms": 100})
	for i in 2:
		a.markers.append({})
		a.events.append(PackedStringArray())
		a.root_motion.append(Vector2i.ZERO)
	a.animations = {&"w": {&"default": {"frames": PackedInt32Array([0, 1]), "loop": &"loop", "mirror": false}}}
	return a


func test_billboard_worked_example() -> void:
	var d := DS.make_driver(_synthetic_untrimmed())
	add_child_autofree(d)
	var bb := Billboard.new()
	add_child_autofree(bb)
	d.target = bb
	d.play(&"w")
	assert_eq(bb.offset, Vector2(-0.5, 24.0), "c = (-0.5, -24), +y up")
	assert_eq(bb.region_rect, Rect2(0, 0, 64, 64))
	assert_eq(bb.pixel_size, 1.0 / 16.0)
	assert_false(bb.flip_h)
	d.mirror = true
	assert_eq(bb.offset, Vector2(0.5, 24.0))
	assert_true(bb.flip_h)
	d.mirror = false
	d.set_frame(1)
	assert_eq(bb.offset, Vector2(-0.5, 15.0), "trimmed 20x30 at (22, 26): c = (-0.5, -15)")
	assert_eq(bb.region_rect, Rect2(64, 0, 20, 30))


func test_billboard_gets_only_changed_properties_in_order() -> void:
	var d := DS.make_driver(_synthetic_untrimmed())
	add_child_autofree(d)
	var bb := Billboard.new()
	add_child_autofree(bb)
	d.target = bb
	d.play(&"w")
	# first frame: pixel_size, texture, region_rect, offset (flip_h is already false)
	assert_eq(bb.take_calls(), ["pixel_size", "texture", "region_rect", "offset"] as Array[String])
	d.mirror = true  # only the offset x and flip_h change
	assert_eq(bb.take_calls(), ["offset", "flip_h"] as Array[String])
	d.mirror = true
	assert_eq(bb.take_calls(), [] as Array[String], "re-applying the same frame assigns nothing")
	d.mirror = false
	bb.take_calls()
	d.set_frame(1)  # another region and offset; flip_h is unchanged
	assert_eq(bb.take_calls(), ["region_rect", "offset"] as Array[String])


func test_billboard_order_when_texture_region_offset_and_flip_all_change() -> void:
	var asset := _synthetic_untrimmed()
	var other := ImageTexture.create_from_image(Image.create_empty(8, 8, false, Image.FORMAT_RGBA8))
	var d := DS.make_driver(asset)
	add_child_autofree(d)
	var bb := Billboard.new()
	add_child_autofree(bb)
	d.target = bb
	d.play(&"w")
	bb.take_calls()
	d.adapter.apply(other, Rect2i(1, 2, 3, 4), Vector2(5, 6), true)
	assert_eq(bb.take_calls(), ["texture", "region_rect", "offset", "flip_h"] as Array[String])
	assert_eq(bb.offset, Vector2(5, -6), "+y of the contract is down, the billboard's is up")


func test_apply_pixel_size_false_leaves_pixel_size_alone() -> void:
	var d := DS.make_driver(_synthetic_untrimmed())
	add_child_autofree(d)
	var bb := Billboard.new()
	add_child_autofree(bb)
	d.target = bb
	d.adapter.apply_pixel_size = false
	d.play(&"w")
	assert_eq(bb.pixel_size, 0.01, "untouched")
	assert_false(bb.take_calls().has("pixel_size"))


func test_a_duck_without_pixel_size_is_fine() -> void:
	var d := DS.make_driver(_synthetic_untrimmed())
	add_child_autofree(d)
	var node := PlainSprite.new()
	add_child_autofree(node)
	d.target = node
	d.adapter.offset_y_up = false
	d.play(&"w")
	assert_eq(node.offset, Vector2(-0.5, -24.0), "y down: c as is")
	assert_eq(node.region_rect, Rect2(0, 0, 64, 64))
	d.adapter.offset_y_up = true
	d.mirror = true
	assert_eq(node.offset, Vector2(0.5, 24.0))


# --- T6.0 doubt: does flip_h mirror `offset`? -----------------------------------------------------


## Godot 4.6.1 flips the texture inside the same rectangle and leaves `offset` alone, for both nodes.
## This was also checked by rendering (a SubViewport read back on a real display: with offset (4, 0)
## and flip_h the opaque span stayed at the same pixels and the texture's red edge moved to the other
## side). If this test ever fails, a Godot upgrade changed that: set `_flip_mirrors_offset()` to true
## in the affected adapter.
func test_flip_h_leaves_offset_unmirrored() -> void:
	var img := Image.create_empty(32, 32, false, Image.FORMAT_RGBA8)
	img.fill(Color.RED)
	var tex := ImageTexture.create_from_image(img)
	var s2 := Sprite2D.new()
	s2.texture = tex
	s2.region_enabled = true
	s2.region_rect = Rect2(4, 4, 10, 6)
	s2.offset = Vector2(3, 2)
	var before := s2.get_rect()
	s2.flip_h = true
	assert_eq(s2.get_rect(), before, "Sprite2D: the drawn rectangle does not move with flip_h")
	assert_eq(before, Rect2(-2, -1, 10, 6), "centred region plus offset, not mirrored")
	var s3 := Sprite3D.new()
	s3.texture = tex
	s3.region_enabled = true
	s3.region_rect = Rect2(4, 4, 10, 6)
	s3.offset = Vector2(3, 2)
	before = s3.get_item_rect()
	s3.flip_h = true
	assert_eq(s3.get_item_rect(), before, "Sprite3D: likewise")
	assert_false(PixelForgeAdapter.new()._flip_mirrors_offset())
	s2.free()
	s3.free()
